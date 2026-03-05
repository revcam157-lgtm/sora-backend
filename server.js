const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8080;
const SORA_COOKIES_ENV = process.env.SORA_COOKIES || '';
const SORA_AUTH_TOKEN = process.env.SORA_AUTH_TOKEN || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function parseCookies(cookieStr) {
  return cookieStr.split(';').map(c => {
    const [name, ...rest] = c.trim().split('=');
    return {
      name: name.trim(),
      value: rest.join('=').trim(),
      domain: 'sora.chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'Lax',
    };
  }).filter(c => c.name && c.value);
}

function extractId(url) {
  const m = url.match(/\/p\/(s_[a-f0-9]+)/i) || url.match(/\/g\/(gen_[a-z0-9]+)/i);
  return m ? m[1] : null;
}

function extractMp4FromAny(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  // Busca qualquer URL de vídeo
  const patterns = [
    /"(https?:\/\/[^"]+\.mp4[^"]*)"/,
    /"video_url"\s*:\s*"([^"]+)"/,
    /"source_url"\s*:\s*"([^"]+)"/,
    /"download_url"\s*:\s*"([^"]+)"/,
    /"url"\s*:\s*"(https?:\/\/[^"]+(?:mp4|video)[^"]*)"/,
  ];
  for (const p of patterns) {
    const m = str.match(p);
    if (m) {
      const url = m[1].replace(/\\\//g, '/').replace(/\\u002F/g, '/');
      if (url.startsWith('http')) return url;
    }
  }
  return null;
}

app.get('/', (req, res) => res.json({
  status: '✅ online',
  auth: !!SORA_AUTH_TOKEN,
  cookies: !!SORA_COOKIES_ENV
}));

app.post('/process', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'URL inválido.' });

  const videoId = extractId(url);
  if (!videoId) return res.status(400).json({ error: 'ID do vídeo não encontrado.' });

  console.log('🎬 Buscando:', videoId);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--window-size=1280,720']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    if (SORA_COOKIES_ENV) {
      await context.addCookies(parseCookies(SORA_COOKIES_ENV));
      console.log('🍪 Cookies injetados');
    }

    // Injeta Bearer em requisições ao sora
    await context.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.includes('sora.chatgpt.com') || reqUrl.includes('openai.com')) {
        const headers = { ...route.request().headers() };
        if (SORA_AUTH_TOKEN) headers['authorization'] = `Bearer ${SORA_AUTH_TOKEN}`;
        await route.continue({ headers });
      } else {
        await route.continue();
      }
    });

    let mp4Url = null;
    const allResponses = [];

    // Intercepta TODAS as respostas JSON
    context.on('response', async (response) => {
      const respUrl = response.url();
      const ct = response.headers()['content-type'] || '';
      const status = response.status();

      if (ct.includes('json') || respUrl.includes('backend')) {
        try {
          const text = await response.text();
          allResponses.push(`[${status}] ${respUrl}\n    => ${text.substring(0, 400)}`);
          console.log(`📡 [${status}] ${respUrl}`);
          console.log(`   => ${text.substring(0, 300)}`);

          if (!mp4Url) {
            mp4Url = extractMp4FromAny(text);
            if (mp4Url) console.log('✅ MP4 encontrado!', mp4Url.substring(0, 80));
          }
        } catch(e) {}
      }
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    console.log('🌐 Navegando para:', url);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch(e) {
      console.log('⚠️ timeout no goto, continuando...');
    }

    // Aguarda mais para carregar
    await page.waitForTimeout(8000);

    // Verifica se está logado
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const loggedIn = !bodyText.includes('Log in') && !bodyText.includes('Sign in') && bodyText.length > 100;
    console.log('👤 Logado:', loggedIn);
    console.log('📊 Total respostas capturadas:', allResponses.length);

    // Tenta chamar diretamente os endpoints conhecidos do Sora
    if (!mp4Url) {
      console.log('🔍 Tentando endpoints diretos...');

      const endpoints = [
        `/backend-api/video/generation/${videoId}`,
        `/backend/video/generation/${videoId}`,
        `/backend-api/generations/${videoId}`,
        `/backend/generations/${videoId}`,
        `/backend-api/videos/${videoId}`,
        `/api/video/${videoId}`,
      ];

      for (const endpoint of endpoints) {
        const result = await page.evaluate(async (params) => {
          try {
            const r = await fetch(params.endpoint, {
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${params.token}`
              }
            });
            return { status: r.status, text: await r.text() };
          } catch(e) { return { error: e.message }; }
        }, { endpoint, token: SORA_AUTH_TOKEN });

        console.log(`  ${endpoint} => [${result.status}] ${(result.text||'').substring(0, 200)}`);

        if (result.status === 200 && result.text) {
          const found = extractMp4FromAny(result.text);
          if (found) {
            mp4Url = found;
            console.log('✅ MP4 via endpoint direto!');
            break;
          }
        }
      }
    }

    await browser.close();

    if (!mp4Url) {
      return res.status(500).json({
        error: 'MP4 não encontrado.',
        logged_in: loggedIn,
        api_responses: allResponses.length,
        debug: allResponses.slice(0, 3)
      });
    }

    res.json({ downloadUrl: mp4Url });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

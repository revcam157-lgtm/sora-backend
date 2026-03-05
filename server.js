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

function extractMp4FromJson(json) {
  const str = JSON.stringify(json);
  const candidates = [
    json?.download_links?.mp4_source,
    json?.download_links?.mp4,
    json?.video_url,
    json?.source_url,
    json?.url,
    json?.data?.video_url,
    json?.data?.download_links?.mp4_source,
    json?.data?.download_links?.mp4,
    json?.generations?.[0]?.video_url,
    json?.generation?.video_url,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.startsWith('http')) return c;
  }
  const match = str.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
  if (match) return match[1].replace(/\\\//g, '/');
  return null;
}

app.get('/', (req, res) => res.json({
  status: '✅ Sora Downloader online',
  auth: SORA_AUTH_TOKEN ? 'configurado' : 'não configurado',
  cookies: SORA_COOKIES_ENV ? 'configurado' : 'não configurado'
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
    }

    // Injeta Bearer em todas requisições API
    await context.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.includes('sora.chatgpt.com') || reqUrl.includes('openai.com')) {
        const headers = {
          ...route.request().headers(),
          'authorization': `Bearer ${SORA_AUTH_TOKEN}`,
        };
        await route.continue({ headers });
      } else {
        await route.continue();
      }
    });

    let mp4Url = null;
    const allApiCalls = [];

    // Loga TODAS as chamadas de API para descobrir o endpoint correto
    context.on('response', async (response) => {
      const respUrl = response.url();
      const status = response.status();
      const contentType = response.headers()['content-type'] || '';

      if (respUrl.includes('sora.chatgpt.com') && contentType.includes('application/json')) {
        try {
          const json = await response.json();
          const preview = JSON.stringify(json).substring(0, 200);
          allApiCalls.push(`[${status}] ${respUrl} => ${preview}`);
          console.log(`📡 API: [${status}] ${respUrl}`);
          console.log(`   Data: ${preview}`);

          const found = extractMp4FromJson(json);
          if (found && !mp4Url) {
            mp4Url = found;
            console.log('✅ MP4 encontrado!', mp4Url.substring(0, 80));
          }
        } catch(e) {}
      }
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    console.log('🌐 Abrindo página...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 40000 });
    await page.waitForTimeout(6000);

    console.log(`📊 Total API calls capturadas: ${allApiCalls.length}`);

    await browser.close();

    if (!mp4Url) {
      return res.status(500).json({
        error: 'MP4 não encontrado.',
        api_calls_found: allApiCalls.length,
        calls: allApiCalls.slice(0, 5)
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

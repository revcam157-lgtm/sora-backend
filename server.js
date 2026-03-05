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
      console.log('🍪 Cookies injetados');
    }

    // Injeta Bearer token em todas as requisições
    if (SORA_AUTH_TOKEN) {
      await context.route('**/*', async (route) => {
        const headers = {
          ...route.request().headers(),
          'authorization': `Bearer ${SORA_AUTH_TOKEN}`,
        };
        await route.continue({ headers });
      });
      console.log('🔑 Bearer token injetado');
    }

    let mp4Url = null;

    context.on('response', async (response) => {
      const respUrl = response.url();
      if (respUrl.includes('/backend-api/') && !mp4Url) {
        try {
          const json = await response.json();
          const found = extractMp4FromJson(json);
          if (found) {
            mp4Url = found;
            console.log('✅ MP4 interceptado via network');
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
    await page.waitForTimeout(4000);

    // Tenta fetch direto com Bearer token
    if (!mp4Url) {
      console.log('🔍 Tentando fetch direto...');
      const result = await page.evaluate(async (params) => {
        try {
          const r = await fetch(`/backend-api/video/generation/${params.id}`, {
            credentials: 'include',
            headers: {
              'Accept': 'application/json',
              'Authorization': `Bearer ${params.token}`
            }
          });
          const text = await r.text();
          console.log('Status:', r.status, 'Response:', text.substring(0, 200));
          return { status: r.status, text };
        } catch(e) {
          return { error: e.message };
        }
      }, { id: videoId, token: SORA_AUTH_TOKEN });

      console.log('Fetch result:', JSON.stringify(result).substring(0, 300));

      if (result?.text) {
        try {
          const json = JSON.parse(result.text);
          mp4Url = extractMp4FromJson(json);
        } catch(e) {}
      }
    }

    await browser.close();

    if (!mp4Url) {
      return res.status(500).json({ error: 'Não foi possível extrair o vídeo. Token pode ter expirado.' });
    }

    res.json({ downloadUrl: mp4Url });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

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

// Parser inteligente de cookies — lida com valores que contêm "="
function parseCookies(cookieStr) {
  const cookies = [];
  // Split apenas por "; " (ponto e vírgula + espaço) para não quebrar valores base64
  const parts = cookieStr.split(/;\s+/);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.substring(0, idx).trim();
    const value = part.substring(idx + 1).trim();
    if (!name || !value) continue;

    // Adiciona para ambos os domínios
    for (const domain of ['sora.chatgpt.com', '.chatgpt.com']) {
      cookies.push({
        name, value, domain,
        path: '/',
        secure: true,
        httpOnly: name.includes('session') || name.includes('auth'),
        sameSite: 'Lax',
      });
    }
  }
  return cookies;
}

function extractId(url) {
  const m = url.match(/\/p\/(s_[a-f0-9]+)/i) || url.match(/\/g\/(gen_[a-z0-9]+)/i);
  return m ? m[1] : null;
}

function extractMp4FromText(text, videoId) {
  // Ignora URLs que não têm relação com o vídeo solicitado
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  
  // Procura por URLs que contenham o ID do vídeo ou CDN de vídeos gerados
  const patterns = [
    new RegExp(`"(https?://[^"]*${videoId}[^"]*)"`, 'i'),
    /"(https?:\/\/(?:cdn|video|videos|storage)[^"]+\.mp4[^"]*)"/i,
    /"video_url"\s*:\s*"([^"]+)"/i,
    /"source_url"\s*:\s*"([^"]+)"/i,
    /"download_url"\s*:\s*"([^"]+)"/i,
  ];

  for (const p of patterns) {
    const m = str.match(p);
    if (m) {
      const url = m[1].replace(/\\\//g, '/').replace(/\\u002F/g, '/');
      // Ignora o vídeo de tutorial da OpenAI
      if (url.startsWith('http') && !url.includes('nux.') && !url.includes('deep-research')) {
        return url;
      }
    }
  }
  return null;
}

app.get('/', (req, res) => res.json({
  status: '✅ online',
  auth: !!SORA_AUTH_TOKEN,
  cookies: !!SORA_COOKIES_ENV,
  cookies_count: SORA_COOKIES_ENV ? parseCookies(SORA_COOKIES_ENV).length : 0
}));

app.post('/process', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'URL inválido.' });

  const videoId = extractId(url);
  if (!videoId) return res.status(400).json({ error: 'ID não encontrado.' });

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
      const cookies = parseCookies(SORA_COOKIES_ENV);
      await context.addCookies(cookies);
      console.log(`🍪 ${cookies.length} cookies injetados`);
      // Log dos nomes dos cookies para debug
      console.log('Cookies:', cookies.map(c => c.name).join(', '));
    }

    // Injeta Bearer em requisições ao sora
    if (SORA_AUTH_TOKEN) {
      await context.route('**/*', async (route) => {
        const reqUrl = route.request().url();
        if (reqUrl.includes('sora.chatgpt.com') || reqUrl.includes('openai.com')) {
          const headers = { ...route.request().headers(), 'authorization': `Bearer ${SORA_AUTH_TOKEN}` };
          await route.continue({ headers });
        } else {
          await route.continue();
        }
      });
      console.log('🔑 Bearer injetado');
    }

    let mp4Url = null;

    context.on('response', async (response) => {
      const respUrl = response.url();
      const ct = response.headers()['content-type'] || '';
      const status = response.status();

      if ((ct.includes('json') || respUrl.includes('backend') || respUrl.includes('sora.chatgpt')) && !respUrl.includes('ab.chatgpt')) {
        try {
          const text = await response.text();
          console.log(`📡 [${status}] ${respUrl}`);
          console.log(`   => ${text.substring(0, 400)}`);

          if (!mp4Url) {
            const found = extractMp4FromText(text, videoId);
            if (found) {
              mp4Url = found;
              console.log('✅ MP4 correto encontrado!', mp4Url.substring(0, 100));
            }
          }
        } catch(e) {}
      }
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    console.log('🌐 Navegando...');
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch(e) {
      console.log('⚠️ timeout, continuando...');
    }
    await page.waitForTimeout(8000);

    // Verifica autenticação
    const authCheck = await page.evaluate(async (token) => {
      try {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        return await r.text();
      } catch(e) { return e.message; }
    }, SORA_AUTH_TOKEN);
    console.log('🔐 Auth session:', authCheck.substring(0, 200));

    // Tenta endpoints diretos se ainda não achou
    if (!mp4Url) {
      console.log('🔍 Tentando endpoints diretos...');
      const endpoints = [
        `/backend/generations/${videoId}`,
        `/backend-api/video/generation/${videoId}`,
        `/backend/video/${videoId}`,
        `/backend/videos/${videoId}`,
      ];

      for (const ep of endpoints) {
        const r = await page.evaluate(async (params) => {
          try {
            const resp = await fetch(params.ep, {
              credentials: 'include',
              headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${params.token}` }
            });
            return { status: resp.status, text: await resp.text() };
          } catch(e) { return { error: e.message }; }
        }, { ep, token: SORA_AUTH_TOKEN });

        console.log(`  ${ep} [${r.status}]: ${(r.text||'').substring(0, 200)}`);

        if (r.status === 200 && r.text) {
          const found = extractMp4FromText(r.text, videoId);
          if (found) { mp4Url = found; break; }
        }
      }
    }

    await browser.close();

    if (!mp4Url) {
      return res.status(500).json({ error: 'Não foi possível extrair o vídeo. Verifique os cookies.' });
    }

    res.json({ downloadUrl: mp4Url });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

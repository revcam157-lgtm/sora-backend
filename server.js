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

// Parser robusto — divide apenas no primeiro "=" de cada cookie
function parseCookies(cookieStr) {
  const cookies = [];
  // Divide por ";" mas só quando seguido de nome de cookie (letra ou "_")
  const parts = cookieStr.split(/;\s*(?=[a-zA-Z_])/);
  
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const name = part.substring(0, eqIdx).trim();
    const value = part.substring(eqIdx + 1).trim();
    if (!name || !value) continue;

    cookies.push({
      name, value,
      domain: 'sora.chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

function extractId(url) {
  const m = url.match(/\/p\/(s_[a-f0-9]+)/i) || url.match(/\/g\/(gen_[a-z0-9]+)/i);
  return m ? m[1] : null;
}

function extractMp4(text, videoId) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  const patterns = [
    /"video_url"\s*:\s*"([^"]+)"/i,
    /"source_url"\s*:\s*"([^"]+)"/i,
    /"download_url"\s*:\s*"([^"]+)"/i,
    /"(https?:\/\/(?:cdn|videos?|storage|files)[^"]+\.mp4[^"]*)"/i,
    /"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
  ];
  for (const p of patterns) {
    const m = str.match(p);
    if (m) {
      const u = m[1].replace(/\\\//g, '/');
      if (u.startsWith('http') && !u.includes('nux.') && !u.includes('deep-research')) return u;
    }
  }
  return null;
}

app.get('/', (req, res) => {
  const cookies = parseCookies(SORA_COOKIES_ENV);
  const hasSession = cookies.some(c => c.name.includes('session-token'));
  res.json({
    status: '✅ online',
    auth_token: !!SORA_AUTH_TOKEN,
    cookies_count: cookies.length,
    cookie_names: cookies.map(c => c.name),
    has_session_token: hasSession
  });
});

app.post('/process', async (req, res) => {
  const { url } = req.body;
  if (!url?.startsWith('http')) return res.status(400).json({ error: 'URL inválido.' });

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

    const cookies = parseCookies(SORA_COOKIES_ENV);
    await context.addCookies(cookies);
    console.log(`🍪 ${cookies.length} cookies:`, cookies.map(c => c.name).join(', '));

    if (SORA_AUTH_TOKEN) {
      await context.route('**/*', async (route) => {
        const u = route.request().url();
        if (u.includes('sora.chatgpt.com') || u.includes('openai.com')) {
          await route.continue({ headers: { ...route.request().headers(), 'authorization': `Bearer ${SORA_AUTH_TOKEN}` } });
        } else {
          await route.continue();
        }
      });
    }

    let mp4Url = null;

    context.on('response', async (response) => {
      const u = response.url();
      const ct = response.headers()['content-type'] || '';
      if ((ct.includes('json') || u.includes('backend')) && !u.includes('cdn-cgi') && !u.includes('ab.chatgpt')) {
        try {
          const text = await response.text();
          console.log(`📡 [${response.status()}] ${u}`);
          console.log(`   => ${text.substring(0, 300)}`);
          if (!mp4Url) mp4Url = extractMp4(text, videoId);
        } catch(e) {}
      }
    });

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
    } catch(e) { console.log('⚠️ timeout goto'); }

    await page.waitForTimeout(8000);

    // Verifica auth
    const session = await page.evaluate(async () => {
      const r = await fetch('/api/auth/session', { credentials: 'include' });
      return r.text();
    });
    console.log('🔐 Session:', session.substring(0, 200));

    // Endpoints diretos
    if (!mp4Url) {
      const eps = [
        `/backend/generations/${videoId}`,
        `/backend-api/video/generation/${videoId}`,
        `/backend/video/${videoId}`,
      ];
      for (const ep of eps) {
        const r = await page.evaluate(async (p) => {
          const resp = await fetch(p.ep, { credentials: 'include', headers: { Accept: 'application/json', Authorization: `Bearer ${p.token}` } });
          return { status: resp.status, text: await resp.text() };
        }, { ep, token: SORA_AUTH_TOKEN });
        console.log(`  ${ep} [${r.status}]: ${(r.text||'').substring(0, 200)}`);
        if (r.status === 200) { mp4Url = extractMp4(r.text, videoId); if (mp4Url) break; }
      }
    }

    await browser.close();

    if (!mp4Url) return res.status(500).json({ error: 'MP4 não encontrado. Verifique os cookies.' });
    res.json({ downloadUrl: mp4Url });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

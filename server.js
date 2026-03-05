const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8080;
const SORA_COOKIES_ENV = process.env.SORA_COOKIES || '';
const SORA_SESSION_TOKEN = process.env.SORA_SESSION_TOKEN || '';
const SORA_AUTH_TOKEN = process.env.SORA_AUTH_TOKEN || '';
const TEST_VAR = process.env.TEST_VAR || 'NOT_SET';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function parseCookies(cookieStr) {
  const cookies = [];
  const parts = cookieStr.split(/;\s*(?=[a-zA-Z_])/);
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const name = part.substring(0, eqIdx).trim();
    const value = part.substring(eqIdx + 1).trim();
    if (!name || !value) continue;
    cookies.push({ name, value, domain: 'sora.chatgpt.com', path: '/' });
  }
  return cookies;
}

function extractId(url) {
  const m = url.match(/\/p\/(s_[a-f0-9]+)/i) || url.match(/\/g\/(gen_[a-z0-9]+)/i);
  return m ? m[1] : null;
}

function extractMp4(text) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  const patterns = [
    /"video_url"\s*:\s*"([^"]+)"/i,
    /"source_url"\s*:\s*"([^"]+)"/i,
    /"download_url"\s*:\s*"([^"]+)"/i,
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
  if (SORA_SESSION_TOKEN) cookies.push({ name: '__Secure-next-auth.session-token', value: SORA_SESSION_TOKEN, domain: 'sora.chatgpt.com', path: '/' });
  const hasSession = cookies.some(c => c.name.includes('session-token'));
  res.json({
    status: 'online',
    test_var: TEST_VAR,
    auth_token: !!SORA_AUTH_TOKEN,
    session_token_set: !!SORA_SESSION_TOKEN,
    session_token_length: SORA_SESSION_TOKEN.length,
    cookies_count: cookies.length,
    cookie_names: cookies.map(c => c.name),
    has_session_token: hasSession
  });
});

app.post('/process', async (req, res) => {
  const { url } = req.body;
  if (!url?.startsWith('http')) return res.status(400).json({ error: 'URL invalido.' });

  const videoId = extractId(url);
  if (!videoId) return res.status(400).json({ error: 'ID nao encontrado.' });

  console.log('Buscando:', videoId);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
    });

    // Cookies simples — sem httpOnly, sem sameSite, sem secure
    const cookies = parseCookies(SORA_COOKIES_ENV);
    if (SORA_SESSION_TOKEN) {
      cookies.push({
        name: '__Secure-next-auth.session-token',
        value: SORA_SESSION_TOKEN,
        domain: 'sora.chatgpt.com',
        path: '/'
      });
    }

    try {
      await context.addCookies(cookies);
      console.log('Cookies injetados:', cookies.map(c => c.name).join(', '));
    } catch(e) {
      console.log('Erro nos cookies:', e.message);
      // Tenta injetar um por um, ignorando os que falham
      for (const cookie of cookies) {
        try { await context.addCookies([cookie]); }
        catch(e2) { console.log('Cookie rejeitado:', cookie.name, e2.message); }
      }
    }

    if (SORA_AUTH_TOKEN) {
      await context.route('**/*', async (route) => {
        const u = route.request().url();
        if (u.includes('sora.chatgpt.com')) {
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
      if (ct.includes('json') && u.includes('sora.chatgpt.com') && !u.includes('cdn-cgi')) {
        try {
          const text = await response.text();
          console.log(`[${response.status()}] ${u} => ${text.substring(0, 200)}`);
          if (!mp4Url) mp4Url = extractMp4(text);
        } catch(e) {}
      }
    });

    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
    } catch(e) { console.log('timeout goto'); }

    await page.waitForTimeout(8000);

    const session = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/auth/session', { credentials: 'include' });
        return r.text();
      } catch(e) { return 'erro: ' + e.message; }
    });
    console.log('Session:', session.substring(0, 200));

    await browser.close();

    if (!mp4Url) return res.status(500).json({ error: 'MP4 nao encontrado. Cookies invalidos ou sessao expirada.' });
    res.json({ downloadUrl: mp4Url });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Porta ${PORT}`));

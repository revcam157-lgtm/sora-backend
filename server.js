const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 8080;

const SORA_COOKIES_ENV = process.env.SORA_COOKIES || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Converte string de cookies para array do Playwright
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
    };
  }).filter(c => c.name && c.value);
}

function extractId(url) {
  const m = url.match(/\/p\/(s_[a-f0-9]+)/i) || url.match(/\/g\/(gen_[a-z0-9]+)/i);
  return m ? m[1] : null;
}

app.get('/', (req, res) => res.json({
  status: '✅ Sora Downloader online',
  cookies: SORA_COOKIES_ENV ? 'configurado' : 'não configurado'
}));

app.post('/process', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL inválido.' });
  }

  const videoId = extractId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'ID do vídeo não encontrado.' });
  }

  console.log('🎬 Buscando:', videoId);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });

    // Injeta cookies do Sora
    if (SORA_COOKIES_ENV) {
      const cookies = parseCookies(SORA_COOKIES_ENV);
      await context.addCookies(cookies);
      console.log('🍪 Cookies injetados:', cookies.length);
    }

    // Intercepta resposta da API interna do Sora
    let mp4Url = null;

    context.on('response', async (response) => {
      const respUrl = response.url();
      if (respUrl.includes('/backend-api/video/generation/') || respUrl.includes(videoId)) {
        try {
          const json = await response.json();
          const str = JSON.stringify(json);
          const match = str.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
          if (match) {
            mp4Url = match[1].replace(/\\\//g, '/');
            console.log('✅ MP4 interceptado:', mp4Url.substring(0, 80));
          }
        } catch(e) {}
      }
    });

    // Abre a página do vídeo
    const page = await context.newPage();
    console.log('🌐 Abrindo página...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Aguarda um pouco para a API carregar
    await page.waitForTimeout(3000);

    // Se não interceptou, tenta chamar a API direto via page.evaluate
    if (!mp4Url) {
      console.log('🔍 Tentando API direta via browser...');
      mp4Url = await page.evaluate(async (id) => {
        try {
          const r = await fetch(`/backend-api/video/generation/${id}`, {
            credentials: 'include'
          });
          const json = await r.json();
          const str = JSON.stringify(json);
          const match = str.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
          return match ? match[1].replace(/\\\//g, '/') : null;
        } catch(e) { return null; }
      }, videoId);
    }

    await browser.close();

    if (!mp4Url) {
      return res.status(500).json({ error: 'Não foi possível extrair o vídeo. Verifique se o link é público e se os cookies estão atualizados.' });
    }

    res.json({ downloadUrl: mp4Url });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

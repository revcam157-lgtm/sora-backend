require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 8080;

// Segurança básica: permita apenas hosts autorizados (se ALLOWED_HOSTS estiver definido)
function getAllowedHosts() {
  const raw = (process.env.ALLOWED_HOSTS || '').trim();
  if (!raw) return null; // null = não restringe (você pode escolher restringir sempre)
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function hostFromUrl(input) {
  try {
    return new URL(input).host.toLowerCase();
  } catch {
    return null;
  }
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'playwright-service-template',
    time: new Date().toISOString()
  });
});

app.post('/inspect', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Campo "url" é obrigatório.' });
  }

  const host = hostFromUrl(url);
  if (!host) {
    return res.status(400).json({ error: 'URL inválida.' });
  }

  const allowed = getAllowedHosts();
  if (allowed && !allowed.includes(host)) {
    return res.status(403).json({
      error: 'Host não permitido.',
      host,
      allowedHosts: allowed
    });
  }

  let browser;
  const startedAt = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();

    const resp = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    const title = await page.title();
    const finalUrl = page.url();

    await browser.close();

    return res.json({
      ok: true,
      inputUrl: url,
      finalUrl,
      title,
      httpStatus: resp ? resp.status() : null,
      elapsedMs: Date.now() - startedAt
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      ok: false,
      error: err.message,
      elapsedMs: Date.now() - startedAt
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});

// Shutdown gracioso (bom pro Railway)
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido, encerrando...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('SIGINT recebido, encerrando...');
  server.close(() => process.exit(0));
});

const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;

// Cookies do Sora — configurado via variável de ambiente no Railway
const SORA_COOKIES = process.env.SORA_COOKIES || '';
const SORA_AUTH = process.env.SORA_AUTH_TOKEN || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ 
  status: '✅ Sora Downloader online',
  cookies_configured: SORA_COOKIES.length > 0 || SORA_AUTH.length > 0
}));

function extractId(url) {
  const patterns = [
    /\/p\/(s_[a-f0-9]+)/i,
    /\/g\/(gen_[a-z0-9]+)/i,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function fetchSoraApi(videoId) {
  return new Promise((resolve, reject) => {
    const apiUrl = `https://sora.chatgpt.com/backend-api/video/generation/${videoId}`;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://sora.chatgpt.com/',
      'Origin': 'https://sora.chatgpt.com',
    };

    // Adiciona autenticação
    if (SORA_AUTH) {
      headers['Authorization'] = `Bearer ${SORA_AUTH}`;
    }
    if (SORA_COOKIES) {
      headers['Cookie'] = SORA_COOKIES;
    }

    https.get(apiUrl, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        if (res.statusCode !== 200) {
          return reject(new Error(`API retornou ${res.statusCode}: ${data.substring(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error('Resposta inválida da API'));
        }
      });
    }).on('error', reject);
  });
}

function extractMp4(json) {
  const str = JSON.stringify(json);
  const candidates = [
    json?.download_links?.mp4_source,
    json?.download_links?.mp4,
    json?.video_url,
    json?.source_url,
    json?.url,
    json?.data?.video_url,
    json?.data?.download_links?.mp4_source,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && c.startsWith('http')) return c;
  }
  const match = str.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
  if (match) return match[1].replace(/\\\//g, '/');
  return null;
}

app.post('/process', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL inválido.' });
  }

  const videoId = extractId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'ID do vídeo não encontrado. Use link do tipo sora.chatgpt.com/p/s_xxx' });
  }

  console.log('🎬 Buscando vídeo:', videoId);

  try {
    const json = await fetchSoraApi(videoId);
    const mp4Url = extractMp4(json);

    if (!mp4Url) {
      return res.status(500).json({ error: 'MP4 não encontrado na resposta.' });
    }

    console.log('✅ MP4 encontrado');
    res.json({ downloadUrl: mp4Url });

  } catch (err) {
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT} | Auth: ${SORA_AUTH ? 'sim' : 'não'} | Cookies: ${SORA_COOKIES ? 'sim' : 'não'}`));

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: '✅ Sora Downloader online' }));

// Faz fetch da página HTML do Sora e extrai URL do MP4 limpo
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
      }
    }, (res) => {
      // Seguir redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractVideoUrl(html) {
  // Padrões para encontrar URL do MP4 no HTML/JSON do Sora
  const patterns = [
    // JSON embed com URL de vídeo
    /"video_url"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
    /"videoUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
    /"url"\s*:\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i,
    // Tags de vídeo HTML
    /<source[^>]+src="([^"]+\.mp4[^"]*)"[^>]*>/i,
    /<video[^>]+src="([^"]+\.mp4[^"]*)"[^>]*>/i,
    // URLs CDN comuns da OpenAI
    /(https?:\/\/(?:cdn\.openai\.com|videos\.openai\.com|sora\.com)[^\s"'<>]+\.mp4[^\s"'<>]*)/i,
    // Qualquer mp4 em JSON
    /(https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      // Decodifica escapes unicode/JSON
      let url = match[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/\\"/g, '"');
      if (url.startsWith('http')) return url;
    }
  }
  return null;
}

// POST /process
app.post('/process', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL inválido.' });
  }

  try {
    console.log('🔍 Buscando página:', url);
    const html = await fetchPage(url);

    console.log('📄 HTML recebido, tamanho:', html.length);

    const videoUrl = extractVideoUrl(html);

    if (!videoUrl) {
      // Log parte do HTML para debug
      console.log('HTML preview:', html.substring(0, 2000));
      return res.status(500).json({ 
        error: 'Não foi possível extrair o vídeo. O link precisa ser público e de um vídeo publicado no Sora.' 
      });
    }

    console.log('✅ URL do vídeo encontrada:', videoUrl);
    res.json({ downloadUrl: videoUrl });

  } catch (err) {
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

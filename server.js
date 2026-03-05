const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: '✅ Sora Downloader online' }));

// Extrai o ID do vídeo da URL do Sora
// Suporta formatos:
// https://sora.chatgpt.com/p/s_69a9e43e2eb88191904d5c83c6b6e318
// https://sora.chatgpt.com/g/gen_01jy8k8garfvavgrj40d62pfna
function extractId(url) {
  const patterns = [
    /\/p\/(s_[a-f0-9]+)/i,
    /\/g\/(gen_[a-z0-9]+)/i,
    /[?&]id=([a-z0-9_]+)/i,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Chama a API interna do Sora para obter a URL do vídeo limpo
function fetchSoraApi(videoId) {
  return new Promise((resolve, reject) => {
    // Endpoint interno do Sora descoberto por engenharia reversa
    const apiUrl = `https://sora.chatgpt.com/backend-api/video/generation/${videoId}`;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://sora.chatgpt.com/',
        'Origin': 'https://sora.chatgpt.com',
      }
    };

    https.get(apiUrl, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Resposta:', data.substring(0, 500));

        if (res.statusCode !== 200) {
          return reject(new Error(`API retornou ${res.statusCode}`));
        }

        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch(e) {
          reject(new Error('Resposta inválida da API do Sora'));
        }
      });
    }).on('error', reject);
  });
}

// Extrai URL do MP4 do JSON retornado pelo Sora
function extractMp4(json) {
  // Diferentes campos possíveis no JSON do Sora
  const candidates = [
    json?.download_links?.mp4_source,
    json?.download_links?.mp4,
    json?.video_url,
    json?.url,
    json?.source_url,
    json?.data?.video_url,
    json?.data?.url,
    json?.data?.download_links?.mp4_source,
    json?.data?.download_links?.mp4,
  ];

  for (const c of candidates) {
    if (c && typeof c === 'string' && c.startsWith('http')) return c;
  }

  // Busca recursiva no JSON por qualquer URL de MP4
  const str = JSON.stringify(json);
  const match = str.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/);
  if (match) return match[1].replace(/\\\//g, '/');

  return null;
}

// POST /process
app.post('/process', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL inválido.' });
  }

  const videoId = extractId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Não consegui extrair o ID do vídeo. Use um link do tipo sora.chatgpt.com/p/s_xxx' });
  }

  console.log('🎬 Video ID:', videoId);

  try {
    const json = await fetchSoraApi(videoId);
    console.log('JSON completo:', JSON.stringify(json).substring(0, 1000));

    const mp4Url = extractMp4(json);

    if (!mp4Url) {
      return res.status(500).json({
        error: 'Vídeo encontrado mas URL do MP4 não disponível. O vídeo pode ser privado.',
        debug: JSON.stringify(json).substring(0, 300)
      });
    }

    console.log('✅ MP4 URL:', mp4Url);
    res.json({ downloadUrl: mp4Url });

  } catch (err) {
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

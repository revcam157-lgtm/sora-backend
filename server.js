const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: '✅ Sora Downloader online' }));

// Extrai URL direta do MP4 limpo usando yt-dlp
function extractVideoUrl(pageUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--get-url',                    // só retorna a URL direta, não baixa
      '--impersonate', 'chrome',
      pageUrl
    ];

    execFile('yt-dlp', args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        const url = stdout.trim().split('\n')[0]; // pega primeira URL
        if (!url || !url.startsWith('http')) {
          reject(new Error('Não foi possível extrair a URL do vídeo.'));
        } else {
          resolve(url);
        }
      }
    });
  });
}

// POST /process — recebe link da página do Sora, retorna URL direta do mp4
app.post('/process', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL inválido.' });
  }

  try {
    console.log('🔍 Extraindo URL do vídeo:', url);
    const directUrl = await extractVideoUrl(url);
    console.log('✅ URL extraída:', directUrl);
    res.json({ downloadUrl: directUrl });
  } catch (err) {
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

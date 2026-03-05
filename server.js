const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use('/output', express.static(path.join(__dirname, 'output')));

if (!fs.existsSync('./output')) fs.mkdirSync('./output');

// Limpa arquivos antigos (> 30 min) para não lotar o servidor
setInterval(() => {
  const dir = './output';
  const now = Date.now();
  fs.readdirSync(dir).forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > 30 * 60 * 1000) {
      fs.unlinkSync(filePath);
    }
  });
}, 10 * 60 * 1000);

app.get('/', (req, res) => {
  res.json({ status: 'Sora Logo Remover API online ✅' });
});

app.post('/process', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL inválido.' });
  }

  const inputPath = `./output/input_${Date.now()}.mp4`;
  const outputPath = `./output/clean_${Date.now()}.mp4`;

  try {
    console.log('⬇ Baixando:', url);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 60000
    });

    if (!response.ok) throw new Error(`Erro ao baixar vídeo: ${response.status}`);

    const buffer = await response.buffer();
    fs.writeFileSync(inputPath, buffer);

    console.log('✂️ Removendo logo Sora...');

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters([
          {
            filter: 'delogo',
            options: {
              x: 'W-220',
              y: 'H-70',
              w: '210',
              h: '60',
              show: 0
            }
          }
        ])
        .outputOptions(['-c:a copy'])
        .output(outputPath)
        .on('end', () => { resolve(); })
        .on('error', (err) => reject(err))
        .run();
    });

    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ downloadUrl: `${host}/output/${path.basename(outputPath)}` });

  } catch (err) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});
const response = await fetch(videoUrl, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://sora.com/',
    'Origin': 'https://sora.com'
  }
});

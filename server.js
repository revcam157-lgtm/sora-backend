const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/output', express.static(path.join(__dirname, 'output')));

if (!fs.existsSync('./output')) fs.mkdirSync('./output');
if (!fs.existsSync('./cookies')) fs.mkdirSync('./cookies');

// Limpa arquivos antigos a cada 10 min
setInterval(() => {
  const dir = './output';
  const now = Date.now();
  try {
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(filePath);
    });
  } catch (e) {}
}, 10 * 60 * 1000);

app.get('/', (req, res) => {
  res.json({ status: 'Sora Logo Remover API online ✅' });
});

// Baixa com yt-dlp usando cookies do usuário
function downloadWithYtDlp(url, cookiesContent, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '-o', outputPath,
      '--merge-output-format', 'mp4',
    ];

    let cookieFile = null;
    if (cookiesContent) {
      cookieFile = `./cookies/cookies_${Date.now()}.txt`;
      fs.writeFileSync(cookieFile, cookiesContent);
      args.push('--cookies', cookieFile);
    }

    args.push(url);

    execFile('yt-dlp', args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (cookieFile && fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);
      if (error) {
        reject(new Error(`Falha no download: ${stderr || error.message}`));
      } else {
        resolve();
      }
    });
  });
}

// Remove logo com FFmpeg
function removeLogoFFmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
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
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

app.post('/process', async (req, res) => {
  const { url, cookies } = req.body;

  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL inválido.' });
  }

  const ts = Date.now();
  const inputPath = `./output/input_${ts}.mp4`;
  const outputPath = `./output/clean_${ts}.mp4`;

  try {
    console.log('⬇ Baixando com yt-dlp:', url);
    await downloadWithYtDlp(url, cookies || null, inputPath);

    if (!fs.existsSync(inputPath)) {
      throw new Error('Download falhou — arquivo não encontrado.');
    }

    console.log('✂️ Removendo logo Sora...');
    await removeLogoFFmpeg(inputPath, outputPath);

    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ downloadUrl: `${host}/output/${path.basename(outputPath)}` });

  } catch (err) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});

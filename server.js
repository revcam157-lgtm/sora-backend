const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const multer = require('multer');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/output', express.static(path.join(__dirname, 'output')));

if (!fs.existsSync('./output')) fs.mkdirSync('./output');
if (!fs.existsSync('./cookies')) fs.mkdirSync('./cookies');
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// multer for file uploads (500MB limit)
const upload = multer({ dest: './uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

// Cleanup old files every 10 min
setInterval(() => {
  ['./output', './uploads'].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(file => {
        const fp = path.join(dir, file);
        if (Date.now() - fs.statSync(fp).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(fp);
      });
    } catch(e) {}
  });
}, 10 * 60 * 1000);

app.get('/', (req, res) => res.json({ status: 'Sora Logo Remover API online ✅' }));

// Build ffmpeg filter based on method
function buildFilter(method) {
  if (method === 'blur') {
    return 'split[original][copy];[copy]crop=210:60:iw-220:ih-70,boxblur=20:20[blurred];[original][blurred]overlay=W-210:H-60';
  } else if (method === 'crop') {
    return 'crop=iw:ih-70:0:0';
  } else {
    return 'delogo=x=iw-220:y=ih-70:w=210:h=60:show=0';
  }
}

function processWithFFmpeg(inputPath, outputPath, method, highQuality) {
  return new Promise((resolve, reject) => {
    const qualityArgs = highQuality ? ['-crf', '18'] : ['-crf', '23'];
    ffmpeg(inputPath)
      .videoFilters(buildFilter(method))
      .outputOptions(['-c:a', 'copy', '-c:v', 'libx264', ...qualityArgs])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// --- ROUTE: URL ---
app.post('/process', async (req, res) => {
  const { url, method = 'delogo', highQuality = true } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'URL inválido.' });

  const ts = Date.now();
  const inputPath = `./output/input_${ts}.mp4`;
  const outputPath = `./output/clean_${ts}.mp4`;

  try {
    await downloadWithYtDlp(url, null, inputPath);
    if (!fs.existsSync(inputPath)) throw new Error('Download falhou.');

    await processWithFFmpeg(inputPath, outputPath, method, highQuality);
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ downloadUrl: `${host}/output/${path.basename(outputPath)}` });
  } catch (err) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: err.message });
  }
});

// --- ROUTE: UPLOAD ---
app.post('/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  const method = req.body.method || 'delogo';
  const highQuality = req.body.highQuality === 'true';
  const inputPath = req.file.path;
  const outputPath = `./output/clean_${Date.now()}.mp4`;

  try {
    await processWithFFmpeg(inputPath, outputPath, method, highQuality);
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);

    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ downloadUrl: `${host}/output/${path.basename(outputPath)}` });
  } catch (err) {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).json({ error: err.message });
  }
});

function downloadWithYtDlp(url, cookiesContent, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ['--no-playlist', '--no-warnings', '-o', outputPath,
      '--merge-output-format', 'mp4',
      '--extractor-args', 'generic:impersonate', '--impersonate', 'chrome'];
    let cookieFile = null;
    if (cookiesContent) {
      cookieFile = `./cookies/cookies_${Date.now()}.txt`;
      fs.writeFileSync(cookieFile, cookiesContent);
      args.push('--cookies', cookieFile);
    }
    args.push(url);
    execFile('yt-dlp', args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (cookieFile && fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);
      if (error) reject(new Error(`Falha no download: ${stderr || error.message}`));
      else resolve();
    });
  });
}

app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));

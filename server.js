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

// Use /tmp no Railway (único diretório gravável com certeza)
const TMP = '/tmp/sorawipe';
const OUTPUT_DIR = path.join(TMP, 'output');
const UPLOAD_DIR = path.join(TMP, 'uploads');
const COOKIE_DIR = path.join(TMP, 'cookies');

[TMP, OUTPUT_DIR, UPLOAD_DIR, COOKIE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/output', express.static(OUTPUT_DIR));

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

// Cleanup a cada 10 min
setInterval(() => {
  [OUTPUT_DIR, UPLOAD_DIR].forEach(dir => {
    try {
      fs.readdirSync(dir).forEach(file => {
        const fp = path.join(dir, file);
        if (Date.now() - fs.statSync(fp).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(fp);
      });
    } catch(e) {}
  });
}, 10 * 60 * 1000);

app.get('/', (req, res) => res.json({ status: '✅ Sora Logo Remover online' }));

function buildFilter(method) {
  if (method === 'blur') {
    return 'split[original][copy];[copy]crop=210:60:iw-220:ih-70,boxblur=20:20[blurred];[original][blurred]overlay=W-210:H-60';
  } else if (method === 'crop') {
    return 'crop=iw:ih-70:0:0';
  }
  return 'delogo=x=iw-220:y=ih-70:w=210:h=60:show=0';
}

function processWithFFmpeg(inputPath, outputPath, method, highQuality) {
  return new Promise((resolve, reject) => {
    const qualityArgs = highQuality ? ['-crf', '18'] : ['-crf', '23'];
    console.log(`FFmpeg: ${inputPath} -> ${outputPath} [${method}]`);
    ffmpeg(inputPath)
      .videoFilters(buildFilter(method))
      .outputOptions(['-c:a', 'copy', '-c:v', 'libx264', ...qualityArgs])
      .output(outputPath)
      .on('start', cmd => console.log('CMD:', cmd))
      .on('end', () => { console.log('FFmpeg OK'); resolve(); })
      .on('error', (err, stdout, stderr) => {
        console.error('FFmpeg error:', err.message);
        console.error('stderr:', stderr);
        reject(new Error(err.message));
      })
      .run();
  });
}

function downloadWithYtDlp(url, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--no-warnings',
      '-o', outputPath,
      '--merge-output-format', 'mp4',
      '--extractor-args', 'generic:impersonate',
      '--impersonate', 'chrome',
      url
    ];
    execFile('yt-dlp', args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve();
    });
  });
}

// POST /process — via URL
app.post('/process', async (req, res) => {
  const { url, method = 'delogo', highQuality = true } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'URL inválido.' });

  const ts = Date.now();
  const inputPath = path.join(OUTPUT_DIR, `input_${ts}.mp4`);
  const outputPath = path.join(OUTPUT_DIR, `clean_${ts}.mp4`);

  try {
    await downloadWithYtDlp(url, inputPath);
    if (!fs.existsSync(inputPath)) throw new Error('Download falhou — arquivo não encontrado.');
    await processWithFFmpeg(inputPath, outputPath, method, highQuality === true || highQuality === 'true');
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ downloadUrl: `${host}/output/clean_${ts}.mp4` });
  } catch (err) {
    [inputPath, outputPath].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /upload — via arquivo
app.post('/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

  const method = req.body.method || 'delogo';
  const highQuality = req.body.highQuality === 'true';
  const inputPath = req.file.path;
  const ts = Date.now();
  const outputPath = path.join(OUTPUT_DIR, `clean_${ts}.mp4`);

  try {
    await processWithFFmpeg(inputPath, outputPath, method, highQuality);
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ downloadUrl: `${host}/output/clean_${ts}.mp4` });
  } catch (err) {
    [inputPath, outputPath].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT} | Output: ${OUTPUT_DIR}`));

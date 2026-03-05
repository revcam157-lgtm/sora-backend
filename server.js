const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080;

const TMP = '/tmp/sorawipe';
const OUTPUT_DIR = path.join(TMP, 'output');
const UPLOAD_DIR = path.join(TMP, 'uploads');

[TMP, OUTPUT_DIR, UPLOAD_DIR].forEach(dir => {
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

// Detecta resolução do vídeo
function getVideoSize(inputPath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      inputPath
    ], { timeout: 15000 }).toString().trim();
    const [w, h] = out.split(',').map(Number);
    return { w, h };
  } catch(e) {
    // fallback: assume 1080p
    return { w: 1920, h: 1080 };
  }
}

// Chama ffmpeg diretamente via execFile (sem fluent-ffmpeg)
function processWithFFmpeg(inputPath, outputPath, method, highQuality) {
  return new Promise((resolve, reject) => {
    const { w, h } = getVideoSize(inputPath);
    console.log(`Resolução detectada: ${w}x${h}`);

    // Coordenadas absolutas do logo Sora (canto inferior direito)
    // Logo ~200x50px no canto
    const logoW = Math.round(w * 0.11);
    const logoH = Math.round(h * 0.055);
    const logoX = w - logoW - 10;
    const logoY = h - logoH - 10;

    let vf;
    if (method === 'blur') {
      vf = `split[a][b];[b]crop=${logoW}:${logoH}:${logoX}:${logoY},boxblur=15:15[blurred];[a][blurred]overlay=${logoX}:${logoY}`;
    } else if (method === 'crop') {
      vf = `crop=${w}:${h - logoH - 14}:0:0`;
    } else {
      // delogo com valores absolutos
      vf = `delogo=x=${logoX}:y=${logoY}:w=${logoW}:h=${logoH}:show=0`;
    }

    const crf = highQuality ? '18' : '23';

    const args = [
      '-y',
      '-i', inputPath,
      '-vf', vf,
      '-c:v', 'libx264',
      '-crf', crf,
      '-preset', 'fast',
      '-c:a', 'copy',
      outputPath
    ];

    console.log('ffmpeg', args.join(' '));

    execFile('ffmpeg', args, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('FFmpeg erro:', stderr);
        reject(new Error(stderr || err.message));
      } else {
        console.log('✅ FFmpeg concluído');
        resolve();
      }
    });
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

function cleanup(...files) {
  files.forEach(f => { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
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
    if (!fs.existsSync(inputPath)) throw new Error('Download falhou.');
    await processWithFFmpeg(inputPath, outputPath, method, highQuality === true || highQuality === 'true');
    cleanup(inputPath);
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ downloadUrl: `${host}/output/clean_${ts}.mp4` });
  } catch (err) {
    cleanup(inputPath, outputPath);
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
    cleanup(inputPath);
    const host = `${req.protocol}://${req.get('host')}`;
    res.json({ downloadUrl: `${host}/output/clean_${ts}.mp4` });
  } catch (err) {
    cleanup(inputPath, outputPath);
    console.error('❌', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));

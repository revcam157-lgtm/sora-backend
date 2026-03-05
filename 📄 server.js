const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
app.use(cors());
app.use(express.json());
app.use('/output', express.static(path.join(__dirname, 'output')));
if (!fs.existsSync('./output')) fs.mkdirSync('./output');

app.post('/process', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL não informado.' });
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Não foi possível baixar o vídeo.');
    const inputPath = `./output/input_${Date.now()}.mp4`;
    const outputPath = `./output/clean_${Date.now()}.mp4`;
    const buffer = await response.buffer();
    fs.writeFileSync(inputPath, buffer);
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoFilters([{ filter: 'delogo', options: { x: 'W-220', y: 'H-70', w: '210', h: '60', show: 0 } }])
        .output(outputPath)
        .on('end', () => { fs.unlinkSync(inputPath); resolve(); })
        .on('error', reject)
        .run();
    });
    const port = process.env.PORT || 3001;
    const host = process.env.RAILWAY_PUBLIC_DOMAIN 
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
      : `http://localhost:${port}`;
    res.json({ downloadUrl: `${host}/output/${path.basename(outputPath)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`🚀 Backend rodando na porta ${port}`));

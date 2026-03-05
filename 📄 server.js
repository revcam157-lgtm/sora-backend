const express = require("express");
const cors = require("cors");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

// Servir arquivos processados
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

// Criar pasta downloads se não existir
if (!fs.existsSync("downloads")) fs.mkdirSync("downloads");

app.get("/", (req, res) => {
  res.json({ status: "SoraWipe backend running" });
});

app.post("/process", async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL é obrigatória." });

  try {
    // Se não for link direto de vídeo, tentar extrair da página
    if (!url.match(/\.(mp4|webm|mov)(\?|$)/i)) {
      console.log("Extraindo URL do vídeo da página:", url);
      const pageRes = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      if (!pageRes.ok) throw new Error("Não foi possível acessar a página do Sora.");
      const html = await pageRes.text();
      const $ = cheerio.load(html);
      const videoUrl = $("video source").attr("src") || $("video").attr("src") || $("meta[property='og:video']").attr("content");
      if (!videoUrl) throw new Error("Não foi possível encontrar o vídeo nesta página.");
      url = videoUrl.startsWith("http") ? videoUrl : `https://sora.chatgpt.com${videoUrl}`;
      console.log("URL do vídeo extraída:", url);
    }

    const inputFile = path.join(__dirname, "downloads", `input_${Date.now()}.mp4`);
    const outputFile = path.join(__dirname, "downloads", `output_${Date.now()}.mp4`);

    // Baixar o vídeo
    console.log("Baixando vídeo:", url);
    const videoRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    if (!videoRes.ok) throw new Error("Falha ao baixar o vídeo.");
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    fs.writeFileSync(inputFile, buffer);
    console.log("Vídeo baixado:", inputFile);

    // Processar com FFmpeg - remover marca d'água
    await new Promise((resolve, reject) => {
      execFile("ffmpeg", [
        "-i", inputFile,
        "-vf", "delogo=x='iw-220':y='ih-70':w=210:h=60",
        "-c:a", "copy",
        "-y", outputFile
      ], (error, stdout, stderr) => {
        if (error) {
          console.error("FFmpeg error:", stderr);
          reject(new Error("Erro ao processar vídeo com FFmpeg."));
        } else {
          resolve();
        }
      });
    });

    // Limpar arquivo de entrada
    fs.unlinkSync(inputFile);

    const domain = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${process.env.PORT || 8080}`;
    const protocol = process.env.RAILWAY_PUBLIC_DOMAIN ? "https" : "http";
    const downloadUrl = `${protocol}://${domain}/downloads/${path.basename(outputFile)}`;

    console.log("Vídeo processado:", downloadUrl);
    res.json({ downloadUrl });

  } catch (err) {
    console.error("Erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

/**
 * Boss-Bot Download Server
 * Uses yt-dlp-exec instead of spawn
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const ytdlp = require("yt-dlp-exec");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "bossbot-download-key";

// Railway / proxy fix
app.set("trust proxy", 1);

// ── Middleware ─────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests. Slow down." },
});
app.use(limiter);

// ── API Auth ───────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;

  if (key !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized — invalid API key",
    });
  }

  next();
}

// ── Temp Directory ─────────────────────────────────────────
const TMP_DIR = path.join(__dirname, "tmp");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// cleanup old files
setInterval(() => {
  try {
    const files = fs.readdirSync(TMP_DIR);
    const now = Date.now();

    for (const file of files) {
      const fp = path.join(TMP_DIR, file);
      const stat = fs.statSync(fp);

      if (now - stat.mtimeMs > 10 * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    }
  } catch {}
}, 5 * 60 * 1000);

// ── Stream file then delete ─────────────────────────────────
function streamAndDelete(filePath, res, filename, mimetype) {
  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ error: "Output file not found" });
  }

  const stat = fs.statSync(filePath);

  res.setHeader("Content-Type", mimetype);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", stat.size);

  const stream = fs.createReadStream(filePath);

  stream.pipe(res);

  stream.on("end", () => {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  });
}

// ── Helper: find newest file ─────────────────────────────────
function getNewestFile() {
  const files = fs.readdirSync(TMP_DIR);

  if (!files.length) return null;

  const newest = files
    .map((f) => ({
      f,
      t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.t - a.t)[0];

  return newest ? path.join(TMP_DIR, newest.f) : null;
}

// ── Health Check ───────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Boss-Bot Download Server",
    version: "2.0",
    uptime: Math.floor(process.uptime()),
  });
});

// ── INFO ENDPOINT ──────────────────────────────────────────
app.get("/info", auth, async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  try {
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noPlaylist: true,
    });

    res.json({
      title: info.title,
      duration: info.duration,
      uploader: info.uploader,
      thumbnail: info.thumbnail,
      view_count: info.view_count,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── YOUTUBE DOWNLOAD ───────────────────────────────────────
app.post("/download/youtube", auth, async (req, res) => {
  const { url, quality = "best" } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const out = path.join(TMP_DIR, `yt_${Date.now()}.%(ext)s`);

  try {
    let format = "bestvideo+bestaudio/best";

    if (quality === "360p") format = "bestvideo[height<=360]+bestaudio";
    if (quality === "480p") format = "bestvideo[height<=480]+bestaudio";
    if (quality === "720p") format = "bestvideo[height<=720]+bestaudio";

    await ytdlp(url, {
      format,
      output: out,
      mergeOutputFormat: "mp4",
      noPlaylist: true,
      maxFilesize: "200m",
    });

    const file = getNewestFile();

    if (!file) {
      return res.status(500).json({ error: "Output not found" });
    }

    streamAndDelete(file, res, "video.mp4", "video/mp4");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AUDIO DOWNLOAD ─────────────────────────────────────────
app.post("/download/audio", auth, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const out = path.join(TMP_DIR, `audio_${Date.now()}.mp3`);

  try {
    await ytdlp(url, {
      extractAudio: true,
      audioFormat: "mp3",
      audioQuality: 0,
      output: out,
      noPlaylist: true,
      maxFilesize: "50m",
    });

    streamAndDelete(out, res, "audio.mp3", "audio/mpeg");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UNIVERSAL DOWNLOADER ───────────────────────────────────
app.post("/download", auth, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const out = path.join(TMP_DIR, `media_${Date.now()}.%(ext)s`);

  try {
    await ytdlp(url, {
      format: "best",
      output: out,
      noPlaylist: true,
      maxFilesize: "150m",
    });

    const file = getNewestFile();

    if (!file) {
      return res.status(500).json({ error: "Output not found" });
    }

    const ext = path.extname(file);

    const mime =
      ext === ".mp3"
        ? "audio/mpeg"
        : ext === ".mp4"
        ? "video/mp4"
        : "application/octet-stream";

    streamAndDelete(file, res, `media${ext}`, mime);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Boss-Bot Download Server running on port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
});

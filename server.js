/**
 * Boss-Bot Download Server
 * Deploy on Railway — has yt-dlp + ffmpeg natively
 *
 * Endpoints:
 *   GET  /                    — health check
 *   POST /download/youtube    — download YouTube video/audio
 *   POST /download/facebook   — download Facebook video
 *   POST /download/instagram  — download Instagram video/reel
 *   POST /download/tiktok     — download TikTok video
 *   POST /download/twitter    — download Twitter/X video
 *   POST /download/audio      — extract audio from any URL (MP3)
 *   GET  /info                — get media info without downloading
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "bossbot-download-key";
app.set("trust proxy", 1);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // 30 requests per minute per IP
  message: { error: "Too many requests. Please slow down." },
});
app.use(limiter);

// API key auth middleware
function auth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized — invalid API key" });
  }
  next();
}

// Temp directory for downloads
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Auto-cleanup tmp files older than 10 minutes
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

// ── Helper: run yt-dlp ────────────────────────────────────────────────────────
function ytdlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { timeout: 120000 });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `yt-dlp exited ${code}`));
    });
    proc.on("error", reject);
  });
}

// ── Helper: stream file to response then delete ───────────────────────────────
function streamAndDelete(filePath, res, filename, mimetype) {
  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ error: "Output file not found" });
  }
  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", mimetype);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("X-File-Size", stat.size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("end", () => {
    try { fs.unlinkSync(filePath); } catch {}
  });
  stream.on("error", () => {
    try { fs.unlinkSync(filePath); } catch {}
    res.end();
  });
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Boss-Bot Download Server",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    endpoints: ["/download/youtube", "/download/audio", "/download/facebook", "/download/instagram", "/download/tiktok", "/download/twitter", "/info"],
  });
});

// ── GET /info — get video info without downloading ────────────────────────────
app.get("/info", auth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const json = await ytdlp([
      url, "--dump-json", "--no-playlist",
      "--user-agent", "Mozilla/5.0",
    ]);
    const info = JSON.parse(json);
    res.json({
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      uploader: info.uploader,
      view_count: info.view_count,
      formats: info.formats?.slice(-5).map((f) => ({
        format_id: f.format_id,
        ext: f.ext,
        quality: f.quality,
        filesize: f.filesize,
        resolution: f.resolution,
      })),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /download/youtube ────────────────────────────────────────────────────
app.post("/download/youtube", auth, async (req, res) => {
  const { url, quality = "best", format = "mp4" } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const outFile = path.join(TMP_DIR, `yt_${Date.now()}.%(ext)s`);

  try {
    // Select format based on quality
    let fmtSelector = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";
    if (quality === "audio" || format === "mp3") {
      fmtSelector = "bestaudio/best";
    } else if (quality === "360p") {
      fmtSelector = "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]";
    } else if (quality === "480p") {
      fmtSelector = "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]";
    } else if (quality === "720p") {
      fmtSelector = "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]";
    }

    const args = [
      url,
      "-f", fmtSelector,
      "-o", outFile,
      "--no-playlist",
      "--max-filesize", "200m",
      "--user-agent", "Mozilla/5.0",
      "--merge-output-format", "mp4",
    ];

    if (format === "mp3") {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    }

    await ytdlp(args);

    // Find the actual output file (yt-dlp replaces %(ext)s)
    const files = fs.readdirSync(TMP_DIR).filter((f) => f.startsWith(`yt_${Date.now().toString().slice(0, -3)}`));
    const actualFile = path.join(TMP_DIR, files[0] || "");

    // Try to find by pattern
    const allFiles = fs.readdirSync(TMP_DIR);
    const outBase = path.basename(outFile).replace(".%(ext)s", "");
    const match = allFiles.find((f) => f.includes(outBase.replace(".%(ext)s", "")));

    if (!match) {
      // Find newest file in tmp
      const newest = allFiles
        .map((f) => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
      if (!newest) return res.status(500).json({ error: "Output file not found" });

      const finalPath = path.join(TMP_DIR, newest.f);
      const ext = path.extname(newest.f).slice(1) || "mp4";
      const mime = ext === "mp3" ? "audio/mpeg" : "video/mp4";
      return streamAndDelete(finalPath, res, `video.${ext}`, mime);
    }

    const finalPath = path.join(TMP_DIR, match);
    const ext = path.extname(match).slice(1) || "mp4";
    const mime = ext === "mp3" ? "audio/mpeg" : "video/mp4";
    streamAndDelete(finalPath, res, `video.${ext}`, mime);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /download/audio — extract audio as MP3 from any URL ─────────────────
app.post("/download/audio", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const outFile = path.join(TMP_DIR, `audio_${Date.now()}.mp3`);

  try {
    await ytdlp([
      url,
      "-x", "--audio-format", "mp3",
      "--audio-quality", "0",
      "-o", outFile,
      "--no-playlist",
      "--max-filesize", "50m",
      "--user-agent", "Mozilla/5.0",
    ]);

    streamAndDelete(outFile, res, "audio.mp3", "audio/mpeg");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /download/facebook ───────────────────────────────────────────────────
app.post("/download/facebook", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const outFile = path.join(TMP_DIR, `fb_${Date.now()}.mp4`);

  try {
    await ytdlp([
      url, "-f", "best[ext=mp4]/best",
      "-o", outFile,
      "--no-playlist",
      "--max-filesize", "100m",
    ]);

    const files = fs.readdirSync(TMP_DIR);
    const match = files.find((f) => f.startsWith(`fb_`) && f.includes(Date.now().toString().slice(0, -3)));
    const newest = files.map((f) => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    const finalPath = path.join(TMP_DIR, newest?.f || "");
    if (!newest) return res.status(500).json({ error: "Output not found" });

    streamAndDelete(finalPath, res, "facebook_video.mp4", "video/mp4");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /download/instagram ──────────────────────────────────────────────────
app.post("/download/instagram", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const outFile = path.join(TMP_DIR, `ig_${Date.now()}.%(ext)s`);

  try {
    await ytdlp([
      url, "-f", "best",
      "-o", outFile,
      "--no-playlist",
      "--max-filesize", "100m",
    ]);

    const files = fs.readdirSync(TMP_DIR);
    const newest = files.map((f) => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (!newest) return res.status(500).json({ error: "Output not found" });

    const finalPath = path.join(TMP_DIR, newest.f);
    const ext = path.extname(newest.f).slice(1) || "mp4";
    streamAndDelete(finalPath, res, `instagram.${ext}`, "video/mp4");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /download/tiktok ─────────────────────────────────────────────────────
app.post("/download/tiktok", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const outFile = path.join(TMP_DIR, `tt_${Date.now()}.%(ext)s`);

  try {
    await ytdlp([
      url, "-f", "best",
      "-o", outFile,
      "--no-playlist",
      "--max-filesize", "100m",
      // TikTok needs cookies sometimes, try without first
    ]);

    const files = fs.readdirSync(TMP_DIR);
    const newest = files.map((f) => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (!newest) return res.status(500).json({ error: "Output not found" });

    const finalPath = path.join(TMP_DIR, newest.f);
    streamAndDelete(finalPath, res, "tiktok.mp4", "video/mp4");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /download/twitter ────────────────────────────────────────────────────
app.post("/download/twitter", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const outFile = path.join(TMP_DIR, `tw_${Date.now()}.%(ext)s`);

  try {
    await ytdlp([
      url, "-f", "best[ext=mp4]/best",
      "-o", outFile,
      "--no-playlist",
      "--max-filesize", "100m",
    ]);

    const files = fs.readdirSync(TMP_DIR);
    const newest = files.map((f) => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (!newest) return res.status(500).json({ error: "Output not found" });

    const finalPath = path.join(TMP_DIR, newest.f);
    streamAndDelete(finalPath, res, "twitter.mp4", "video/mp4");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Boss-Bot Download Server running on port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
});

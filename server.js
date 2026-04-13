/**
 * Boss-Bot Download Server
 * Deploy on Railway — uses a bundled yt-dlp binary plus ffmpeg
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
const { create: createYoutubeDl } = require("youtube-dl-exec");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "bossbot-download-key";
let cachedYoutubeDl;

function resolveYoutubeDlPath() {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;

  // Prefer the package-managed binary when available (local/dev installs).
  const bundledBinary = path.join(
    __dirname,
    "node_modules",
    "youtube-dl-exec",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );
  if (fs.existsSync(bundledBinary)) return bundledBinary;

  // Fallback to a globally available binary in PATH (common on Railway/Nix).
  return "yt-dlp";
}

function getYoutubeDl() {
  if (!cachedYoutubeDl) {
    cachedYoutubeDl = createYoutubeDl(resolveYoutubeDlPath());
  }
  return cachedYoutubeDl;
}

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
}, 5 * 60 * 1000).unref();

// ── Helper: run yt-dlp ────────────────────────────────────────────────────────
function ytdlp(commandArgs) {
  const [url, ...rawFlags] = commandArgs;
  const flags = {};
  const isFlagToken = (token) => /^--[a-zA-Z][a-zA-Z0-9-]*$/.test(token);

  if (!url) {
    return Promise.reject(new Error("yt-dlp url is required"));
  }

  for (let i = 0; i < rawFlags.length; i++) {
    const token = rawFlags[i];
    if (!isFlagToken(token)) {
      return Promise.reject(new Error(`Unexpected yt-dlp argument: ${token}`));
    }

    const key = token.replace(/^-+/, "");
    const next = rawFlags[i + 1];
    const hasValue = next !== undefined && !isFlagToken(next);
    const value = hasValue ? next : true;

    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      flags[key] = [].concat(flags[key], value);
    } else {
      flags[key] = value;
    }

    if (hasValue) i++;
  }

  return getYoutubeDl()
    .exec(url, flags, { timeout: 120000 })
    .then(({ stdout }) => stdout.trim())
    .catch((err) => {
      const message = err.stderr?.trim() || err.message || `yt-dlp execution failed for URL: ${url}`;
      if (/ENOENT|spawn\s+.*not\s+found|not found/i.test(message)) {
        throw new Error("yt-dlp binary not found. Set YT_DLP_PATH to a valid yt-dlp path or ensure yt-dlp is available in PATH.");
      }
      throw new Error(message);
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
const HEALTH_DATA = () => ({
  status: "ok",
  service: "Boss-Bot Download Server",
  version: "1.0.0",
  uptime: Math.floor(process.uptime()),
  endpoints: ["/download/youtube", "/download/audio", "/download/facebook", "/download/instagram", "/download/tiktok", "/download/twitter", "/info"],
});

app.get("/", (req, res) => {
  // JSON response for API clients
  if (req.headers.accept?.includes("application/json") || req.query.format === "json") {
    return res.json(HEALTH_DATA());
  }

  // Browser-friendly HTML test page
  const data = HEALTH_DATA();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Boss-Bot Download Server</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; background: #0d1117; color: #e6edf3; }
    h1 { color: #58a6ff; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 12px; background: #238636; color: #fff; font-size: 13px; }
    label { display: block; margin: 8px 0 4px; font-size: 14px; color: #8b949e; }
    input { width: 100%; box-sizing: border-box; padding: 8px 10px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 14px; }
    button { margin-top: 12px; padding: 8px 20px; background: #238636; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-size: 14px; }
    button:hover { background: #2ea043; }
    pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; overflow-x: auto; font-size: 13px; white-space: pre-wrap; word-break: break-all; }
    .section { margin: 24px 0; }
    .endpoint { display: inline-block; background: #161b22; border: 1px solid #30363d; border-radius: 4px; padding: 2px 8px; font-family: monospace; font-size: 13px; margin: 3px 2px; }
    .error { color: #f85149; }
    .loading { color: #8b949e; }
  </style>
</head>
<body>
  <h1>🤖 Boss-Bot Download Server</h1>
  <p><span class="badge">● online</span> &nbsp; uptime: ${data.uptime}s &nbsp; v${data.version}</p>

  <div class="section">
    <strong>Available endpoints</strong><br>
    ${data.endpoints.map(e => `<span class="endpoint">${e}</span>`).join("")}
  </div>

  <div class="section">
    <h2 style="font-size:16px;color:#58a6ff">🔍 Test /info endpoint</h2>
    <label for="url">Video URL</label>
    <input id="url" type="url" placeholder="https://youtu.be/...">
    <label for="key">API Key</label>
    <input id="key" type="text" placeholder="your-api-key">
    <button onclick="testInfo()">Fetch info</button>
    <pre id="result" style="display:none"></pre>
  </div>

  <div class="section">
    <details>
      <summary style="cursor:pointer;color:#8b949e;font-size:13px">curl examples</summary>
      <pre># Info (GET)
curl "${req.protocol}://${req.get("host")}/info?url=URL&amp;key=YOUR_KEY"

# Download YouTube video (POST)
curl -X POST "${req.protocol}://${req.get("host")}/download/youtube" \\
  -H "x-api-key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/...","quality":"720p"}' \\
  --output video.mp4

# Extract audio (POST)
curl -X POST "${req.protocol}://${req.get("host")}/download/audio" \\
  -H "x-api-key: YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/..."}' \\
  --output audio.mp3</pre>
    </details>
  </div>

  <script>
    async function testInfo() {
      const url = document.getElementById("url").value.trim();
      const key = document.getElementById("key").value.trim();
      const out = document.getElementById("result");
      if (!url || !key) { out.style.display="block"; out.className="error"; out.textContent="Please fill in both URL and API Key."; return; }
      out.style.display = "block";
      out.className = "loading";
      out.textContent = "Loading…";
      try {
        const r = await fetch("/info?url=" + encodeURIComponent(url) + "&key=" + encodeURIComponent(key));
        const data = await r.json();
        out.className = r.ok ? "" : "error";
        out.textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        out.className = "error";
        out.textContent = "Request failed: " + e.message;
      }
    }
  </script>
</body>
</html>`);
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
      "--format", fmtSelector,
      "--output", outFile,
      "--no-playlist",
      "--max-filesize", "200m",
      "--user-agent", "Mozilla/5.0",
      "--merge-output-format", "mp4",
    ];

    if (format === "mp3") {
      args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
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
      "--extract-audio", "--audio-format", "mp3",
      "--audio-quality", "0",
      "--output", outFile,
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
      url, "--format", "best[ext=mp4]/best",
      "--output", outFile,
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
      url, "--format", "best",
      "--output", outFile,
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
      url, "--format", "best",
      "--output", outFile,
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
      url, "--format", "best[ext=mp4]/best",
      "--output", outFile,
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
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Boss-Bot Download Server running on port ${PORT}`);
    console.log(`🔑 API Key: ${API_KEY}`);
  });
}

module.exports = app;

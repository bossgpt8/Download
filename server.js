/**
 * Boss-Bot Download Server
 * Deploy on Railway — uses a standalone yt-dlp binary plus ffmpeg
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
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "bossbot-download-key";
let cachedYoutubeDl;
let cachedYtDlpDownload;
const YT_DLP_DIR = path.join(__dirname, ".cache", "boss-download-server");
const LOCAL_YT_DLP = path.join(YT_DLP_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const DEFAULT_JS_RUNTIME = `node:${process.execPath}`;
const DEFAULT_COOKIES_PATH = path.join(os.tmpdir(), "yt-cookies.txt");
const KNOWN_YT_DLP_PATHS = process.platform === "win32"
  ? [
      "C:\\Program Files\\yt-dlp\\yt-dlp.exe",
      "C:\\Program Files (x86)\\yt-dlp\\yt-dlp.exe",
    ]
  : [
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      "/bin/yt-dlp",
      "/opt/homebrew/bin/yt-dlp",
    ];

function bootstrapCookiesFileFromEnv() {
  const cookiesB64 = process.env.YTDLP_COOKIES_B64;
  const cookiesText = process.env.YTDLP_COOKIES;
  const configuredPath = process.env.YTDLP_COOKIES_FILE || DEFAULT_COOKIES_PATH;

  if (!cookiesB64 && !cookiesText) {
    return;
  }

  const decodedCookies = cookiesB64
    ? Buffer.from(cookiesB64, "base64").toString("utf8")
    : cookiesText;

  if (!decodedCookies || !decodedCookies.includes("youtube.com")) {
    throw new Error("Invalid YouTube cookies payload in environment variables");
  }

  fs.mkdirSync(path.dirname(configuredPath), { recursive: true });
  fs.writeFileSync(configuredPath, decodedCookies, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(configuredPath, 0o600);
  process.env.YTDLP_COOKIES_FILE = configuredPath;
  console.log("YouTube cookies loaded from environment secret.");
}

bootstrapCookiesFileFromEnv();

function resolveYoutubeDlPath() {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;

  if (fs.existsSync(LOCAL_YT_DLP)) return LOCAL_YT_DLP;

  const discovered = findExecutableInPath(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp")
    || KNOWN_YT_DLP_PATHS.find((candidate) => isExecutableFile(candidate));
  if (discovered) return discovered;

  return "yt-dlp";
}

function getYoutubeDl() {
  if (!cachedYoutubeDl) cachedYoutubeDl = resolveYoutubeDlPath();
  return cachedYoutubeDl;
}

function getYtDlpReleaseUrl() {
  if (process.platform === "win32") {
    return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  }

  if (process.platform === "darwin") {
    return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  }

  if (process.platform === "linux") {
    if (process.arch === "x64" || process.arch === "amd64") {
      return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
    }

    if (process.arch === "arm64") {
      return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64";
    }
  }

  return null;
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const request = client.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        downloadFile(new URL(response.headers.location, url).toString(), destination)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download yt-dlp from ${url} (${response.statusCode})`));
        return;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(() => resolve(destination)));
      file.on("error", (error) => {
        file.destroy();
        reject(error);
      });
    });

    request.on("error", reject);
  });
}

function findExecutableInPath(executable) {
  const envPath = process.env.PATH || "";
  const pathEntries = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, executable);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExecutableFile(filePath) {
  if (process.platform === "win32") {
    if (!/\.(exe|cmd|bat|com)$/i.test(filePath)) return false;
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureYtDlpBinary() {
  const configuredPath = process.env.YT_DLP_PATH;
  if (configuredPath) {
    if (fs.existsSync(configuredPath)) return configuredPath;
    throw new Error(`YT_DLP_PATH is set but file was not found at: ${configuredPath}`);
  }

  if (fs.existsSync(LOCAL_YT_DLP)) {
    fs.chmodSync(LOCAL_YT_DLP, 0o755);
    return LOCAL_YT_DLP;
  }

  const discoveredBinary = resolveYoutubeDlPath();
  const hasDiscoveredBinary = discoveredBinary && discoveredBinary !== "yt-dlp";
  if (hasDiscoveredBinary) return discoveredBinary;

  const releaseUrl = getYtDlpReleaseUrl();
  if (!releaseUrl) {
    throw new Error("yt-dlp binary not found for this platform. Install yt-dlp or set YT_DLP_PATH.");
  }

  if (!cachedYtDlpDownload) {
    fs.mkdirSync(YT_DLP_DIR, { recursive: true });
    cachedYtDlpDownload = downloadFile(releaseUrl, LOCAL_YT_DLP)
      .then((binaryPath) => {
        fs.chmodSync(binaryPath, 0o755);
        return binaryPath;
      })
      .catch((error) => {
        cachedYtDlpDownload = null;
        throw error;
      });
  }

  return cachedYtDlpDownload;
}

function isMissingBinaryError(error, message) {
  const normalizedMessage = String(message || error?.message || "");
  return error?.code === "ENOENT"
    || /spawn\s+\S+\s+ENOENT/i.test(normalizedMessage)
    || /spawn\s+\S+\s+not\s+found/i.test(normalizedMessage)
    || /executable file not found/i.test(normalizedMessage)
    || /no such file or directory/i.test(normalizedMessage);
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    ensureYtDlpBinary()
      .then((binary) => {
        const runOnce = (bin, canRetry) => {
          const child = execFile(bin, args, { timeout: 120000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
              const message = stderr?.trim() || error.message || `yt-dlp execution failed for URL: ${args[0]}`;
              const missingBinary = isMissingBinaryError(error, message);
              if (canRetry && missingBinary) {
                cachedYtDlpDownload = null;
                ensureYtDlpBinary()
                  .then((freshBinary) => runOnce(freshBinary, false))
                  .catch(() => reject(new Error("yt-dlp binary not found. Download the standalone Linux binary or set YT_DLP_PATH to its path.")));
                return;
              }
              if (missingBinary) {
                reject(new Error("yt-dlp binary not found. Download the standalone Linux binary or set YT_DLP_PATH to its path."));
                return;
              }
              reject(new Error(`yt-dlp error: ${message}`));
              return;
            }

            resolve(stdout.trim());
          });

          // Log stderr for debugging even on success
          if (child.stderr) {
            child.stderr.on("data", (data) => {
              const msg = data.toString().trim();
              if (msg && !/^\[download\]|^\[info\]|^\[ffmpeg\]/i.test(msg)) {
                console.error(`[yt-dlp stderr] ${msg}`);
              }
            });
          }
        };

        runOnce(binary, true);
      })
      .catch(reject);
  });
}

function isYoutubeUrl(url) {
  return /(^|\/\/)(www\.)?(youtube\.com|youtu\.be)\//i.test(String(url || ""));
}

function addYoutubeOptions(args, options = {}) {
  args.push("--js-runtimes", options.jsRuntime || DEFAULT_JS_RUNTIME);

  const cookiesFile = options.cookiesFile || process.env.YTDLP_COOKIES_FILE;
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  }

  // Add YouTube extractor args to help bypass bot detection
  const extractorArgs = options.youtubeExtractorArgs || "youtube:player_client=web;player_skip=webpage,configs";
  args.push("--extractor-args", extractorArgs);
  args.push("--socket-timeout", options.socketTimeout || "30");

  if (options.impersonate) {
    args.push("--impersonate", options.impersonate);
  }

  return args;
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
function ytdlp(commandArgs, options = {}) {
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

  const buildArgs = (runOptions) => {
    const args = [];
    addYoutubeOptions(args, runOptions);
    args.push(url);

    for (const [key, value] of Object.entries(flags)) {
      const flag = `--${key}`;
      if (Array.isArray(value)) {
        for (const item of value) {
          args.push(flag);
          if (item !== true) args.push(String(item));
        }
        continue;
      }

      args.push(flag);
      if (value !== true) args.push(String(value));
    }

    return args;
  };

  // Non-cookie YouTube fallback strategy for bot-detection errors.
  if (isYoutubeUrl(url) && options.enableYoutubeFallback !== false) {
    const attempts = [
      {
        ...options,
        youtubeExtractorArgs: "youtube:player_client=web;player_skip=webpage,configs",
      },
      {
        ...options,
        youtubeExtractorArgs: "youtube:player_client=android,web;player_skip=webpage,configs",
        impersonate: "Chrome-131:Android-14",
      },
      {
        ...options,
        youtubeExtractorArgs: "youtube:player_client=mweb,web;player_skip=webpage,configs",
        impersonate: "Safari-18.4:Macos-15",
      },
    ];

    let attemptIndex = 0;
    const runAttempt = () => runYtDlp(buildArgs(attempts[attemptIndex])).catch((error) => {
      const message = String(error?.message || "");
      const isBotCheck = /sign in to confirm you're not a bot|use --cookies|http error 429/i.test(message);
      if (isBotCheck && attemptIndex < attempts.length - 1) {
        attemptIndex += 1;
        return runAttempt();
      }
      throw error;
    });

    return runAttempt();
  }

  return runYtDlp(buildArgs(options));
}

function lastNonEmptyLine(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
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
  endpoints: ["/download/youtube", "/download/audio", "/download/song", "/download/facebook", "/download/instagram", "/download/tiktok", "/download/twitter", "/info"],
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
      "--extractor-args", "youtube:player_client=web",
      "--socket-timeout", "30",
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
  const { url, quality = "best", format = "mp4", output = "video" } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const timestamp = Date.now();
  const outFile = path.join(TMP_DIR, `yt_${timestamp}.%(ext)s`);
  const wantsAudio = quality === "audio" || format === "mp3" || output === "audio";

  try {
    // Select format based on quality
    let fmtSelector = "best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best";
    if (wantsAudio) {
      fmtSelector = "bestaudio/best";
    } else if (quality === "360p") {
      fmtSelector = "best[height<=360][ext=mp4][vcodec!=none][acodec!=none]/best[height<=360][vcodec!=none][acodec!=none]/best[height<=360]";
    } else if (quality === "480p") {
      fmtSelector = "best[height<=480][ext=mp4][vcodec!=none][acodec!=none]/best[height<=480][vcodec!=none][acodec!=none]/best[height<=480]";
    } else if (quality === "720p") {
      fmtSelector = "best[height<=720][ext=mp4][vcodec!=none][acodec!=none]/best[height<=720][vcodec!=none][acodec!=none]/best[height<=720]";
    }

    const args = [
      url,
      "--format", fmtSelector,
      "--output", outFile,
      "--no-playlist",
      "--max-filesize", "200m",
      "--user-agent", "Mozilla/5.0",
      "--quiet",
      "--no-warnings",
    ];

    if (wantsAudio) {
      args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
    }

    await ytdlp(args);
    
    // Find the output file (fallback to directory scan)
    const files = fs.readdirSync(TMP_DIR);
    const timeWindow = timestamp.toString().slice(0, -3);
    const outputFiles = files.filter(f => f.startsWith("yt_") && f.includes(timeWindow));
    
    let finalPath = null;
    if (outputFiles.length > 0) {
      // Get the most recent file
      const newest = outputFiles
        .map(f => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
      finalPath = path.join(TMP_DIR, newest.f);
    }

    if (!finalPath || !fs.existsSync(finalPath)) {
      return res.status(500).json({ error: "Output file not found after download" });
    }

    const ext = path.extname(finalPath).slice(1) || (wantsAudio ? "mp3" : "mp4");
    const mime = wantsAudio || ext === "mp3" ? "audio/mpeg" : "video/mp4";
    const downloadName = wantsAudio ? "audio.mp3" : `video.${ext}`;
    streamAndDelete(finalPath, res, downloadName, mime);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function handleAudioDownload(req, res) {
  const { url, query, q, text, song, title } = req.body || {};
  const rawInput = (url || query || q || text || song || title || "").toString().trim();
  if (!rawInput) {
    return res.status(400).json({ error: "url or search query is required" });
  }

  const isLikelyUrl = /^https?:\/\//i.test(rawInput);
  const mediaInput = isLikelyUrl ? rawInput : `ytsearch1:${rawInput}`;

  const timestamp = Date.now();
  const outFile = path.join(TMP_DIR, `audio_${timestamp}.mp3`);

  try {
    await ytdlp([
      mediaInput,
      "--extract-audio", "--audio-format", "mp3",
      "--audio-quality", "0",
      "--output", outFile,
      "--no-playlist",
      "--max-filesize", "50m",
      "--user-agent", "Mozilla/5.0",
      "--quiet",
      "--no-warnings",
      "--print", "after_move:filepath",
    ]);

    if (fs.existsSync(outFile)) {
      return streamAndDelete(outFile, res, "audio.mp3", "audio/mpeg");
    }

    // Find the output file
    const files = fs.readdirSync(TMP_DIR);
    const timeWindow = timestamp.toString().slice(0, -3);
    const outputFiles = files.filter(f => f.startsWith("audio_") && f.includes(timeWindow));
    
    let finalPath = null;
    if (outputFiles.length > 0) {
      const newest = outputFiles
        .map(f => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)[0];
      finalPath = path.join(TMP_DIR, newest.f);
    }

    if (!finalPath || !fs.existsSync(finalPath)) {
      return res.status(500).json({ error: "Audio extraction failed - file not found" });
    }

    streamAndDelete(finalPath, res, "audio.mp3", "audio/mpeg");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── POST /download/audio — extract audio as MP3 from any URL ─────────────────
app.post("/download/audio", auth, handleAudioDownload);

// ── POST /download/song — compatibility alias for bots expecting /song ───────
app.post("/download/song", auth, handleAudioDownload);

// ── POST /download/facebook ───────────────────────────────────────────────────
app.post("/download/facebook", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const timestamp = Date.now();
  const outFile = path.join(TMP_DIR, `fb_${timestamp}.%(ext)s`);

  try {
    await ytdlp([
      url, "--format", "best[ext=mp4]/best",
      "--output", outFile,
      "--no-playlist",
      "--max-filesize", "100m",
      "--quiet",
      "--no-warnings",
    ]);

    // Find the output file  
    const files = fs.readdirSync(TMP_DIR);
    const timeWindow = timestamp.toString().slice(0, -3);
    const outputFiles = files.filter(f => f.startsWith("fb_") && f.includes(timeWindow));
    
    if (outputFiles.length === 0) {
      return res.status(500).json({ error: "Facebook video download failed - file not created" });
    }

    const newest = outputFiles
      .map(f => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    const finalPath = path.join(TMP_DIR, newest.f);

    streamAndDelete(finalPath, res, "facebook_video.mp4", "video/mp4");
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /download/instagram ──────────────────────────────────────────────────
app.post("/download/instagram", auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const timestamp = Date.now();
  const outFile = path.join(TMP_DIR, `ig_${timestamp}.%(ext)s`);

  try {
    await ytdlp([
      url, "--format", "best",
      "--output", outFile,
      "--no-playlist",
      "--max-filesize", "100m",
      "--quiet",
      "--no-warnings",
    ]);

    // Find the output file
    const files = fs.readdirSync(TMP_DIR);
    const timeWindow = timestamp.toString().slice(0, -3);
    const outputFiles = files.filter(f => f.startsWith("ig_") && f.includes(timeWindow));
    
    if (outputFiles.length === 0) {
      return res.status(500).json({ error: "Instagram video download failed - file not created" });
    }

    const newest = outputFiles
      .map(f => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
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

  const timestamp = Date.now();
  const outFile = path.join(TMP_DIR, `tt_${timestamp}.%(ext)s`);

  try {
    await ytdlp([
      url, "--format", "best",
      "--output", outFile,
      "--no-playlist",
      "--max-filesize", "100m",
      "--quiet",
      "--no-warnings",
    ]);

    // Find the output file
    const files = fs.readdirSync(TMP_DIR);
    const timeWindow = timestamp.toString().slice(0, -3);
    const outputFiles = files.filter(f => f.startsWith("tt_") && f.includes(timeWindow));
    
    if (outputFiles.length === 0) {
      return res.status(500).json({ error: "TikTok video download failed - file not created" });
    }

    const newest = outputFiles
      .map(f => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
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

  const timestamp = Date.now();
  const outFile = path.join(TMP_DIR, `tw_${timestamp}.%(ext)s`);

  try {
    await ytdlp([
      url, "--format", "best[ext=mp4]/best",
      "--output", outFile,
      "--no-playlist",
      "--max-filesize", "100m",
      "--quiet",
      "--no-warnings",
    ]);

    // Find the output file
    const files = fs.readdirSync(TMP_DIR);
    const timeWindow = timestamp.toString().slice(0, -3);
    const outputFiles = files.filter(f => f.startsWith("tw_") && f.includes(timeWindow));
    
    if (outputFiles.length === 0) {
      return res.status(500).json({ error: "Twitter video download failed - file not created" });
    }

    const newest = outputFiles
      .map(f => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
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
module.exports.__test__ = { isMissingBinaryError, findExecutableInPath };

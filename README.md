# Boss-Bot Download Server

A dedicated media download server powered by `yt-dlp` and `ffmpeg`.
Deploy on Railway — which natively supports these tools via Nix.

## Deploy on Railway

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Boss-Bot download server"
git remote add origin https://github.com/YOUR_USERNAME/boss-download-server.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to https://railway.app
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `boss-download-server` repo
4. Railway auto-detects `nixpacks.toml` and installs `yt-dlp` + `ffmpeg`
5. Go to **Variables** tab and add:
   ```
   API_KEY = some-secret-key-you-choose
   PORT    = 3000
   ```
6. Click **Deploy** — takes ~2 minutes

### Step 3 — Get your URL
Railway gives you a URL like:
```
https://boss-download-server-production.up.railway.app
```

### Step 4 — Add to Boss-Bot ecosystem.config.cjs
```js
DOWNLOAD_SERVER_URL: "https://boss-download-server-production.up.railway.app",
DOWNLOAD_SERVER_KEY: "your-api-key-here",
```

## API Endpoints

### Health Check
```
GET /
```

### Get Video Info (no download)
```
GET /info?url=https://youtube.com/watch?v=xxx&key=YOUR_KEY
```

### Download YouTube Video
```
POST /download/youtube
Headers: x-api-key: YOUR_KEY
Body: { "url": "https://youtube.com/...", "quality": "720p" }
quality options: "best", "720p", "480p", "360p", "audio"
```

### Download Audio (MP3)
```
POST /download/audio
Headers: x-api-key: YOUR_KEY
Body: { "url": "https://youtube.com/..." }
```

### Download Social Media
```
POST /download/facebook   { "url": "..." }
POST /download/instagram  { "url": "..." }
POST /download/tiktok     { "url": "..." }
POST /download/twitter    { "url": "..." }
```

## Railway Free Tier Limits
- 512MB RAM
- $5 free credit/month (enough for ~500 downloads)
- Auto-sleeps after inactivity (wakes in ~2 seconds)

## Why Railway works (vs other platforms)
- **Railway** = real Linux container with Nix → yt-dlp + ffmpeg install natively ✅
- **Vercel** = serverless, no system packages, 10s timeout ❌
- **Render** = works but slower cold starts
- **Heroku** = works with buildpacks but costs money

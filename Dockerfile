FROM node:20-slim

# Install ffmpeg, curl, and ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install yt-dlp binary
RUN set -e; \
    case "$(uname -m)" in \
      aarch64|arm64) ASSET=yt-dlp_linux_aarch64 ;; \
      x86_64|amd64)  ASSET=yt-dlp_linux ;; \
      *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;; \
    esac; \
    for attempt in 1 2 3; do \
      curl -L --max-time 60 --connect-timeout 10 --retry 3 --retry-delay 2 \
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}" \
        -o /usr/local/bin/yt-dlp && break \
      || (echo "Attempt $attempt/3 failed, retrying..."; sleep 5); \
    done; \
    chmod +x /usr/local/bin/yt-dlp; \
    yt-dlp --version

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]

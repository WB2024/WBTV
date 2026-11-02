FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl fonts-dejavu-core \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

# Piper: offline neural text-to-speech for the "coming up next" announcements (engine + two British voices)
RUN mkdir -p /opt/piper/voices \
 && curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz | tar -xz -C /opt \
 && cd /opt/piper/voices \
 && for v in en/en_GB/alan/medium/en_GB-alan-medium en/en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium; do \
      for ext in onnx onnx.json; do curl -fsSL -O "https://huggingface.co/rhasspy/piper-voices/resolve/main/$v.$ext"; done; \
    done \
 && ls -la /opt/piper/voices

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    WBTV_CONFIG=/config \
    WBTV_TMP=/tmp/wbtv \
    WBTV_BROWSE_ROOTS=/mnt,/media,/data

VOLUME /config
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/scan').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

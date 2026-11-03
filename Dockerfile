FROM node:24-trixie-slim

# BuildKit sets TARGETARCH (amd64 or arm64) for multi-arch builds
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl fonts-dejavu-core mesa-va-drivers vainfo \
 && if [ "${TARGETARCH:-amd64}" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver i965-va-driver; fi \
 && if [ "$TARGETARCH" = "arm64" ]; then YT=yt-dlp_linux_aarch64; else YT=yt-dlp_linux; fi \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT" -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

# Piper: offline neural text-to-speech for the "coming up next" announcements (engine + two British voices)
RUN if [ "$TARGETARCH" = "arm64" ]; then PA=aarch64; else PA=x86_64; fi \
 && mkdir -p /opt/piper/voices \
 && curl -fsSL "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_$PA.tar.gz" | tar -xz -C /opt \
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
COPY tools ./tools

ENV NODE_ENV=production \
    PORT=8080 \
    WBTV_CONFIG=/config \
    WBTV_TMP=/tmp/wbtv \
    WBTV_BROWSE_ROOTS=/mnt,/media,/data

VOLUME /config
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]

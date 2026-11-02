import path from 'node:path';
const env = process.env;
export const cfg = {
  port: Number(env.PORT || 8080),
  configDir: env.WBTV_CONFIG || '/config',
  tmpDir: env.WBTV_TMP || '/tmp/wbtv',
  browseRoots: (env.WBTV_BROWSE_ROOTS || '/mnt,/media').split(',').map((s) => path.resolve(s.trim())).filter(Boolean),
  width: Number(env.WBTV_WIDTH || 1280),
  height: Number(env.WBTV_HEIGHT || 720),
  crf: Number(env.WBTV_CRF || 23),
  preset: env.WBTV_PRESET || 'veryfast',
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: env.FFPROBE_PATH || 'ffprobe',
  ytdlp: env.YTDLP_PATH || 'yt-dlp',
  scanConcurrency: Number(env.WBTV_SCAN_CONCURRENCY || 24),
};

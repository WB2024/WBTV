// "Is this a real music video, or an album cover with the audio played over it?"
// Two cheap checks that run before a download is kept:
//   1. what YouTube says about the upload (an auto-generated "- Topic" channel, "Provided to YouTube by ...", or a title that says lyrics / audio /
//      visualizer / full album and does not claim to be the official video) -- checked from the video's metadata, before downloading;
//   2. what the picture does: sample the middle of the file at a low resolution and count how often consecutive frames differ.
//      A still image (or a slideshow that changes every few seconds) is almost always identical frame to frame; a real video is not.
// Neither is perfect (a lyric video with moving text has motion; a very static art film looks still), so a download that fails a check is
// reported with the reason and can be kept anyway.
import { spawn } from 'node:child_process';
import { cfg } from './config.js';

const W = 64, H = 36, FPS = 2, SECONDS = 24;

/** Judge an upload from its yt-dlp metadata ({ title, channel, uploader, description, categories }). Returns a reason string, or null when it looks fine. */
export function judgeUpload(info = {}) {
  const title = String(info.title || ''), channel = String(info.channel || info.uploader || ''), desc = String(info.description || '');
  if (/ - topic$/i.test(channel) || /^provided to youtube by/i.test(desc.trim())) return 'an auto-generated audio upload (YouTube "Topic" channel), not a music video';
  const claimsVideo = /\b(official\s+(music\s+)?video|music\s+video|official\s+hd\s+video)\b/i.test(title);
  if (/\b(full\s+album|album\s+stream)\b/i.test(title)) return 'a full-album upload';
  if (!claimsVideo && /\b(lyrics?|lyric\s+video|audio|visuali[sz]er|official\s+audio|album\s+version)\b/i.test(title)) return 'a lyric / audio upload, not a music video';
  return null;
}

/** How much of the picture changes: the fraction of sampled frame pairs that differ noticeably, from a window in the middle of the video. */
export function motionOf(file, { ffmpeg = cfg.ffmpeg, start = null, duration = null } = {}) {
  return new Promise((resolve, reject) => {
    const sample = (ss) => new Promise((res, rej) => {
      const args = ['-v', 'error', '-nostdin', ...(ss > 0 ? ['-ss', String(ss)] : []), '-i', file, '-t', String(SECONDS), '-an', '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'];
      const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      p.stdout.on('data', (d) => chunks.push(d));
      p.on('error', rej);
      p.on('close', () => res(Buffer.concat(chunks)));
      setTimeout(() => p.kill('SIGKILL'), 60000);
    });
    const probe = spawn(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    probe.stdout.on('data', (d) => (out += d));
    probe.on('error', reject);
    probe.on('close', async () => {
      try {
        const dur = parseFloat(out) || 0;
        const ss = start ?? Math.max(0, Math.min(dur * 0.3, Math.max(0, dur - SECONDS - 2)));
        const raw = await sample(ss);
        const size = W * H, n = Math.floor(raw.length / size);
        if (n < 6) return resolve({ frames: n, changing: 0, fraction: 1, unknown: true }); // too little to judge: do not reject
        let changing = 0;
        for (let i = 1; i < n; i++) {
          let sum = 0;
          for (let k = 0; k < size; k++) sum += Math.abs(raw[i * size + k] - raw[(i - 1) * size + k]);
          if (sum / size > 1.2) changing++; // mean difference of more than about 1 grey level: compression noise is well below this
        }
        resolve({ frames: n, changing, fraction: changing / (n - 1) });
      } catch (e) { reject(e); }
    });
  });
}

/** true when the file is (almost certainly) a still image with sound, or a slow slideshow. */
export async function looksStill(file, opt) {
  const m = await motionOf(file, opt).catch(() => ({ unknown: true, fraction: 1 }));
  return { still: !m.unknown && m.fraction < 0.12, ...m };
}

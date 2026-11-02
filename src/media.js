import { spawn } from 'node:child_process';
import { cfg } from './config.js';

export function run(cmd, args, { timeout = 0 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const t = timeout ? setTimeout(() => p.kill('SIGKILL'), timeout) : null;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', (e) => { if (t) clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    p.on('close', (code) => { if (t) clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** -> { duration, hasAudio } or null when the file is unreadable */
export async function probe(file) {
  const r = await run(cfg.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { timeout: 30000 });
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.out);
    const duration = parseFloat(j.format?.duration);
    return { duration: Number.isFinite(duration) ? duration : 0, hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio') };
  } catch { return null; }
}

/** Background fill-in of durations for items whose NFO had no durationinseconds. */
export async function probePending(db, onProgress) {
  const rows = db.prepare('SELECT id,path FROM items WHERE probed=0').all();
  let i = 0, done = 0;
  const upd = db.prepare('UPDATE items SET runtime=?, probed=? WHERE id=?');
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < rows.length) {
      const r = rows[i++];
      const p = await probe(r.path);
      if (p && p.duration > 0) upd.run(p.duration, 1, r.id); else upd.run(0, 2, r.id);
      onProgress?.(++done, rows.length);
    }
  }));
}

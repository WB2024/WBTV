// Optional per-channel logos, stored in <config>/logos/<channelId>.(png|jpg|webp)
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';

const EXTS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const dir = () => path.join(cfg.configDir, 'logos');

export function logoFile(id) {
  for (const ext of Object.values(EXTS)) {
    const f = path.join(dir(), `${Number(id)}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
export function removeLogo(id) {
  for (const ext of Object.values(EXTS)) fs.rmSync(path.join(dir(), `${Number(id)}.${ext}`), { force: true });
}
/** Returns false if the content type is not an accepted image. */
export function saveLogo(id, buf, contentType) {
  const ext = EXTS[String(contentType || '').split(';')[0].trim()];
  if (!ext || !buf?.length) return false;
  fs.mkdirSync(dir(), { recursive: true });
  removeLogo(id);
  fs.writeFileSync(path.join(dir(), `${Number(id)}.${ext}`), buf);
  return true;
}

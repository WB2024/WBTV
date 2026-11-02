import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { run, probe } from './media.js';
import { LEAD_IN, SEG_GAP } from './promo.js';

/**
 * Local text-to-speech with Piper (offline, free). Announcements are synthesised just in time and cached,
 * so we only ever pay for the ones that actually air on a channel somebody is watching.
 */

export const VOICES = {
  alan: { file: 'en_GB-alan-medium.onnx', label: 'Alan (British, male)' },
  jenny: { file: 'en_GB-jenny_dioco-medium.onnx', label: 'Jenny (British, female)' },
};

const cacheDir = () => path.join(cfg.configDir, 'tts');
const voicePath = (id) => path.join(cfg.voiceDir, (VOICES[id] || VOICES.alan).file);

export function ttsStatus() {
  const available = fs.existsSync(cfg.piperBin);
  return {
    available,
    voices: Object.entries(VOICES).map(([id, v]) => ({ id, label: v.label, installed: available && fs.existsSync(voicePath(id)) })),
  };
}
export const ttsReady = (voice) => fs.existsSync(cfg.piperBin) && fs.existsSync(voicePath(voice));

// at most two Piper processes at once
let active = 0;
const waiting = [];
const slot = () => new Promise((res) => { if (active < 2) { active++; res(); } else waiting.push(res); });
const release = () => { const n = waiting.shift(); if (n) n(); else active--; };

function piper(text, voice, outFile) {
  return new Promise((resolve, reject) => {
    const p = spawn(cfg.piperBin, ['--model', voicePath(voice), '--output_file', outFile, '--length_scale', '1.05', '--sentence_silence', '0.2'],
      { stdio: ['pipe', 'ignore', 'pipe'], cwd: path.dirname(cfg.piperBin) });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-500)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && fs.existsSync(outFile) ? resolve() : reject(new Error(`piper exit ${code}: ${err}`))));
    p.stdin.end(text + '\n');
  });
}

/** One sentence of speech -> wav file (cached by content). */
async function synth(text, voice) {
  const key = crypto.createHash('sha1').update(`${voice}|1.05|${text}`).digest('hex');
  fs.mkdirSync(cacheDir(), { recursive: true });
  const file = path.join(cacheDir(), `s_${key}.wav`);
  if (fs.existsSync(file)) return file;
  await slot();
  try {
    if (!fs.existsSync(file)) { const tmp = file + '.tmp.wav'; await piper(text, voice, tmp); fs.renameSync(tmp, file); }
  } finally { release(); }
  return file;
}

const inflight = new Map();

/**
 * Narration for one announcement -> { file, dur, cues:[{label,title,start,end}] } (cues are seconds from the start).
 * Returns null if speech isn't available; callers then play the picture without a voice.
 */
export function prepare(promoId, segments, voice) {
  if (!ttsReady(voice)) return Promise.resolve(null);
  const key = crypto.createHash('sha1').update(`${voice}|${JSON.stringify(segments.map((s) => s.text))}`).digest('hex');
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const meta = path.join(cacheDir(), `p_${key}.json`);
    if (fs.existsSync(meta)) { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); if (fs.existsSync(m.file)) return m; }
    const wavs = await Promise.all(segments.map((s) => synth(s.text, voice)));
    const durs = await Promise.all(wavs.map(async (w) => (await probe(w))?.duration || 0));
    const out = path.join(cacheDir(), `p_${key}.wav`);
    // lead-in silence, then each announcement followed by a short pause
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    wavs.forEach((w) => args.push('-i', w));
    const chains = wavs.map((_, i) => {
      const pre = i === 0 ? `adelay=${Math.round(LEAD_IN * 1000)}:all=1,` : '';
      return `[${i}:a]aresample=22050,${pre}apad=pad_dur=${i < wavs.length - 1 ? SEG_GAP : 0.6}[a${i}]`;
    });
    const filter = chains.join(';') + ';' + wavs.map((_, i) => `[a${i}]`).join('') + `concat=n=${wavs.length}:v=0:a=1[out]`;
    args.push('-filter_complex', filter, '-map', '[out]', out);
    const r = await run(cfg.ffmpeg, args, { timeout: 60000 });
    if (r.code !== 0) throw new Error('narration mix failed: ' + r.err);
    let t = LEAD_IN;
    const cues = segments.map((s, i) => {
      const start = t;
      t += durs[i] + (i < wavs.length - 1 ? SEG_GAP : 0.6);
      return { label: s.label, title: s.title, start, end: t };
    });
    const m = { file: out, dur: t, cues };
    fs.writeFileSync(meta, JSON.stringify(m));
    return m;
  })().finally(() => setTimeout(() => inflight.delete(key), 60000));
  inflight.set(key, job);
  return job;
}

/** For the Settings page: a short sample in the chosen voice. */
export async function sample(voice) {
  if (!ttsReady(voice)) return null;
  return synth("Up next on W B T V is your favourite show. After that, something you've been meaning to watch.", voice);
}

/** Drop cached speech nobody has asked for in a few days. */
export function pruneCache(maxAgeDays = 3) {
  try {
    const cut = Date.now() - maxAgeDays * 86400000;
    for (const f of fs.readdirSync(cacheDir())) {
      const p = path.join(cacheDir(), f);
      if (fs.statSync(p).mtimeMs < cut) fs.rmSync(p, { force: true });
    }
  } catch { /* no cache yet */ }
}

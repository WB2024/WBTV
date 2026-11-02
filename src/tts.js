import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { run, probe } from './media.js';
import { Readable } from 'node:stream';
import { LEAD_IN, SEG_GAP, WORDS_PER_SECOND } from './promo.js';
import { speakable } from './speech.js';

/**
 * Local text-to-speech with Piper (offline, free). Announcements are synthesised just in time and cached,
 * so we only ever pay for the ones that actually air on a channel somebody is watching.
 */

export const VOICES = {
  alan: { file: 'en_GB-alan-medium.onnx', label: 'Alan (British, male)' },
  jenny: { file: 'en_GB-jenny_dioco-medium.onnx', label: 'Jenny (British, female)' },
  // installed on demand from Settings (a one-off download kept in /config/voices); higher quality voices are bigger and a little slower
  cori: { file: 'en_GB-cori-high.onnx', label: 'Cori (British, female, high quality)', hf: 'en/en_GB/cori/high/en_GB-cori-high', mb: 114 },
  northern: { file: 'en_GB-northern_english_male-medium.onnx', label: 'Northern English (male)', hf: 'en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium', mb: 63 },
  alba: { file: 'en_GB-alba-medium.onnx', label: 'Alba (Scottish, female)', hf: 'en/en_GB/alba/medium/en_GB-alba-medium', mb: 63 },
  ryan: { file: 'en_US-ryan-high.onnx', label: 'Ryan (American, male, high quality)', hf: 'en/en_US/ryan/high/en_US-ryan-high', mb: 121 },
  lessac: { file: 'en_US-lessac-high.onnx', label: 'Lessac (American, female, high quality)', hf: 'en/en_US/lessac/high/en_US-lessac-high', mb: 114 },
};

const cacheDir = () => path.join(cfg.configDir, 'tts');
const userVoiceDir = () => path.join(cfg.configDir, 'voices');
/** Where a voice's model lives: our own downloads first, then the ones baked into the image. */
const voicePath = (id) => {
  const file = (VOICES[id] || VOICES.alan).file;
  const mine = path.join(userVoiceDir(), file);
  return fs.existsSync(mine) ? mine : path.join(cfg.voiceDir, file);
};
const voiceInstalled = (id) => fs.existsSync(voicePath(id));

export function ttsStatus() {
  const available = fs.existsSync(cfg.piperBin);
  return {
    available,
    voices: Object.entries(VOICES).map(([id, v]) => ({ id, label: v.label, installed: available && voiceInstalled(id), installable: !!v.hf && !voiceInstalled(id), mb: v.mb || 0, installing: installing.has(id), error: installErrors.get(id) || '' })),
  };
}
export const ttsReady = (voice) => fs.existsSync(cfg.piperBin) && voiceInstalled(voice);

/** Words per second this voice really speaks at (measured when installed, with a safety margin); the announcement slot is sized from it. */
export function voiceSpeed(id) {
  try { const v = JSON.parse(fs.readFileSync(path.join(userVoiceDir(), (VOICES[id] || VOICES.alan).file + '.speed'), 'utf8')); if (v.wps > 0.8 && v.wps < 4) return v.wps; } catch { /* baked-in voices use the default */ }
  return WORDS_PER_SECOND;
}

const installing = new Set();
const installErrors = new Map();
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status}) for ${path.basename(url)}`);
  const tmp = dest + '.part';
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    Readable.fromWeb(r.body).pipe(out).on('finish', resolve).on('error', reject);
  });
  fs.renameSync(tmp, dest);
}

/** Download a catalogue voice (model + config) into /config/voices, then time it so slots are sized right. */
export async function installVoice(id) {
  const v = VOICES[id];
  if (!v?.hf) throw new Error('unknown voice');
  if (voiceInstalled(id)) return;
  if (installing.has(id)) throw new Error('already installing');
  installing.add(id); installErrors.delete(id);
  try {
    fs.mkdirSync(userVoiceDir(), { recursive: true });
    const model = path.join(userVoiceDir(), v.file);
    await download(HF + v.hf + '.onnx.json', model + '.json');
    await download(HF + v.hf + '.onnx', model);
    // measure its pace on a typical announcement
    const sample = 'Up next on this channel is a comedy series about a group of friends, who share a house, and a great many misadventures. After that, it is the evening news.';
    const tmp = path.join(userVoiceDir(), `speed_${id}.wav`);
    await piper(speakable(sample), id, tmp);
    const dur = (await probe(tmp))?.duration || 0;
    fs.rmSync(tmp, { force: true });
    const wps = dur > 1 ? (sample.split(/\s+/).length / dur) * 0.9 : WORDS_PER_SECOND;
    fs.writeFileSync(model + '.speed', JSON.stringify({ wps: Number(wps.toFixed(3)), measured: Date.now() }));
  } catch (e) {
    for (const f of [v.file, v.file + '.json', v.file + '.part', v.file + '.json.part']) fs.rmSync(path.join(userVoiceDir(), f), { force: true });
    installErrors.set(id, e.message);
    throw e;
  } finally { installing.delete(id); }
}

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
async function synth(raw, voice) {
  const text = speakable(raw); // numbers, years, abbreviations and punctuation the way a person would say them
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
const narrationKey = (segments, voice) => crypto.createHash('sha1').update(`${voice}|${JSON.stringify(segments.map((s) => speakable(s.text)))}`).digest('hex');

/** The narration if it has already been generated (no synthesis, returns immediately); otherwise null. */
export function cached(segments, voice) {
  try {
    const meta = path.join(cacheDir(), `p_${narrationKey(segments, voice)}.json`);
    if (!fs.existsSync(meta)) return null;
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return fs.existsSync(m.file) ? m : null;
  } catch { return null; }
}

/**
 * Narration for one announcement -> { file, dur, cues:[{label,title,start,end}] } (cues are seconds from the start).
 * Returns null if speech isn't available; callers then play the picture without a voice.
 */
export function prepare(promoId, segments, voice) {
  if (!ttsReady(voice)) return Promise.resolve(null);
  const key = narrationKey(segments, voice);
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
  return synth("Up next on W B T V, a classic from 1984. After that, it's Doctor Who, season 3, at 9pm.", voice);
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

// The repair step: rename and move music videos into  <Artist>/<Artist> - <Title>.<ext>, write a clean .nfo for each, and move extra copies of the
// same song aside (never delete). Every change is recorded in an undo log, and every .nfo that is replaced is backed up first.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileSafe, norm, readNfo } from './mvlib.mjs';

const HIDDEN_DUP = '.duplicates';   // hidden, so WBTV (and most media servers) skip it
const HIDDEN_LOG = '.mvtool';
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SIDECAR = /^(.*?)(\.nfo|-poster\.(jpg|jpeg|png)|-thumb\.(jpg|jpeg|png)|-fanart\.(jpg|jpeg|png)|-clearlogo\.(jpg|jpeg|png)|\.(srt|ass|vtt|lrc))$/i;

/** How good is this copy? Resolution first, then bit rate, then a friendlier container. */
export function quality(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height,bit_rate', '-show_entries', 'format=bit_rate', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
  let j = {};
  try { j = JSON.parse(r.stdout); } catch { /* unreadable: scores low */ }
  const height = Number(j.streams?.[0]?.height) || 0, bitrate = Number(j.streams?.[0]?.bit_rate || j.format?.bit_rate) || 0;
  const container = { '.mp4': 3, '.mkv': 3, '.m4v': 2, '.webm': 2, '.avi': 1 }[path.extname(file).toLowerCase()] ?? 0;
  return { height, bitrate, score: height * 100 + Math.min(bitrate / 1000, 20000) / 10 + container * 5 };
}

const sidecarsOf = (abs) => {
  const dir = path.dirname(abs), base = path.parse(abs).name;
  return fs.readdirSync(dir).filter((n) => { const m = SIDECAR.exec(n); return m && m[1] === base; }).map((n) => ({ abs: path.join(dir, n), suffix: n.slice(base.length) }));
};

/** Build the plan from the audit rows. Nothing is touched. */
export function plan(rows, root, { quality: q = quality } = {}) {
  rows = rows.filter((r) => !r.skip);
  const groups = new Map();
  for (const r of rows) { const k = `${norm(r.artist)}|${slug(r.title)}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  const keep = [], dups = [];
  for (const g of groups.values()) {
    if (g.length === 1) { keep.push(g[0]); continue; }
    const scored = g.map((r) => ({ r, q: q(r.abs) })).sort((a, b) => b.q.score - a.q.score || a.r.file.length - b.r.file.length);
    keep.push(scored[0].r);
    for (const s of scored.slice(1)) dups.push({ r: s.r, q: s.q, of: scored[0].r, bestQ: scored[0].q });
  }
  const moves = [], nfos = [], taken = new Set();
  // pictures and .nfo files that belong to a kept copy: an .mp4 and an .mpg of one song share them, and the kept copy keeps them
  const claimed = new Set(keep.flatMap((r) => sidecarsOf(r.abs).map((x) => x.abs)));
  const claim = (target) => { let t = target, n = 2; while (taken.has(t.toLowerCase())) { const p = path.parse(target); t = path.join(p.dir, `${p.name} (${n++})${p.ext}`); } taken.add(t.toLowerCase()); return t; };
  for (const r of keep) {
    const ext = path.extname(r.abs);
    const dir = path.join(root, fileSafe(r.artist));
    const target = claim(path.join(dir, fileSafe(`${r.artist} - ${r.title}`) + ext));
    const newBase = path.parse(target).name;
    const sc = sidecarsOf(r.abs);
    if (target !== r.abs) moves.push({ from: r.abs, to: target, kind: 'video' });
    for (const s of sc) { const to = path.join(dir, newBase + s.suffix); if (to !== s.abs) moves.push({ from: s.abs, to, kind: 'sidecar' }); }
    const oldNfo = sc.find((s) => s.suffix.toLowerCase() === '.nfo')?.abs || null;
    const old = oldNfo ? readNfo(fs.readFileSync(oldNfo, 'utf8')) : null;
    nfos.push({ video: target, path: path.join(dir, newBase + '.nfo'), oldPath: oldNfo, content: nfoXml(r, old) });
  }
  // the extra copies go first: the names they occupy (a poster called "Artist - Title-poster.jpg") are the names the kept copy is about to take
  const dupMoves = [], queued = new Set();
  for (const d of dups) {
    const sc = sidecarsOf(d.r.abs).filter((s) => !claimed.has(s.abs) && !queued.has(s.abs)); // a shared sidecar is moved once, and never taken from the kept copy
    for (const s of sc) queued.add(s.abs);
    const dir = path.join(root, HIDDEN_DUP, path.dirname(path.relative(root, d.r.abs)));
    dupMoves.push({ from: d.r.abs, to: path.join(dir, path.basename(d.r.abs)), kind: 'duplicate' });
    for (const s of sc) dupMoves.push({ from: s.abs, to: path.join(dir, path.basename(s.abs)), kind: 'duplicate' });
  }
  return { moves: [...dupMoves, ...moves], nfos, dups, kept: keep.length };
}

/** A clean Kodi / Jellyfin / WBTV <musicvideo> .nfo. The year is only written when it is a real release year. */
export function nfoXml(r, old) {
  const lines = ['<?xml version="1.0" encoding="utf-8" standalone="yes"?>', '<musicvideo>', `  <title>${x(r.title)}</title>`, `  <artist>${x(r.artist)}</artist>`];
  if (old?.album) lines.push(`  <album>${x(old.album)}</album>`);
  if (r.year) lines.push(`  <year>${r.year}</year>`);
  for (const g of r.genres || []) lines.push(`  <genre>${x(g)}</genre>`);
  if (old?.plot) lines.push(`  <plot>${x(old.plot)}</plot>`);
  if (r.director) lines.push(`  <director>${x(r.director)}</director>`);
  if (r.imvdb) lines.push(`  <uniqueid type="imvdb">${x(r.imvdb)}</uniqueid>`);
  if (old?.added) lines.push(`  <dateadded>${x(old.added)}</dateadded>`);
  lines.push('  <lockdata>true</lockdata>', '</musicvideo>', '');
  return lines.join('\n');
}

const same = (from, to) => { // copy the owner and permissions of a neighbour, so files made by this tool look like the rest
  try { const st = fs.statSync(from); fs.chownSync(to, st.uid, st.gid); fs.chmodSync(to, st.mode & 0o777); } catch { /* not allowed on this file system: fine */ }
};
const mkdirs = (dir, like) => { if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); same(like, dir); } };

/** Carry the plan out. Writes the undo log first and appends to it, so a half-finished run can still be undone. */
/** Walk through every move in memory first: if any would collide or its source is missing, nothing at all is changed. */
export function preflight(p) {
  const state = new Map(); // path -> exists now (after the moves so far)
  const has = (f) => (state.has(f) ? state.get(f) : fs.existsSync(f));
  for (const m of p.moves) {
    if (!has(m.from)) throw new Error(`pre-flight: ${m.from} is not there (moved twice?)`);
    if (has(m.to)) throw new Error(`pre-flight: ${m.to} already exists`);
    state.set(m.from, false); state.set(m.to, true);
  }
}

export function apply(p, root) {
  preflight(p);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(root, HIDDEN_LOG, stamp);
  fs.mkdirSync(path.join(logDir, 'nfo'), { recursive: true });
  const logFile = path.join(logDir, 'undo.json');
  const log = { root, stamp, moves: [], nfos: [] };
  const save = () => fs.writeFileSync(logFile, JSON.stringify(log, null, 1));
  save();
  let i = 0;
  const backup = (file) => { if (!fs.existsSync(file)) return null; const b = path.join(logDir, 'nfo', `${i++}.nfo`); fs.copyFileSync(file, b); return b; };
  // back up every .nfo that will be replaced or moved, before anything changes
  for (const n of p.nfos) {
    const targets = [...new Set([n.path, n.oldPath].filter(Boolean))].filter((f) => fs.existsSync(f));
    log.nfos.push({ path: n.path, oldPath: n.oldPath, backups: targets.map((f) => ({ file: f, backup: backup(f) })), existedBefore: fs.existsSync(n.path) });
  }
  save();
  for (const m of p.moves) {
    mkdirs(path.dirname(m.to), path.dirname(m.from));
    if (fs.existsSync(m.to)) throw new Error(`refusing to overwrite ${m.to}`);
    fs.renameSync(m.from, m.to);
    log.moves.push({ from: m.from, to: m.to });
    save();
  }
  for (const n of p.nfos) { fs.writeFileSync(n.path, n.content); same(n.video, n.path); }
  // remove folders the moves left empty
  const dirs = [...new Set(p.moves.map((m) => path.dirname(m.from)))].sort((a, b) => b.length - a.length);
  for (const d of dirs) { try { if (d !== root && fs.readdirSync(d).filter((n) => !['desktop.ini', 'Thumbs.db'].includes(n)).length === 0) fs.rmSync(d, { recursive: true }); } catch { /* not empty / gone */ } }
  save();
  return { logFile, moved: log.moves.length, nfos: p.nfos.length };
}

/** Put everything back: files to where they were, and the original .nfo files restored. */
export function undo(logFile) {
  const log = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  for (const n of [...log.nfos].reverse()) if (!n.existedBefore) fs.rmSync(n.path, { force: true }); // an .nfo this tool created
  for (const m of [...log.moves].reverse()) { fs.mkdirSync(path.dirname(m.from), { recursive: true }); if (fs.existsSync(m.to)) fs.renameSync(m.to, m.from); }
  for (const n of log.nfos) for (const b of n.backups) if (b.backup) { fs.mkdirSync(path.dirname(b.file), { recursive: true }); fs.copyFileSync(b.backup, b.file); }
  const dup = path.join(log.root, HIDDEN_DUP); // empty folders left behind in .duplicates and the artist folders we made
  const prune = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(d, e.name)); if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* not there */ } };
  prune(dup);
  return { restoredMoves: log.moves.length };
}

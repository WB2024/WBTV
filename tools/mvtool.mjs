#!/usr/bin/env node
// Music-video housekeeping.  usage:
//   node tools/mvtool.mjs audit <music video folder> [--db /config/wbtv.db] [--csv report.csv] [--json plan.json]
// "audit" only READS: it changes nothing. It reports what each file is called now, what it should be called, whether the year in its
// .nfo is a real release year (or just an upload / download date), and the year and genre your own music library knows for that song.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseName, plausibleYear, looksLikeDownloadYear, fileSafe, buildLibraryIndex, readNfo, norm } from './mvlib.mjs';

const VIDEO = new Set(['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.wmv', '.mpg', '.mpeg', '.flv', '.webm', '.vob', '.ts', '.divx']);
const SIDECAR = /^(.*?)(\.nfo|-poster\.(jpg|jpeg|png)|-thumb\.(jpg|jpeg|png)|-fanart\.(jpg|jpeg|png)|-clearlogo\.(jpg|jpeg|png)|\.(srt|ass|vtt|lrc))$/i;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

export function audit(root, { dbPath } = {}) {
  let lib = null;
  if (dbPath && fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tracks = db.prepare("SELECT artist,title,year,genres FROM items WHERE kind='track'").all().map((t) => ({ ...t, genres: JSON.parse(t.genres || '[]') }));
    lib = buildLibraryIndex(tracks);
  }
  const files = walk(root);
  const videos = files.filter((f) => VIDEO.has(path.extname(f).toLowerCase()));
  const rows = [];
  for (const f of videos) {
    const rel = path.relative(root, f).split(path.sep);
    const dir = path.dirname(f), base = path.parse(f).name, ext = path.extname(f);
    const folder = rel.length > 1 ? rel[0] : '';
    const nfoPath = path.join(dir, base + '.nfo');
    const nfo = fs.existsSync(nfoPath) ? readNfo(fs.readFileSync(nfoPath, 'utf8')) : null;
    const st = fs.statSync(f);
    const mtimeYear = st.mtime.getFullYear();
    const addedYear = nfo?.added ? Number(nfo.added.slice(0, 4)) : null;
    const artistHint = folder || (nfo?.artist && norm(nfo.artist) !== norm('RHINO') ? nfo.artist : '') || base.split(' - ')[0];
    const parsed = parseName(base, artistHint, lib?.artists);
    const issues = [];

    // ---- year: filename, then your library, then the .nfo if it is believable
    const rawYear = nfo?.year || '';
    const nfoYear = plausibleYear(rawYear);
    if (rawYear && /^\d{8}$/.test(rawYear)) issues.push('year is an upload date');
    else if (rawYear && !nfoYear) issues.push('year not usable');
    else if (nfoYear && looksLikeDownloadYear(nfoYear, { addedYear, mtimeYear })) issues.push('year looks like the download year');
    const song = lib?.song(parsed.artist, parsed.title) || null;
    let year = null, yearSource = '';
    if (parsed.year) { year = parsed.year; yearSource = 'file name'; }
    else if (song?.year) { year = song.year; yearSource = 'your library'; }
    else if (nfoYear && !looksLikeDownloadYear(nfoYear, { addedYear, mtimeYear })) { year = nfoYear; yearSource = '.nfo (unverified)'; }

    // ---- genre: the song, else the artist's usual genre, else what the .nfo has
    const artistInfo = lib?.artist(parsed.artist) || null;
    let genres = [], genreSource = '';
    if (song?.genres?.length) { genres = song.genres.slice(0, 1); genreSource = 'your library (song)'; }
    else if (artistInfo?.genres?.length) { genres = artistInfo.genres.slice(0, 1); genreSource = 'your library (artist)'; }
    else if (nfo?.genres?.length) { genres = nfo.genres; genreSource = '.nfo'; }
    if (lib && !artistInfo) issues.push('artist not in your library');
    if (!genres.length) issues.push('no genre');
    if (!year) issues.push('no year');

    const newBase = fileSafe(`${parsed.artist} - ${parsed.title}`);
    const newDir = path.join(root, fileSafe(parsed.artist));
    const target = path.join(newDir, newBase + ext);
    const renamed = path.resolve(target) !== path.resolve(f);
    if (renamed) issues.push(path.dirname(f) !== newDir ? 'move and rename' : 'rename');
    if (!nfo) issues.push('no .nfo');
    const sidecars = files.filter((x) => x !== f && path.dirname(x) === dir && x.startsWith(path.join(dir, base)) && SIDECAR.test(path.basename(x)) && SIDECAR.exec(path.basename(x))[1] === base).map((x) => path.basename(x));
    rows.push({ file: rel.join('/'), artistFolder: folder, artist: parsed.artist, title: parsed.title, newPath: path.relative(root, target).split(path.sep).join('/'), renamed,
      oldYear: rawYear, year, yearSource, genres, genreSource, hasNfo: !!nfo, locked: !!nfo?.locked, sidecars, issues, bytes: st.size });
  }
  // duplicates: the same song downloaded more than once
  const groups = new Map();
  for (const r of rows) { const k = `${norm(r.artist)}|${norm(r.title)}`; (groups.get(k) || groups.set(k, []).get(k)).push(r); }
  for (const g of groups.values()) if (g.length > 1) for (const r of g) r.issues.push(`duplicate of ${g.length - 1} other file(s)`);
  // two files that would end up with the same name
  const seen = new Map();
  for (const r of rows) { const k = r.newPath.toLowerCase(); if (seen.has(k) && seen.get(k) !== r) { r.issues.push('new name collides'); seen.get(k).issues.push('new name collides'); } else seen.set(k, r); }
  return { rows, libraryUsed: !!lib };
}

function summarise({ rows, libraryUsed }) {
  const c = (f) => rows.filter(f).length;
  return {
    videos: rows.length, libraryUsed,
    renames: c((r) => r.renamed), moves: c((r) => r.issues.includes('move and rename')),
    uploadDateYears: c((r) => r.issues.includes('year is an upload date')), downloadYears: c((r) => r.issues.includes('year looks like the download year')),
    yearsFromFilename: c((r) => r.yearSource === 'file name'), yearsFromLibrary: c((r) => r.yearSource === 'your library'), yearsKeptFromNfo: c((r) => r.yearSource === '.nfo (unverified)'), stillNoYear: c((r) => !r.year),
    genresFromSong: c((r) => r.genreSource === 'your library (song)'), genresFromArtist: c((r) => r.genreSource === 'your library (artist)'), stillNoGenre: c((r) => !r.genres.length),
    noNfo: c((r) => !r.hasNfo), duplicates: c((r) => r.issues.some((i) => i.startsWith('duplicate'))), collisions: c((r) => r.issues.includes('new name collides')),
    artistsNotInLibrary: [...new Set(rows.filter((r) => r.issues.includes('artist not in your library')).map((r) => r.artist))],
  };
}

const csv = (rows) => ['file,new name,artist,title,old year,new year,year from,genre,genre from,issues', ...rows.map((r) => [r.file, r.newPath, r.artist, r.title, r.oldYear, r.year ?? '', r.yearSource, r.genres.join('; '), r.genreSource, r.issues.join('; ')]
  .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('mvtool.mjs')) {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  if (cmd !== 'audit' || !dir) { console.log('usage: node tools/mvtool.mjs audit <music video folder> [--db /config/wbtv.db] [--csv report.csv] [--json plan.json]'); process.exit(1); }
  const result = audit(path.resolve(dir), { dbPath: opt('--db') });
  console.log(JSON.stringify({ summary: summarise(result), rows: result.rows }));
  if (opt('--csv')) fs.writeFileSync(opt('--csv'), csv(result.rows));
}

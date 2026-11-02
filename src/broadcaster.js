import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { probe } from './media.js';
import { REEL } from './scheduler.js';
import { getBlockAt, ensureChannelSchedule } from './scheduler.js';

const SEG_SECONDS = 4;
const LEAD = 10;        // seconds of video we keep buffered ahead of the wall clock
const WINDOW = 6;       // segments advertised in the live playlist
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Broadcaster per watched channel. It walks the persisted schedule in real time and
 * pipes each block through ffmpeg into one continuous live HLS stream. Every viewer of a
 * channel shares it, exactly like a real broadcast. It shuts itself down when nobody watches.
 */
export class Broadcaster {
  constructor(db, channelId, onStop) {
    this.db = db; this.id = channelId; this.onStop = onStop;
    this.dir = path.join(cfg.tmpDir, 'live', String(channelId));
    this.segs = [];        // { g, file, dur, disc, discBefore }
    this.gCounter = 0; this.discCounter = 0;
    this.runs = []; this.runNo = 0; this.proc = null;
    this.streamTime = 0; this.stopped = false;
    this.viewers = new Map();
    this.startedAt = Date.now();
  }

  start() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.loop().catch((e) => console.error(`[ch${this.id}] broadcaster crashed`, e));
    this.reaper = setInterval(() => {
      const cut = Date.now() - 25000;
      for (const [v, t] of this.viewers) if (t < cut) this.viewers.delete(v);
      if (!this.viewers.size && Date.now() - this.startedAt > 25000) this.stop();
    }, 5000);
  }

  touch(viewer) { this.viewers.set(viewer || 'anon', Date.now()); }
  leave(viewer) {
    this.viewers.delete(viewer);
    if (!this.viewers.size) this.stop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.reaper);
    try { this.proc?.kill('SIGKILL'); } catch { /* gone */ }
    setTimeout(() => fs.rmSync(this.dir, { recursive: true, force: true }), 500);
    this.onStop?.(this.id);
  }

  // ---- playlist ---------------------------------------------------------

  sync() {
    for (const r of this.runs) {
      let text;
      try { text = fs.readFileSync(r.playlist, 'utf8'); } catch { continue; }
      const found = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const m = lines[i].match(/^#EXTINF:([\d.]+)/);
        if (m && /\.ts\s*$/.test(lines[i + 1])) found.push({ dur: parseFloat(m[1]), file: lines[i + 1].trim() });
      }
      for (let k = r.count; k < found.length; k++) {
        const disc = k === 0 && this.gCounter > 0;
        this.segs.push({ g: this.gCounter++, ...found[k], disc, discBefore: this.discCounter });
        if (disc) this.discCounter++;
        r.produced += found[k].dur;
      }
      r.count = found.length;
    }
    this.runs = this.runs.filter((r) => !(r.ended && r.synced));
    for (const r of this.runs) if (r.ended) r.synced = true;
    // drop old segments (and their files)
    while (this.segs.length > WINDOW + 12) {
      const old = this.segs.shift();
      fs.rm(path.join(this.dir, old.file), () => {});
    }
  }

  get ready() { this.sync(); return this.segs.length; }

  playlist() {
    this.sync();
    const w = this.segs.slice(-WINDOW);
    if (!w.length) return null;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(SEG_SECONDS, ...w.map((s) => s.dur)))}`,
      `#EXT-X-MEDIA-SEQUENCE:${w[0].g}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${w[0].discBefore}`];
    for (const s of w) {
      if (s.disc) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(`#EXTINF:${s.dur.toFixed(3)},`, s.file);
    }
    return lines.join('\n') + '\n';
  }

  // ---- the broadcast loop -------------------------------------------------

  async loop() {
    let cursor = Date.now() / 1000;
    while (!this.stopped) {
      const wall = Date.now() / 1000;
      let block = getBlockAt(this.db, this.id, cursor);
      if (!block) { try { ensureChannelSchedule(this.db, this.id); } catch { /* ignore */ } block = getBlockAt(this.db, this.id, cursor); }

      let dur, produced = 0, ok = false;
      const burst = Math.max(1, LEAD - (cursor - wall));
      let plan = null;
      if (block && (block.kind !== 'ad' || block.file)) {
        dur = block.end - cursor;
        if (dur < 0.05) { cursor = block.end + 0.01; continue; }
        plan = { file: block.file, offset: block.in_point + (cursor - block.start) };
      } else {
        // a hole in the schedule, or an ad that has since been removed: fill with a real ad, not the test card
        const until = block ? block.end : this.db.prepare('SELECT MIN(start) AS s FROM blocks WHERE channel_id=? AND start>?').get(this.id, cursor)?.s;
        dur = until ? until - cursor : 10;
        if (until && dur < 0.05) { cursor = until + 0.01; continue; }
        const fill = until ? this.pickFiller(dur) : null;
        if (fill) { plan = fill; dur = fill.dur; }
      }
      if (plan && plan.file) {
        const info = await probe(plan.file);
        if (info && !this.stopped) {
          produced = await this.runContent(plan.file, plan.offset, dur, info.hasAudio, burst);
          ok = produced > 0.5;
        }
      }

      if (this.stopped) return;
      if (ok) {
        cursor += produced >= dur - 1.2 ? dur : produced;
      } else {
        // missing/broken file or nothing scheduled: show the test card instead of dying
        const slate = Math.min(dur, 10);
        const p = await this.runSlate(slate);
        if (p < 0.5) { await sleep(2000); cursor = Math.max(cursor, Date.now() / 1000); }
        else cursor += slate;
      }
      // never sprint ahead of the wall clock
      const ahead = cursor - Date.now() / 1000 - LEAD - 2;
      if (ahead > 0) await sleep(ahead * 1000);
    }
  }

  /** Pick an ad (matching this channel's type) to cover `gap` seconds of schedule hole. */
  pickFiller(gap) {
    const kind = this.db.prepare('SELECT kind FROM channels WHERE id=?').get(this.id)?.kind;
    const ads = this.db.prepare("SELECT file, duration FROM ads WHERE status='ready' AND file IS NOT NULL AND (kind='all' OR kind=?)").all(kind)
      .filter((a) => fs.existsSync(a.file));
    if (!ads.length) return null;
    const ad = ads[Math.floor(Math.random() * ads.length)];
    const dur = Math.min(gap, ad.duration);
    const offset = ad.duration > REEL ? Math.random() * (ad.duration - dur) : 0;
    console.log(`[ch${this.id}] schedule hole of ${gap.toFixed(0)}s filled with ad`);
    return { file: ad.file, offset, dur };
  }

  encodeArgs() {
    const { width: W, height: H } = cfg;
    return {
      vf: `yadif=0:-1:1,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,format=yuv420p`,
      codec: ['-c:v', 'libx264', '-preset', cfg.preset, '-crf', String(cfg.crf), '-maxrate', '5M', '-bufsize', '10M', '-profile:v', 'main',
        '-g', '100', '-keyint_min', '100', '-sc_threshold', '0', '-force_key_frames', `expr:gte(t,n_forced*${SEG_SECONDS})`,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'],
    };
  }

  runContent(file, offset, dur, hasAudio, burst) {
    const e = this.encodeArgs();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', offset.toFixed(3), '-readrate', '1', '-readrate_initial_burst', burst.toFixed(1), '-i', file];
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-t', dur.toFixed(3), '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
      '-vf', e.vf, '-af', 'aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo', ...e.codec);
    return this.runFfmpeg(args);
  }

  runSlate(dur) {
    const e = this.encodeArgs();
    const { width: W, height: H } = cfg;
    return this.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-re', '-f', 'lavfi', '-i', `smptebars=size=${W}x${H}:rate=25`,
      '-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000,volume=0.04',
      '-t', dur.toFixed(2), '-map', '0:v', '-map', '1:a', '-vf', 'format=yuv420p', ...e.codec]);
  }

  runFfmpeg(inputArgs) {
    return new Promise((resolve) => {
      const no = ++this.runNo;
      const run = { no, playlist: path.join(this.dir, `r${no}.m3u8`), count: 0, produced: 0, ended: false };
      this.runs.push(run);
      const args = [...inputArgs, '-output_ts_offset', this.streamTime.toFixed(3),
        '-f', 'hls', '-hls_time', String(SEG_SECONDS), '-hls_list_size', '0', '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(this.dir, `r${no}_%05d.ts`), run.playlist];
      const p = spawn(cfg.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = p;
      let err = '';
      p.stderr.on('data', (d) => (err = (err + d).slice(-1500)));
      p.on('error', (e) => { err += String(e); });
      p.on('close', () => {
        run.ended = true;
        this.sync();
        this.streamTime += run.produced;
        if (err.trim() && !this.stopped) console.error(`[ch${this.id}] ffmpeg: ${err.trim().split('\n').slice(-3).join(' | ')}`);
        resolve(run.produced);
      });
    });
  }
}

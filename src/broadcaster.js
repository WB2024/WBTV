import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { probe } from './media.js';
import { REEL } from './scheduler.js';
import { getSettings } from './db.js';
import { prepare as prepareNarration } from './tts.js';
import { resolveYoutube, probeLive, isUrl } from './iptv.js';
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
    // the live playlist advertises this many segments; the more, the further back viewers can pause/rewind
    const mins = Number(getSettings(db).pauseBufferMinutes) || 0;
    this.windowSegs = Math.max(WINDOW, Math.round((mins * 60) / SEG_SECONDS));
  }

  start() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    const kind = this.db.prepare('SELECT kind FROM channels WHERE id=?').get(this.id)?.kind;
    (kind === 'live' ? this.loopLive() : this.loop()).catch((e) => console.error(`[ch${this.id}] broadcaster crashed`, e));
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
    while (this.segs.length > this.windowSegs + 6) {
      const old = this.segs.shift();
      fs.rm(path.join(this.dir, old.file), () => {});
    }
  }

  get ready() { this.sync(); return this.segs.length; }

  playlist() {
    this.sync();
    const w = this.segs.slice(-this.windowSegs);
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
      this.warmNarration(cursor);
      if (block && (block.kind !== 'ad' || block.file)) {
        dur = block.end - cursor;
        if (dur < 0.05) { cursor = block.end + 0.01; continue; }
        plan = {
          file: block.file, offset: block.in_point + (cursor - block.start), promo: block.kind === 'promo' ? block : null, elapsed: cursor - block.start,
          meta: block.item_kind === 'musicvideo' || block.item_kind === 'track'
            ? { kind: block.item_kind, title: block.m_title, artist: block.m_artist, album: block.m_album, year: block.m_year, poster: block.m_poster } : null,
        };
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
          produced = plan.promo
            ? await this.runPromo(plan, dur, info.hasAudio, burst)
            : plan.meta?.kind === 'track'
              ? await this.runAudio(plan, dur, burst)
              : await this.runContent(plan.file, plan.offset, dur, info.hasAudio, burst, plan.meta);
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

  /** Start synthesising the voice-over for an upcoming announcement so it is ready when it airs. */
  warmNarration(cursor) {
    try {
      const up = this.db.prepare("SELECT promo_id FROM blocks WHERE channel_id=? AND kind='promo' AND end>? AND start<? ORDER BY start LIMIT 1").get(this.id, cursor, cursor + 150);
      if (!up || this.warmed === up.promo_id) return;
      this.warmed = up.promo_id;
      const p = this.db.prepare('SELECT * FROM promos WHERE id=?').get(up.promo_id);
      if (p) prepareNarration(p.id, JSON.parse(p.segments), getSettings(this.db).promoVoice).catch(() => {});
    } catch { /* best effort */ }
  }

  /**
   * "Coming up next" slot: a clip from inside the next programme (its own sound ducked), the announcer's
   * voice on top, and UP NEXT / AFTER THAT / LATER captions timed to the speech.
   */
  async runPromo(plan, dur, hasAudio, burst) {
    const b = plan.promo;
    const promo = this.db.prepare('SELECT * FROM promos WHERE id=?').get(b.promo_id);
    const segments = promo ? JSON.parse(promo.segments) : [];
    let narr = null;
    try { if (segments.length) narr = await prepareNarration(promo.id, segments, getSettings(this.db).promoVoice); }
    catch (e) { console.error(`[ch${this.id}] narration failed: ${e.message}`); }

    const e = this.encodeArgs();
    const el = Math.max(0, plan.elapsed); // joined part-way through the slot: skip into the voice-over and captions too
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', plan.offset.toFixed(3), '-readrate', '1', '-readrate_initial_burst', burst.toFixed(1), '-i', plan.file];
    if (narr) args.push('-ss', el.toFixed(3), '-i', narr.file);

    // captions
    let v = `[0:v:0]${e.vf}`;
    if (fs.existsSync(cfg.fontFile) && segments.length) {
      const cues = narr ? narr.cues : [{ label: segments[0].label, title: segments[0].title, start: 0, end: 1e6 }];
      const dir = path.join(this.dir, 'captions');
      fs.mkdirSync(dir, { recursive: true });
      const f1 = Math.round(cfg.height * 0.032), f2 = Math.round(cfg.height * 0.05);
      cues.forEach((c, i) => {
        const a = (c.start - 0.3 - el).toFixed(2);
        const z = ((i < cues.length - 1 ? cues[i + 1].start - 0.3 : 1e6) - el).toFixed(2);
        const en = `enable='between(t,${a},${z})'`;
        const title = c.title.length > 42 ? c.title.slice(0, 41) + '…' : c.title;
        const lf = path.join(dir, `${this.runNo}_${i}_l.txt`), tf = path.join(dir, `${this.runNo}_${i}_t.txt`);
        fs.writeFileSync(lf, c.label); fs.writeFileSync(tf, title);
        v += `,drawbox=x=0:y=ih*0.79:w=iw:h=ih*0.16:color=black@0.72:t=fill:${en}` +
          `,drawtext=fontfile=${cfg.fontFile}:textfile=${lf}:x=w*0.045:y=h*0.805:fontsize=${f1}:fontcolor=0xffd400:${en}` +
          `,drawtext=fontfile=${cfg.fontFile}:textfile=${tf}:x=w*0.045:y=h*0.855:fontsize=${f2}:fontcolor=white:${en}`;
      });
    }
    v += '[v]';

    // sound: preview clip quietly underneath, announcer on top
    const fmt = 'aresample=48000,aformat=channel_layouts=stereo';
    let a;
    if (narr && hasAudio) a = `[0:a:0]volume=0.18,${fmt}[a0];[1:a]${fmt},volume=0.85,apad[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`;
    else if (narr) a = `[1:a]${fmt},volume=0.85,apad,alimiter=limit=0.95[a]`;
    else if (hasAudio) a = `[0:a:0]volume=0.5,${fmt}[a]`;
    else { args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'); a = `[${narr ? 2 : 1}:a]${fmt}[a]`; }

    args.push('-t', dur.toFixed(3), '-filter_complex', `${v};${a}`, '-map', '[v]', '-map', '[a]', ...e.codec);
    return this.runFfmpeg(args);
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

  /** Write a one-line caption to a file (drawtext reads text from files so no escaping is needed). */
  textFile(name, text) {
    const dir = path.join(this.dir, 'captions');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${this.runNo}_${name}.txt`);
    fs.writeFileSync(f, String(text ?? '').replace(/[\r\n]+/g, ' ').slice(0, 60));
    return f;
  }

  runContent(file, offset, dur, hasAudio, burst, meta) {
    const e = this.encodeArgs();
    let vf = e.vf;
    // music video: "Artist - Title" lower-third for the first few seconds of each track
    if (meta?.kind === 'musicvideo' && fs.existsSync(cfg.fontFile) && offset < 6) {
      const { height: H } = cfg;
      const en = `enable='between(t,0.5,${Math.max(2, 8 - offset).toFixed(1)})'`;
      const af = this.textFile('mv_a', meta.artist || ''), tf = this.textFile('mv_t', meta.title || '');
      vf += `,drawbox=x=0:y=ih*0.80:w=iw*0.66:h=ih*0.14:color=black@0.66:t=fill:${en}` +
        `,drawtext=fontfile=${cfg.fontFile}:textfile=${af}:expansion=none:x=w*0.035:y=h*0.815:fontsize=${Math.round(H * 0.042)}:fontcolor=0xffd400:${en}` +
        `,drawtext=fontfile=${cfg.fontFile}:textfile=${tf}:expansion=none:x=w*0.035:y=h*0.865:fontsize=${Math.round(H * 0.05)}:fontcolor=white:${en}`;
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', offset.toFixed(3), '-readrate', '1', '-readrate_initial_burst', burst.toFixed(1), '-i', file];
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-t', dur.toFixed(3), '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
      '-vf', vf, '-af', 'aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo', ...e.codec);
    return this.runFfmpeg(args);
  }

  /** Filter graph for audio-only programming: cover art, now-playing text and a live waveform. Input 0 = audio, 1 = background, 2 = art. */
  audioVisual({ hasArt, label, title, sub1, sub2 }) {
    const { width: W, height: H } = cfg;
    const wh = Math.round(H * 0.2), artH = Math.round(H * 0.5);
    const tx = hasArt ? Math.round(W * 0.06 + artH + W * 0.04) : Math.round(W * 0.08);
    const font = fs.existsSync(cfg.fontFile) ? `fontfile=${cfg.fontFile}:` : '';
    const dt = (file, y, size, color) => `drawtext=${font}textfile=${file}:expansion=none:x=${tx}:y=${y}:fontsize=${size}:fontcolor=${color}`;
    const files = { l: this.textFile('av_l', label), t: this.textFile('av_t', title), a: this.textFile('av_a', sub1), b: this.textFile('av_b', sub2) };
    let f = '[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[a][w];' +
      `[w]volume=3,alimiter=limit=0.95,showwaves=s=${W}x${wh}:mode=cline:colors=cyan:rate=25:scale=sqrt:draw=full,format=yuv420p[wv];[1:v]format=yuv420p[bg];[bg][wv]overlay=0:${H - wh - Math.round(H * 0.04)}[b1];`;
    f += hasArt ? `[2:v]scale=-2:${artH},format=yuv420p[art];[b1][art]overlay=${Math.round(W * 0.06)}:${Math.round(H * 0.14)}[b2];` : '[b1]null[b2];';
    f += `[b2]${dt(files.l, Math.round(H * 0.16), Math.round(H * 0.04), '0xffd400')},${dt(files.t, Math.round(H * 0.23), Math.round(H * 0.07), 'white')},` +
      `${dt(files.a, Math.round(H * 0.34), Math.round(H * 0.05), '0x9fd8ff')},${dt(files.b, Math.round(H * 0.42), Math.round(H * 0.038), '0xaab4d8')},format=yuv420p[v]`;
    return f;
  }

  /** A radio track: no picture of its own, so we draw one. */
  runAudio(plan, dur, burst) {
    const e = this.encodeArgs();
    const m = plan.meta;
    const art = m.poster && fs.existsSync(m.poster) ? m.poster : null;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', plan.offset.toFixed(3), '-readrate', '1', '-readrate_initial_burst', burst.toFixed(1), '-i', plan.file,
      '-f', 'lavfi', '-i', `color=c=0x0a1030:s=${cfg.width}x${cfg.height}:r=25`];
    if (art) args.push('-loop', '1', '-framerate', '25', '-i', art);
    const filter = this.audioVisual({ hasArt: !!art, label: 'NOW PLAYING', title: m.title || '', sub1: m.artist || '', sub2: [m.album, m.year].filter(Boolean).join('  ·  ') });
    args.push('-t', dur.toFixed(3), '-filter_complex', filter, '-map', '[v]', '-map', '[a]', ...e.codec);
    return this.runFfmpeg(args);
  }

  // ---- live (IPTV / YouTube) channels: no schedule, we just relay the stream --------------------

  async loopLive() {
    const st = this.db.prepare('SELECT * FROM live_streams WHERE channel_id=?').get(this.id);
    const name = this.db.prepare('SELECT COALESCE(name_override, auto_name) AS n FROM channels WHERE id=?').get(this.id)?.n || 'Live';
    if (!st) return;
    while (!this.stopped) {
      const url = st.src_kind === 'youtube' ? await resolveYoutube(st.url) : st.url; // YouTube links expire: resolve each time
      const info = url ? await probeLive(url, 25000) : null;
      let produced = 0;
      if (info && !this.stopped) produced = await this.runLive(url, info, name, st.grp);
      if (this.stopped) return;
      if (produced < 0.5) { if ((await this.runSlate(6)) < 0.5) await sleep(3000); } // source is down: test card, then retry
      else await sleep(1000);
    }
  }

  runLive(url, info, name, group) {
    const e = this.encodeArgs();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (isUrl(url)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000');
    args.push('-i', url);
    if (info.hasVideo) {
      if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest');
      args.push('-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0', '-vf', e.vf, '-af', 'aresample=48000:async=1,aformat=channel_layouts=stereo', ...e.codec);
    } else {
      // live radio station: draw a picture with the station name
      args.push('-f', 'lavfi', '-i', `color=c=0x0a1030:s=${cfg.width}x${cfg.height}:r=25`);
      args.push('-filter_complex', this.audioVisual({ hasArt: false, label: 'LIVE RADIO', title: name, sub1: group || '', sub2: '' }), '-map', '[v]', '-map', '[a]', ...e.codec);
    }
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

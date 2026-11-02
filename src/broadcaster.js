import { spawn } from 'node:child_process';
import { videoCodec, videoTail, globalArgs } from './hw.js';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { probe } from './media.js';
import { REEL } from './scheduler.js';
import { getSettings } from './db.js';
import { logoFile } from './logos.js';
import { prepare as prepareNarration, cached as cachedNarration } from './tts.js';
import { openLive, forgetLive, isUrl } from './iptv.js';
import { getBlockAt, ensureChannelSchedule } from './scheduler.js';

const SEG_SECONDS = 4;
const probeMemo = new Map(); // file -> { at, info }: remembering what a file contains saves a slow network-share round trip on every tune-in
async function probeFile(file) {
  const hit = probeMemo.get(file);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.info;
  const info = await probe(file);
  if (info) { probeMemo.set(file, { at: Date.now(), info }); if (probeMemo.size > 2000) probeMemo.delete(probeMemo.keys().next().value); }
  return info;
}
const firstOf = (json) => { try { return JSON.parse(json || '[]')[0] || ''; } catch { return ''; } };
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
    this.marks = {}; this.firstKind = '';
    // the live playlist advertises this many segments; the more, the further back viewers can pause/rewind
    const mins = Number(getSettings(db).pauseBufferMinutes) || 0;
    this.windowSegs = Math.max(WINDOW, Math.round((mins * 60) / SEG_SECONDS));
  }

  /** Cold-start timing: logs one line the first time the channel has 3 segments, so slow tune-ins can be explained. */
  mark(name) {
    if (name in this.marks) return;
    this.marks[name] = Date.now() - this.startedAt;
    if (name === 'seg3') {
      const m = this.marks, f = (k) => (k in m ? (m[k] / 1000).toFixed(1) + 's' : '-');
      const slow = m.seg3 > 6000;
      if (slow || process.env.WBTV_DEBUG) console.log(`[ch${this.id}] tune-in ${f('seg3')}${slow ? ' (slow)' : ''}: schedule ${f('block')}, file probe ${f('probe')}, ffmpeg start ${f('spawn')}, 1st segment ${f('seg1')} [${this.firstKind}]`);
    }
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
      if (found.length && !this.segs.length) this.mark('seg1');
      for (let k = r.count; k < found.length; k++) {
        const disc = k === 0 && this.gCounter > 0;
        this.segs.push({ g: this.gCounter++, ...found[k], disc, discBefore: this.discCounter });
        if (disc) this.discCounter++;
        r.produced += found[k].dur;
      }
      r.count = found.length;
    }
    if (this.segs.length >= 3) this.mark('seg3');
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
      this.mark('block');
      if (!this.firstKind) this.firstKind = block ? block.kind : 'hole';

      let dur, produced = 0, ok = false;
      const burst = Math.max(1, LEAD - (cursor - wall));
      let plan = null;
      this.warmNarration(cursor);
      if (block && (block.kind !== 'ad' || block.file)) {
        dur = block.end - cursor;
        if (dur < 0.05) { cursor = block.end + 0.01; continue; }
        plan = {
          file: block.file, offset: block.in_point + (cursor - block.start), promo: block.kind === 'promo' ? block : null, elapsed: cursor - block.start,
          meta: ['musicvideo', 'track', 'talk'].includes(block.item_kind)
            ? { kind: block.item_kind, title: block.m_title, artist: block.m_artist, album: block.m_album, year: block.m_year, poster: block.m_poster, label: firstOf(block.m_genres) } : null,
        };
      } else {
        // a hole in the schedule, or an ad that has since been removed: fill with a real ad, not the test card
        const until = block ? block.end : this.db.prepare('SELECT MIN(start) AS s FROM blocks WHERE channel_id=? AND start>?').get(this.id, cursor)?.s;
        dur = until ? until - cursor : 10;
        if (until && dur < 0.05) { cursor = until + 0.01; continue; }
        const fill = until ? this.pickFiller(dur) : null;
        if (fill) { plan = fill; dur = fill.dur; }
      }
      if (block && (block.kind === 'signoff' || block.kind === 'ident')) {
        // generated pieces: the closedown test card, and the short station ident before a programme
        const signoff = block.kind === 'signoff';
        dur = signoff ? Math.min(dur, 300) : dur; // re-check the schedule every few minutes during closedown
        produced = signoff ? await this.runSignoff(dur) : await this.runIdent(dur, cursor - block.start);
        ok = produced > 0.5;
        plan = null;
      }
      if (plan && plan.file) {
        const info = await probeFile(plan.file);
        this.mark('probe');
        if (info && !this.stopped) {
          produced = plan.promo
            ? await this.runPromo(plan, dur, info.hasAudio, burst)
            : ['track', 'talk'].includes(plan.meta?.kind)
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
    try {
      if (segments.length) {
        const voice = getSettings(this.db).promoVoice;
        narr = cachedNarration(segments, voice);
        if (!narr) {
          // never keep a viewer waiting for the voice to be synthesised: give a nearly finished one a moment, else play the slot without it
          const job = prepareNarration(promo.id, segments, voice);
          job.catch(() => {});
          // tuning in (nothing produced yet): do not wait at all; otherwise a nearly finished voice-over gets a moment
          narr = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), this.segs.length ? 1500 : 0))]);
        }
      }
    } catch (e) { console.error(`[ch${this.id}] narration failed: ${e.message}`); }

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
    v += e.tail + '[v]';

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
      tail: videoTail(),
      codec: [...videoCodec(SEG_SECONDS, this.runNo === 0 ? 'superfast' : cfg.preset), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'],
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
      '-vf', this.withBug(vf, e.tail), '-af', 'aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo', ...e.codec);
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
      `${dt(files.a, Math.round(H * 0.34), Math.round(H * 0.05), '0x9fd8ff')},${dt(files.b, Math.round(H * 0.42), Math.round(H * 0.038), '0xaab4d8')},format=yuv420p${videoTail()}[v]`;
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
    const filter = this.audioVisual({ hasArt: !!art, label: m.kind === 'talk' ? (m.label || 'ON AIR').toUpperCase() : 'NOW PLAYING', title: m.title || '', sub1: m.artist || '', sub2: [m.album, m.year].filter(Boolean).join('  ·  ') });
    args.push('-t', dur.toFixed(3), '-filter_complex', filter, '-map', '[v]', '-map', '[a]', ...e.codec);
    return this.runFfmpeg(args);
  }

  // ---- live (IPTV / YouTube) channels: no schedule, we just relay the stream --------------------

  async loopLive() {
    const st = this.db.prepare('SELECT * FROM live_streams WHERE channel_id=?').get(this.id);
    const name = this.db.prepare('SELECT COALESCE(name_override, auto_name) AS n FROM channels WHERE id=?').get(this.id)?.n || 'Live';
    if (!st) return;
    while (!this.stopped) {
      const open = await openLive(st, 25000); // resolves YouTube links and checks the stream; cached for a few minutes
      let produced = 0;
      if (open && !this.stopped) produced = await this.runLive(open.urls, open.info, name, st.grp);
      if (this.stopped) return;
      if (produced < 0.5) forgetLive(st.url); // it failed: resolve afresh next time
      if (produced < 0.5) { if ((await this.runSlate(6)) < 0.5) await sleep(3000); } // source is down: test card, then retry
      else await sleep(1000);
    }
  }

  /** `urls` is one URL, or [video, audio] when the source serves them separately (YouTube live). */
  runLive(urls, info, name, group) {
    urls = [].concat(urls);
    const e = this.encodeArgs();
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    for (const u of urls) {
      if (isUrl(u)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000');
      args.push('-i', u);
    }
    const split = urls.length > 1;
    if (info.hasVideo) {
      if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest');
      args.push('-map', '0:v:0', '-map', split ? '1:a:0' : info.hasAudio ? '0:a:0' : '1:a:0', '-vf', e.vf + e.tail, '-af', 'aresample=48000:async=1,aformat=channel_layouts=stereo', ...e.codec);
    } else {
      // live radio station: draw a picture with the station name
      args.push('-f', 'lavfi', '-i', `color=c=0x0a1030:s=${cfg.width}x${cfg.height}:r=25`);
      args.push('-filter_complex', this.audioVisual({ hasArt: false, label: 'LIVE RADIO', title: name, sub1: group || '', sub2: '' }), '-map', '[v]', '-map', '[a]', ...e.codec);
    }
    return this.runFfmpeg(args);
  }

  chInfo() {
    return this.db.prepare('SELECT COALESCE(name_override, auto_name) AS name, number FROM channels WHERE id=?').get(this.id) || { name: 'WBTV', number: 0 };
  }

  /** Channel logo (if one was uploaded) or the channel name, small in the corner of programmes. */
  withBug(vf, tail) {
    if (!getSettings(this.db).channelBug) return vf + tail;
    const { height: H } = cfg;
    const logo = logoFile(this.id);
    if (logo) {
      return `[in]${vf}[m0];movie=${logo},scale=-2:${Math.round(H * 0.075)},format=rgba,colorchannelmixer=aa=0.75[lg];[m0][lg]overlay=W-w-W*0.03:H*0.045${tail}[out]`;
    }
    if (!fs.existsSync(cfg.fontFile)) return vf + tail;
    const name = this.textFile('bug', this.chInfo().name);
    return `${vf},drawtext=fontfile=${cfg.fontFile}:textfile=${name}:expansion=none:x=w-tw-w*0.03:y=h*0.045:fontsize=${Math.round(H * 0.04)}:fontcolor=white@0.7:shadowcolor=black@0.6:shadowx=2:shadowy=2${tail}`;
  }

  /** Closedown: a test card and a steady tone, like TV used to do overnight. */
  runSignoff(dur) {
    const e = this.encodeArgs();
    const { width: W, height: H } = cfg;
    const st = getSettings(this.db);
    let vf = 'format=yuv420p';
    if (fs.existsSync(cfg.fontFile)) {
      const l1 = this.textFile('so1', `${this.chInfo().name} has closed down for the night`);
      const l2 = this.textFile('so2', `Programmes resume at ${st.signOffTo}`);
      vf += `,drawbox=x=iw*0.12:y=ih*0.38:w=iw*0.76:h=ih*0.24:color=black@0.82:t=fill` +
        `,drawtext=fontfile=${cfg.fontFile}:textfile=${l1}:expansion=none:x=(w-tw)/2:y=h*0.43:fontsize=${Math.round(H * 0.05)}:fontcolor=white` +
        `,drawtext=fontfile=${cfg.fontFile}:textfile=${l2}:expansion=none:x=(w-tw)/2:y=h*0.52:fontsize=${Math.round(H * 0.04)}:fontcolor=0xffd400`;
    }
    return this.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-re', '-f', 'lavfi', '-i', `pal75bars=size=${W}x${H}:rate=25`,
      '-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000,volume=0.04',
      '-t', dur.toFixed(2), '-map', '0:v', '-map', '1:a', '-vf', vf + e.tail, ...e.codec]);
  }

  /** A few seconds of generated station ident: big channel number and name on a colour that is the same every time. */
  runIdent(dur, elapsed = 0) {
    const e = this.encodeArgs();
    const { width: W, height: H } = cfg;
    const ch = this.chInfo();
    const colours = ['0x1a3a9c', '0x7a1f5c', '0x0d6b5f', '0x8a3b12', '0x3b2a8a', '0x1d5e8a', '0x6b1f1f', '0x2f6b1f'];
    const colour = colours[this.id % colours.length];
    const el = Math.max(0, elapsed);
    let vf = 'format=yuv420p';
    if (fs.existsSync(cfg.fontFile)) {
      const n = this.textFile('id_n', ch.number || '');
      const t = this.textFile('id_t', ch.name);
      const a = `alpha='if(lt(t+${el},0.6),(t+${el})/0.6,if(gt(t+${el},4.3),(5-(t+${el}))/0.7,1))'`;
      vf += `,drawtext=fontfile=${cfg.fontFile}:textfile=${n}:expansion=none:x=(w-tw)/2:y=h*0.28:fontsize=${Math.round(H * 0.28)}:fontcolor=white:${a}` +
        `,drawtext=fontfile=${cfg.fontFile}:textfile=${t}:expansion=none:x=(w-tw)/2:y=h*0.68:fontsize=${Math.round(H * 0.08)}:fontcolor=0xffd400:${a}`;
    }
    return this.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-re', '-f', 'lavfi', '-i', `color=c=${colour}:s=${W}x${H}:r=25`,
      '-re', '-f', 'lavfi', '-i', 'sine=frequency=659:sample_rate=48000,volume=0.22,afade=t=out:st=0.5:d=1.2,apad',
      '-t', dur.toFixed(2), '-map', '0:v', '-map', '1:a', '-vf', vf + e.tail, ...e.codec]);
  }

  runSlate(dur) {
    const e = this.encodeArgs();
    const { width: W, height: H } = cfg;
    return this.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-re', '-f', 'lavfi', '-i', `smptebars=size=${W}x${H}:rate=25`,
      '-re', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000,volume=0.04',
      '-t', dur.toFixed(2), '-map', '0:v', '-map', '1:a', '-vf', 'format=yuv420p' + e.tail, ...e.codec]);
  }

  runFfmpeg(inputArgs) {
    return new Promise((resolve) => {
      const no = ++this.runNo;
      const run = { no, playlist: path.join(this.dir, `r${no}.m3u8`), count: 0, produced: 0, ended: false };
      this.runs.push(run);
      const args = [...globalArgs(), ...inputArgs, '-output_ts_offset', this.streamTime.toFixed(3),
        '-f', 'hls', '-hls_time', String(SEG_SECONDS), '-hls_list_size', '0', '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(this.dir, `r${no}_%05d.ts`), run.playlist];
      const p = spawn(cfg.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = p;
      this.mark('spawn');
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

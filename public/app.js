// replaceChildren stringifies null/arrays; make it behave like h() children
const _rc = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...k) { return _rc.apply(this, k.flat(Infinity).filter((x) => x != null && x !== false).map((x) => (x.nodeType ? x : String(x)))); };
const $ = (s, el = document) => el.querySelector(s);
const PX = 5; // px per minute, keep in sync with nothing else (cells are positioned inline)
const viewer = Math.random().toString(36).slice(2);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (v !== false && v != null) { if (k in el) el[k] = v; else el.setAttribute(k, v); }
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
const api = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: opt.body ? { 'Content-Type': 'application/json' } : undefined, body: opt.body ? JSON.stringify(opt.body) : undefined });
  if (r.status === 401 && !url.startsWith('/api/auth/')) { location.reload(); return new Promise(() => {}); } // session expired: show the login again
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDur = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

// ------------------------------------------------------------------ state
const S = { allChannels: [], channels: [], epg: null, selCh: 0, selProg: null, playing: null, hls: null, detail: new Map(), digits: '', filter: localStorage.getItem('wbtv-filter') || 'all' };
const video = $('#video');
let epgFrom = 0;

// filter chips: which channels the guide lists
const FILTERS = [
  ['all', 'All channels', () => true],
  ['tv', 'TV', (c) => c.kind === 'tv'],
  ['movie', 'Movies', (c) => c.kind === 'movie'],
  ['music', 'Music', (c) => c.kind === 'music'],
  ['clips', 'Clips', (c) => c.kind === 'clips'],
  ['radio', 'Radio', (c) => c.kind === 'radio'],
  ['live', 'Live', (c) => c.kind === 'live'],
  ['network', 'Networks', (c) => (c.key || '').startsWith('tv:studio:')],
  ['genre', 'Genres', (c) => (c.key || '').includes(':genre:')],
];
const filterFn = () => (FILTERS.find((f) => f[0] === S.filter) || FILTERS[0])[2];

function applyFilter() {
  S.channels = S.allChannels.filter(filterFn());
  if (!S.channels.length && S.filter !== 'all') { S.filter = 'all'; S.channels = S.allChannels.slice(); }
  S.selCh = Math.max(0, Math.min(S.channels.length - 1, S.selCh));
}
function setFilter(id) {
  S.filter = id; localStorage.setItem('wbtv-filter', id);
  applyFilter(); renderToolbar(); renderGuide(); selectNow(0, true);
  $('#guide').scrollTop = 0;
}
function cycleFilter(dir) {
  const vis = FILTERS.filter(([id, , fn]) => id === 'all' || S.allChannels.some(fn));
  const i = Math.max(0, vis.findIndex((f) => f[0] === S.filter));
  setFilter(vis[(i + dir + vis.length) % vis.length][0]);
}
function renderToolbar() {
  $('#toolbar').replaceChildren(
    FILTERS.filter(([id, , fn]) => id === 'all' || id === S.filter || S.allChannels.some(fn)).map(([id, label, fn]) => h('button', { class: `chip ${id === S.filter ? 'on' : ''}`, onclick: () => setFilter(id) }, label, h('small', {}, String(S.allChannels.filter(fn).length)))),
    h('span', { class: 'hint' }, '[ ] to switch'));
  $('#gname').textContent = (FILTERS.find((f) => f[0] === S.filter) || FILTERS[0])[1].toUpperCase();
}

async function loadGuide(keepSel = true) {
  S.allChannels = await api('/api/channels');
  applyFilter();
  const now = Date.now() / 1000;
  epgFrom = Math.floor(now / 1800) * 1800 - 2 * 3600;
  S.epg = await api(`/api/epg?from=${epgFrom}&to=${epgFrom + 14 * 3600}`);
  renderToolbar();
  renderGuide();
  if (!keepSel || !S.selProg) selectNow(S.selCh, true);
  else paintSel();
}

function progsFor(ch) { return S.epg?.programmes[ch.id] || []; }
function currentOf(ch, t = Date.now() / 1000) { return progsFor(ch).find((p) => p.start <= t && p.end > t); }
function nextOf(ch, t = Date.now() / 1000) { return progsFor(ch).find((p) => p.start > t); }
/** A channel is always "on air": between programmes it is showing adverts / the "coming up next" slot, so it can still be tuned. */
function tunable(ch, p, t = Date.now() / 1000) { return !!p && (p.start <= t && p.end > t || !currentOf(ch, t)); }

function renderGuide() {
  const g = $('#guide');
  const scroll = { x: g.scrollLeft, y: g.scrollTop };
  g.replaceChildren();
  if (!S.channels.length) {
    g.append(h('div', { style: 'padding:40px;text-align:center;color:var(--dim)' },
      h('h2', {}, 'No channels yet'), h('p', {}, 'Open Setup, add a library folder, and WBTV will build the channels from your NFO tags.'),
      h('button', { onclick: openSetup }, '⚙ Open Setup')));
    return;
  }
  const total = (S.epg.to - S.epg.from) / 60 * PX;
  const now = Date.now() / 1000;
  const inner = h('div', { class: 'inner', style: `width:calc(var(--chw) + ${total}px)` });
  const ticks = h('div', { class: 'ticks', style: `width:${total}px` });
  for (let t = epgFrom; t < S.epg.to; t += 1800) ticks.append(h('div', { class: 'tick', style: `left:${(t - epgFrom) / 60 * PX}px` }, fmtTime(t)));
  inner.append(h('div', { class: 'thead' }, h('div', { class: 'corner' }, 'Channel'), ticks));
  S.channels.forEach((ch, ci) => {
    const cells = h('div', { class: 'cells', style: `width:${total}px` });
    for (const p of progsFor(ch)) {
      const left = Math.max(0, (p.start - epgFrom) / 60 * PX), right = Math.min(total, (p.end - epgFrom) / 60 * PX);
      cells.append(h('div', {
        class: `cell ${p.end <= now ? 'past' : ''} ${p.start <= now && p.end > now ? 'now' : ''}`, 'data-p': p.id, style: `left:${left}px;width:${Math.max(4, right - left - 1)}px`,
        onclick: () => { S.selCh = ci; S.selProg = p; paintSel(); if (tunable(ch, p)) tune(ci); },
      }, h('div', { class: 't' }, p.title), h('div', { class: 's' }, subline(p))));
    }
    inner.append(h('div', { class: 'row', 'data-ch': ci },
      h('div', { class: `chan ${S.playing === ch.id ? 'playing' : ''}`, title: `${ch.number ?? ''} ${ch.name}`.trim(), onclick: () => tune(ci) }, h('span', { class: 'num' }, ch.number ?? ''), h('span', { class: 'nm' }, ch.name)), cells));
  });
  inner.append(h('div', { class: 'nowline', id: 'nowline', style: `left:calc(var(--chw) + ${(now - epgFrom) / 60 * PX}px)` }));
  g.append(inner);
  if (scroll.x || scroll.y) { g.scrollLeft = scroll.x; g.scrollTop = scroll.y; }
  else g.scrollLeft = Math.max(0, (now - 1800 - epgFrom) / 60 * PX - 20);
}

function subline(p) {
  const bits = [];
  if (p.subtitle) bits.push((p.season != null && p.episode != null ? `S${p.season}E${p.episode} · ` : '') + p.subtitle);
  else if (p.year) bits.push(String(p.year));
  return bits.join('');
}

function selectNow(ci, scrollTo) {
  S.selCh = Math.max(0, Math.min(S.channels.length - 1, ci));
  const ch = S.channels[S.selCh];
  // between programmes (adverts / announcement slot) nothing "airs now", so land on what is coming next
  S.selProg = ch && (currentOf(ch) || nextOf(ch) || progsFor(ch).at(-1)) || null;
  paintSel(scrollTo);
}

function paintSel(scrollTo = true) {
  document.querySelectorAll('.cell.sel').forEach((e) => e.classList.remove('sel'));
  document.querySelectorAll('.row.selrow').forEach((e) => e.classList.remove('selrow'));
  document.querySelector(`.row[data-ch="${S.selCh}"]`)?.classList.add('selrow');
  const p = S.selProg;
  if (!p) return;
  const el = $(`.cell[data-p="${p.id}"]`);
  if (el) { el.classList.add('sel'); if (scrollTo) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  showInfo(p, S.channels[S.selCh]);
}

async function showInfo(p, ch) {
  const info = $('#info');
  const live = p.start <= Date.now() / 1000 && p.end > Date.now() / 1000;
  const tag = live ? h('span', { class: 'badge' }, 'NOW') : p.end <= Date.now() / 1000 ? h('span', { class: 'badge' }, 'EARLIER') : h('span', { class: 'badge' }, 'NEXT');
  const body = (d) => h('div', { style: 'min-width:0' },
    h('h2', {}, p.title), p.subtitle ? h('div', { class: 'sub' }, `${p.season != null && p.episode != null ? `S${p.season} E${p.episode} – ` : ''}${p.subtitle}`) : null,
    h('div', { class: 'meta' }, tag, `${ch?.number ?? ''} ${ch?.name ?? ''} · ${fmtTime(p.start)}–${fmtTime(p.end)}`,
      p.year ? ` · ${p.year}` : '', p.mpaa ? ` · ${p.mpaa}` : '', p.rating ? ` · ★ ${p.rating.toFixed(1)}` : '',
      (d?.genres?.length ? ` · ${d.genres.join(', ')}` : p.genres.length ? ` · ${p.genres.join(', ')}` : '')),
    h('div', { class: 'plot' }, d?.plot || p.plot || ''),
    d?.actors?.length ? h('div', { class: 'cast' }, 'Starring: ' + d.actors.slice(0, 6).map((a) => a.name).join(', ')) : null,
    d?.studios?.length ? h('div', { class: 'cast' }, 'Studio: ' + d.studios.join(', ')) : null);
  const render = (d) => info.replaceChildren(h('img', { src: `/api/art/${p.item}`, onerror: (e) => (e.target.style.display = 'none') }), body(d));
  render(S.detail.get(p.item));
  if (!S.detail.has(p.item)) {
    const d = await api(`/api/items/${p.item}`).catch(() => null);
    if (d) { S.detail.set(p.item, d); if (S.selProg?.id === p.id) render(d); }
  }
}

// ------------------------------------------------------------------ playback
async function tune(ci) {
  const ch = S.channels[ci];
  if (!ch) return;
  if (S.playing === ch.id) { goFullscreen(); if (video.paused) video.play().catch(() => {}); return; } // already on this channel: OK means "watch it big" (and un-pause)
  if (autoFullscreen()) goFullscreen(); // keep this before any await: needs the user's key press / click
  leave();
  S.playing = ch.id;
  document.querySelectorAll('.chan').forEach((e, i) => e.classList.toggle('playing', i === ci));
  $('#nosignal').classList.add('hidden');
  const url = `/live/${ch.id}/index.m3u8?v=${viewer}`;
  if (window.Hls?.isSupported()) {
    const hls = new Hls({ liveSyncDurationCount: 3, manifestLoadingMaxRetry: 4, lowLatencyMode: false });
    S.hls = hls;
    hls.loadSource(url); hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal || S.hls !== hls) return; // not this channel any more
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => { if (S.hls === hls) hls.startLoad(); }, 2000);
      else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
    });
  } else { video.src = url; video.play().catch(() => {}); }
  showOsd();
}
function leave() {
  if (S.playing != null) fetch(`/live/${S.playing}/stop?v=${viewer}`, { method: 'POST', keepalive: true }).catch(() => {});
  S.hls?.destroy(); S.hls = null;
}
addEventListener('pagehide', leave);

// ---- on-screen banner: channel, what's on with a progress bar + minutes left, what's next, and pause/rewind state
let osdTimer, osdTick, osdDigits = '';
const playingChannel = () => S.allChannels.find((c) => c.id === S.playing);
/** How far behind the live edge we are (seconds), e.g. after pausing or rewinding. */
function behindSec() {
  if (!S.hls || !S.hls.liveSyncPosition) return 0;
  return Math.max(0, S.hls.liveSyncPosition - video.currentTime);
}
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function renderOsd() {
  const osd = $('#osd');
  if (osdDigits) { osd.replaceChildren(h('span', { class: 'n' }, osdDigits + '_')); return; }
  const ch = playingChannel();
  if (!ch) return;
  const behindRaw = behindSec(), behind = behindRaw > 20 ? behindRaw : 0; // a few seconds of live latency is normal
  const t = Date.now() / 1000 - behind;                                    // the broadcast time we are actually watching
  const cur = currentOf(ch, t), nxt = nextOf(ch, t);
  const state = video.paused ? '⏸ Paused' : behind ? `⏪ ${fmtClock(behind)} behind live` : '';
  // music and radio: follow the track being watched (a programme is half an hour of tracks)
  const trk = cur?.trk?.find((x) => x[0] <= t && x[1] > t);
  const nxtTrk = trk && cur.trk.find((x) => x[0] >= trk[1] - 1 && x !== trk);
  const [from, to] = trk ? [trk[0], trk[1]] : cur ? [cur.start, cur.end] : [0, 1];
  const pct = cur ? Math.min(100, Math.max(0, ((t - from) / Math.max(1, to - from)) * 100)) : 0;
  const left = cur ? Math.max(1, Math.ceil((to - t) / 60)) : 0;
  osd.replaceChildren(
    h('div', {}, h('span', { class: 'n' }, ch.number ?? ''), h('span', { class: 'nm' }, ch.name), state ? h('span', { class: 'st' }, state) : null),
    cur ? h('div', { class: 'l now' }, trk ? trk[2] : `${cur.title}${cur.subtitle ? ' – ' + cur.subtitle : ''}`) : h('div', { class: 'l now' }, 'Adverts and announcements'),
    cur ? h('div', { class: 'prog' }, h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })), h('span', {}, trk ? `${fmtClock(Math.max(0, to - t))} left · until ${fmtTime(to)}` : `${left} min left · until ${fmtTime(cur.end)}`)) : null,
    nxtTrk ? h('div', { class: 'l' }, `Next: ${nxtTrk[2]}  (${fmtTime(nxtTrk[0])})`) : nxt ? h('div', { class: 'l' }, `Next: ${nxt.title}  (${fmtTime(nxt.start)})`) : null,
    behind ? h('div', { class: 'l' }, 'Press L (or End) to jump back to live') : null);
}
function showOsd(ms = 4500) {
  renderOsd();
  $('#osd').classList.add('show');
  clearTimeout(osdTimer); clearInterval(osdTick);
  osdTick = setInterval(renderOsd, 1000);
  if (!video.paused || osdDigits) osdTimer = setTimeout(hideOsd, ms); // stays up while paused
}
function hideOsd() { clearInterval(osdTick); $('#osd').classList.remove('show'); }
video.addEventListener('pause', () => { if (S.playing != null && video.readyState > 0) showOsd(); });
video.addEventListener('play', () => { if (S.playing != null) showOsd(3000); });

// ---- pause / rewind live TV (the server keeps a rolling buffer; see "Pause buffer" in Settings)
function togglePause() {
  if (S.playing == null) return;
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
function seekBy(sec) {
  if (S.playing == null || !video.seekable.length) return;
  const lo = video.seekable.start(0), hi = video.seekable.end(video.seekable.length - 1);
  video.currentTime = Math.min(hi - 1, Math.max(lo, video.currentTime + sec));
  showOsd();
}
function goLive() {
  if (!S.hls) return;
  video.currentTime = S.hls.liveSyncPosition || video.currentTime;
  video.play().catch(() => {});
  showOsd();
}
const autoFullscreen = () => localStorage.getItem('wbtv-autofs') !== '0';
const goFullscreen = () => { if (!document.fullscreenElement) $('#player').requestFullscreen?.().catch(() => {}); };
const exitFullscreen = () => { if (document.fullscreenElement) document.exitFullscreen(); };
const toggleFullscreen = () => (document.fullscreenElement ? exitFullscreen() : goFullscreen());
$('#video').addEventListener('dblclick', toggleFullscreen);
$('#backBtn').addEventListener('click', exitFullscreen);
document.addEventListener('fullscreenchange', () => {
  // back on the guide: highlight what is currently playing
  if (!document.fullscreenElement && S.playing != null) {
    const ci = S.channels.findIndex((c) => c.id === S.playing);
    if (ci >= 0) selectNow(ci, true);
  }
});

// ------------------------------------------------------------------ keyboard
function stepProg(dir) {
  const ch = S.channels[S.selCh]; const list = progsFor(ch);
  const i = list.findIndex((p) => p.id === S.selProg?.id);
  const n = list[i + dir];
  if (n) { S.selProg = n; paintSel(); }
}
function stepChannel(dir) {
  const ci = Math.max(0, Math.min(S.channels.length - 1, S.selCh + dir));
  if (ci === S.selCh) return;
  const now = Date.now() / 1000, cur = S.selProg;
  const anchor = cur && cur.start <= now && cur.end > now ? now : (cur?.start ?? now) + 1;
  S.selCh = ci;
  const list = progsFor(S.channels[ci]);
  S.selProg = list.find((p) => p.start <= anchor && p.end > anchor) || list.find((p) => p.start > anchor) || list.at(-1) || null;
  paintSel();
}
function channelUpDown(dir) {
  let idx = S.channels.findIndex((c) => c.id === S.playing);
  if (idx < 0) idx = S.selCh - dir; // playing channel is filtered out of the list: start from the selection
  const ci = (idx + dir + S.channels.length) % S.channels.length;
  S.selCh = ci; selectNow(ci, true); tune(ci);
}

let digitTimer;
addEventListener('keydown', (e) => {
  if (!$('#modal').classList.contains('hidden') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (!S.channels.length) return;
  const fs = !!document.fullscreenElement;
  switch (e.key) {
    case 'ArrowLeft': fs ? seekBy(-10) : stepProg(-1); break;
    case 'ArrowRight': fs ? seekBy(10) : stepProg(1); break;
    case 'ArrowUp': fs ? channelUpDown(-1) : stepChannel(-1); break;
    case 'ArrowDown': fs ? channelUpDown(1) : stepChannel(1); break;
    case 'PageUp': channelUpDown(-1); break;
    case 'PageDown': channelUpDown(1); break;
    case 'Enter': { const ch = S.channels[S.selCh]; if (tunable(ch, S.selProg)) tune(S.selCh); break; }
    case ' ': case 'k': case 'K': togglePause(); break;
    case 'l': case 'L': case 'End': goLive(); break;
    case '[': cycleFilter(-1); break;
    case ']': cycleFilter(1); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'g': case 'G': exitFullscreen(); break;
    case 'm': case 'M': video.muted = !video.muted; break;
    case 'i': case 'I': if (S.playing != null) showOsd(); break;
    default:
      if (/^\d$/.test(e.key)) {
        S.digits = (S.digits + e.key).slice(-3);
        osdDigits = S.digits;
        showOsd(2500);
        clearTimeout(digitTimer);
        digitTimer = setTimeout(() => {
          const ci = S.channels.findIndex((c) => c.number === Number(S.digits));
          S.digits = ''; osdDigits = '';
          if (ci >= 0) { selectNow(ci, true); tune(ci); } else hideOsd();
        }, 1400);
      } else return;
  }
  e.preventDefault();
});

// clock + periodic refresh
setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#gdate').textContent = new Date().toLocaleString([], { hour: 'numeric', minute: '2-digit', weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const nl = $('#nowline');
  if (nl && S.epg) nl.style.left = `calc(var(--chw) + ${(Date.now() / 1000 - epgFrom) / 60 * PX}px)`;
}, 1000);
setInterval(() => loadGuide(true).catch(() => {}), 5 * 60 * 1000);

// ------------------------------------------------------------------ setup dialog
$('#settingsBtn').addEventListener('click', openSetup);
let setupTab = 'libraries';
let pollTimer;

function closeModal() { clearInterval(pollTimer); $('#modal').classList.add('hidden'); loadGuide(true).catch(() => {}); }

async function openSetup() {
  $('#modal').classList.remove('hidden');
  renderSetup();
}
function renderSetup() {
  const m = $('#modal');
  const tabs = [['libraries', 'Libraries'], ['live', 'Live TV'], ['channels', 'Channels'], ['ads', 'Ads'], ['announce', 'Announcements'], ['mvdb', 'Music videos'], ['settings', 'Settings'], ['appearance', 'Appearance']];
  const body = h('div', { class: 'body' });
  m.replaceChildren(h('div', { class: 'dlg' },
    h('header', {}, h('img', { src: '/img/logo.png', alt: 'WBTV', style: 'height:30px;margin-right:10px' }), h('b', { style: 'margin-right:12px' }, 'Setup'),
      tabs.map(([k, l]) => h('button', { class: `tab ${k === setupTab ? 'on' : ''}`, onclick: () => { setupTab = k; renderSetup(); } }, l)),
      h('button', { class: 'x', onclick: closeModal }, 'Close ✕')), body));
  clearInterval(pollTimer);
  ({ libraries: tabLibraries, live: tabLive, channels: tabChannels, ads: tabAds, announce: tabAnnounce, mvdb: tabMusicVideos, settings: tabSettings, appearance: tabAppearance })[setupTab](body);
}

// ---- Music videos (IMVDb): browse your artists, see their videos, download the ones you pick ----------------------------------------------
async function tabMusicVideos(body) {
  const st = await api('/api/imvdb/status');
  const intro = h('p', { class: 'note' }, 'Optional. Uses IMVDb (the Internet Music Video Database) to list each artist\'s music videos, and downloads the ones you pick into your Music Video folder as "Artist/Artist - Title.mp4" with the correct release year and genre. You need your own free IMVDb app key (imvdb.com/developers/apps/new). Downloading from YouTube or Vimeo may go against their terms: it is your choice to use this, and it is off until you set it up.');
  const msg = h('div', {});
  const keyBox = h('input', { type: 'password', placeholder: st.keySet ? 'Key saved (enter a new one to replace it)' : 'IMVDb app key', style: 'width:320px', autocomplete: 'off' });
  const saveKey = h('button', { onclick: async () => { try { await api('/api/imvdb/key', { method: 'PUT', body: { key: keyBox.value } }); renderSetup(); } catch (e) { msg.replaceChildren(h('div', { class: 'err' }, e.message)); } } }, 'Save key');
  const clearKey = st.keySet ? h('button', { class: 'sm danger', onclick: async () => { await api('/api/imvdb/key', { method: 'PUT', body: { key: '' } }); renderSetup(); } }, 'Remove key') : null;
  const keyRow = h('div', { class: 'row2' }, keyBox, saveKey, clearKey);
  body.append(intro, keyRow, msg);
  if (!st.ready) {
    body.append(h('h3', {}, 'Not ready yet'), h('ul', {}, st.problems.map((p) => h('li', {}, p))),
      h('p', { class: 'note' }, 'WBTV keeps your media read-only by default. To use this you make just the music video folder writable in your Docker setup, for example: "- /path/to/Music Video:/path/to/Music Video" without ":ro". Your key is stored on the server and never shown here.'));
    return;
  }
  const left = h('div', { style: 'flex:0 0 260px;max-height:420px;overflow:auto' });
  const right = h('div', { style: 'flex:1;min-width:300px' }, h('p', { class: 'note' }, 'Pick an artist on the left.'));
  const queue = h('div', {});
  const search = h('input', { type: 'text', placeholder: 'Find an artist…', style: 'width:100%' });
  let artists = [];
  const renderArtists = () => {
    const t = search.value.toLowerCase();
    left.replaceChildren(...artists.filter((a) => !t || a.name.toLowerCase().includes(t)).slice(0, 200).map((a) =>
      h('div', { class: 'chrow', style: 'cursor:pointer;padding:3px 4px', onclick: () => openArtist(a.name) }, `${a.name} `, h('span', { class: 'note' }, `${a.albums} album${a.albums === 1 ? '' : 's'}${a.have ? ` · ${a.have} video${a.have === 1 ? '' : 's'}` : ''}`))));
  };
  search.addEventListener('input', renderArtists);
  async function openArtist(name) {
    right.replaceChildren(h('p', { class: 'note' }, `Looking up ${name} on IMVDb…`));
    try {
      const found = await api('/api/imvdb/search?q=' + encodeURIComponent(name));
      if (!found.length) { right.replaceChildren(h('p', { class: 'note' }, `IMVDb has no artist called "${name}".`)); return; }
      const exact = found.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (exact || found.length === 1) return showVideos((exact || found[0]).id, name);
      right.replaceChildren(h('p', {}, `Which "${name}"?`), ...found.map((f) => h('div', {}, h('button', { class: 'sm', onclick: () => showVideos(f.id, name) }, 'Choose'), ` ${f.name} (${f.videos} videos)`)));
    } catch (e) { right.replaceChildren(h('div', { class: 'err' }, e.message)); }
  }
  async function showVideos(id, name) {
    right.replaceChildren(h('p', { class: 'note' }, 'Loading videos…'));
    try {
      const d = await api(`/api/imvdb/entity/${encodeURIComponent(id)}?artist=${encodeURIComponent(name)}`);
      const checks = [];
      const rows = d.videos.sort((a, b) => (a.year || 0) - (b.year || 0)).map((v) => {
        const c = h('input', { type: 'checkbox', disabled: v.have || ['queued', 'running', 'done'].includes(v.job) });
        checks.push([c, v]);
        return h('tr', {}, h('td', {}, c), h('td', {}, String(v.year || '')), h('td', {}, v.title), h('td', { class: v.job === 'failed' ? 'err' : '' }, v.have ? 'in your library' : v.job || ''));
      });
      const missing = d.videos.filter((v) => !v.have && !['queued', 'running', 'done'].includes(v.job));
      const queueVideos = async (list) => { if (!list.length) return; await api('/api/imvdb/jobs', { method: 'POST', body: { artist: name, videos: list.map((v) => ({ id: v.id, title: v.title, year: v.year })) } }); showVideos(id, name); loadQueue(); };
      right.replaceChildren(h('h3', {}, `${d.entity.name || name}: ${d.total || d.videos.length} videos on IMVDb`),
        h('div', { class: 'row2' },
          h('button', { onclick: () => queueVideos(checks.filter(([c]) => c.checked).map(([, v]) => v)) }, 'Download selected'),
          h('button', { onclick: () => { if (missing.length < 15 || confirm(`Download ${missing.length} videos?`)) queueVideos(missing); } }, `Download all missing (${missing.length})`)),
        d.videos.length ? h('table', {}, h('tr', {}, ['', 'Year', 'Title', ''].map((t) => h('th', {}, t))), rows) : h('p', { class: 'note' }, 'No videos listed.'));
    } catch (e) { right.replaceChildren(h('div', { class: 'err' }, e.message)); }
  }
  async function loadQueue() {
    const jobs = await api('/api/imvdb/jobs').catch(() => []);
    queue.replaceChildren(h('h3', {}, `Downloads (${jobs.filter((j) => j.status === 'queued' || j.status === 'running').length} waiting)`),
      jobs.length ? h('table', {}, h('tr', {}, ['Artist', 'Title', 'Status', ''].map((t) => h('th', {}, t))), jobs.slice(0, 60).map((j) => h('tr', {}, h('td', {}, j.artist), h('td', {}, j.title),
        h('td', { class: j.status === 'failed' ? 'err' : '', title: j.error || '' }, j.status === 'failed' ? `failed: ${j.error || ''}` : j.status),
        h('td', {}, j.status === 'failed' ? h('span', {}, h('button', { class: 'sm', onclick: async () => { await api(`/api/imvdb/jobs/${j.id}/retry`, { method: 'POST', body: {} }); loadQueue(); } }, 'Retry'), /^Not kept/.test(j.error || '') ? h('button', { class: 'sm', title: 'Download it again and keep it even though it looked like a still image or a lyric / audio upload', onclick: async () => { await api(`/api/imvdb/jobs/${j.id}/retry`, { method: 'POST', body: { force: true } }); loadQueue(); } }, 'Keep anyway') : null) : j.status === 'queued' ? h('button', { class: 'sm', onclick: async () => { await api(`/api/imvdb/jobs/${j.id}/cancel`, { method: 'POST', body: {} }); loadQueue(); } }, 'Cancel') : '')))) : h('p', { class: 'note' }, 'Nothing queued.'),
      jobs.some((j) => ['done', 'failed', 'cancelled'].includes(j.status)) ? h('button', { class: 'sm', onclick: async () => { await api('/api/imvdb/jobs', { method: 'DELETE' }); loadQueue(); } }, 'Clear finished') : null);
  }
  body.append(h('h3', {}, 'Your artists'), h('div', { style: 'display:flex;gap:14px;flex-wrap:wrap' }, h('div', { style: 'flex:0 0 260px' }, search, left), right), queue);
  artists = await api('/api/imvdb/artists').catch(() => []);
  renderArtists();
  loadQueue();
  clearInterval(pollTimer);
  pollTimer = setInterval(loadQueue, 4000);
}

const LIB_TYPES = {
  tv: 'TV Shows', movies: 'Movies', music: 'Music videos', radio: 'Radio (music files)', talk_interviews: 'Radio: interviews', talk_podcasts: 'Radio: podcasts', talk_audiobooks: 'Radio: audiobooks', iptv: 'Live TV / IPTV',
  ads_tv: 'Ads – TV channels only', ads_movies: 'Ads / trailers – Movie channels only', ads: 'Ads – any channel', ads_idents: 'Station idents / bumpers', clips: 'Clips / interviews (shuffled video)',
};
const isAdsLib = (l) => l.type.startsWith('ads');
const isMediaLib = (l) => !isAdsLib(l) && l.type !== 'iptv';

/** scan status + progress bar; `onIdle` runs when no scan is running */
function scanStatus(box, onIdle) {
  const tick = async () => {
    const s = await api('/api/scan').catch(() => null);
    if (!s) return;
    box.replaceChildren(s.running
      ? h('div', {}, h('b', {}, `Scanning: ${s.phase}`), s.library ? ` — ${s.library}` : '', h('div', { class: 'bar' }, h('i')),
        h('span', { class: 'note' }, `${s.dirs} folders · ${s.files} files · ${s.changed} new/changed${s.probe ? ` · probing ${s.probe}` : ''}`))
      : s.error ? h('div', { class: 'err' }, `Last scan failed: ${s.error.split('\n')[0]}`)
        : s.finished ? h('div', { class: 'ok' }, `Last scan: ${s.files} files in ${((s.finished - s.started) / 1000).toFixed(1)}s`) : '');
    if (!s.running) { clearInterval(pollTimer); onIdle(); }
  };
  clearInterval(pollTimer);
  pollTimer = setInterval(tick, 1000); tick();
}

/** Channel group and mode for a library: libraries that share a group name become one channel; mode says whether the library also gets its normal genre / studio / decade channels. */
function groupControls(l, reload) {
  if (!['tv', 'movies', 'music', 'clips'].includes(l.type)) return null;
  const set = (b) => api(`/api/libraries/${l.id}`, { method: 'PATCH', body: b }).then(reload).catch((e) => alert(e.message));
  const modes = l.type === 'clips' ? [['single', 'one channel']] : [['inferred', 'genre / studio channels'], ['single', 'one channel'], ['both', 'both']];
  return h('div', { class: 'note', title: 'Libraries that share a group name are merged into one channel. "One channel" skips the genre, studio and decade channels for this library; "both" keeps them as well.' },
    'Channel group: ', h('input', { type: 'text', value: l.channel_group || '', placeholder: l.type === 'clips' ? l.name : 'none', style: 'width:130px', onchange: (e) => set({ group: e.target.value }) }), ' ',
    h('select', { onchange: (e) => set({ groupMode: e.target.value }) }, modes.map(([v, t]) => h('option', { value: v, selected: v === (l.type === 'clips' ? 'single' : l.group_mode || 'inferred') }, t))));
}

function libTable(libs, reload, poll) {
  if (!libs.length) return h('p', { class: 'note' }, 'None yet.');
  return h('table', {},
    h('tr', {}, ['Name', 'Path', 'Type', 'Items', ''].map((t) => h('th', {}, t))),
    libs.map((l) => h('tr', {}, h('td', {}, l.name, groupControls(l, reload), l.perTitle !== undefined ? h('div', { class: 'note' }, h('label', { title: 'Each show or book gets its own channel, always playing in order and looping. Off: one station for the whole library.' }, h('input', { type: 'checkbox', checked: !!l.perTitle, onchange: async (e) => { await api(`/api/libraries/${l.id}`, { method: 'PATCH', body: { perTitle: e.target.checked } }).catch((er) => alert(er.message)); reload(); } }), ' one channel per show / book')) : null), h('td', { style: 'word-break:break-all' }, l.path.startsWith('ms://') ? 'Media server library' : l.path), h('td', {}, LIB_TYPES[l.type] || l.type),
      h('td', {}, String(isAdsLib(l) ? l.ads : l.type === 'iptv' ? '' : l.items)),
      h('td', {}, h('button', { class: 'sm', onclick: async () => { await api('/api/scan', { method: 'POST', body: { libraryId: l.id } }); poll(); } }, 'Scan'), ' ',
        h('button', { class: 'sm danger', onclick: async () => { if (confirm(`Remove "${l.name}" from WBTV? (files are not touched)`)) { await api(`/api/libraries/${l.id}`, { method: 'DELETE' }); reload(); } } }, 'Remove')))));
}

/** Read libraries from a media server instead of from folders: Jellyfin / Emby (TV and films) or Navidrome (music, for the radio stations). */
function addMediaServerForm(onAdded) {
  const kind = h('select', {}, [['jellyfin', 'Jellyfin / Emby (TV and films)'], ['navidrome', 'Navidrome (music for radio)']].map(([v, l]) => h('option', { value: v }, l)));
  const url = h('input', { type: 'text', placeholder: 'Server address, e.g. 192.168.1.111:8096', style: 'flex:1;min-width:200px' });
  const key = h('input', { type: 'password', placeholder: 'API key (Jellyfin: Dashboard > API Keys)', style: 'flex:1;min-width:200px', autocomplete: 'off' });
  const user = h('input', { type: 'text', placeholder: 'Navidrome username', style: 'width:170px', autocomplete: 'off' });
  const pass = h('input', { type: 'password', placeholder: 'Password', style: 'width:150px', autocomplete: 'off' });
  const out = h('div', {});
  const show = () => {
    const nav = kind.value === 'navidrome';
    key.style.display = nav ? 'none' : ''; user.style.display = pass.style.display = nav ? '' : 'none';
    url.placeholder = nav ? 'Server address, e.g. 192.168.1.110:4534' : 'Server address, e.g. 192.168.1.111:8096';
  };
  kind.onchange = show; show();
  const connect = h('button', { onclick: async () => {
    out.replaceChildren(h('div', { class: 'note' }, 'Connecting...'));
    try {
      const nav = kind.value === 'navidrome';
      const d = await api('/api/sources', { method: 'POST', body: nav ? { kind: 'navidrome', url: url.value, username: user.value, password: pass.value } : { url: url.value, token: key.value } });
      key.value = ''; pass.value = ''; // the password is only used to log in once; WBTV keeps a token, not the password
      const label = (v) => (v.type === 'tv' ? 'TV shows' : v.type === 'radio' ? 'Music, as radio stations' : 'Movies');
      out.replaceChildren(h('div', { class: 'note' }, `Connected to ${d.name} (${d.product} ${d.version}). Add the libraries you want:`),
        d.views.length ? d.views.map((v) => h('div', { class: 'row2' }, h('span', { style: 'width:300px' }, `${v.name} (${label(v)})`),
          h('button', { onclick: async (e) => {
            try { await api('/api/libraries', { method: 'POST', body: { sourceId: d.id, viewId: v.id, type: v.type, name: `${d.name}: ${v.name}` } }); e.target.disabled = true; e.target.textContent = 'Added'; onAdded(); }
            catch (err) { e.target.textContent = err.message; }
          } }, 'Add'))) : h('div', { class: 'note' }, 'That server has no libraries WBTV can use.'));
    } catch (e) { out.replaceChildren(h('div', { class: 'err' }, e.message)); }
  } }, 'Connect');
  return h('div', {}, h('div', { class: 'row2' }, kind, url, key, user, pass, connect), out);
}

async function tabLibraries(body) {
  const status = h('div', {});
  const list = h('div', {});
  body.append(status, list, h('h3', {}, 'Add a library'), addLibraryForm(() => { reload(); poll(); }, ['tv', 'movies', 'music', 'clips', 'radio', 'talk_interviews', 'talk_podcasts', 'talk_audiobooks']),
    h('h3', {}, 'Or read libraries from a media server'),
    h('p', { class: 'note' }, 'Jellyfin / Emby for TV and films, Navidrome for music. WBTV reads titles, genres and pictures through the server API and plays the originals from it, so channels are built just like from folders. The key (or, for Navidrome, a login token; the password is not kept) stays on the WBTV server. See the README for when folders are the better choice.'),
    addMediaServerForm(() => { reload(); poll(); }),
    h('p', { class: 'note' }, 'Music videos: video files with an Artist - Title name (or a <musicvideo> NFO). Radio: audio files; tags are read from the files. Both build themed channels automatically. Live TV and news streams are on the Live TV tab.'));
  const poll = () => scanStatus(status, reload);
  async function reload() {
    const libs = (await api('/api/libraries')).filter(isMediaLib);
    list.replaceChildren(libTable(libs, reload, poll),
      h('div', { class: 'row2' }, h('button', { onclick: async () => { await api('/api/scan', { method: 'POST', body: {} }); poll(); } }, 'Scan all libraries')));
  }
  reload(); poll();
}

function addLibraryForm(onAdded, types) {
  const state = { path: '', type: types[0] };
  const pathBox = h('input', { type: 'text', placeholder: '/mnt/Main20TB/Media/...', style: 'flex:1;min-width:260px', oninput: (e) => (state.path = e.target.value) });
  const typeSel = h('select', { onchange: (e) => (state.type = e.target.value) }, types.map((t) => h('option', { value: t }, LIB_TYPES[t])));
  const browser = h('div', { class: 'browser hidden' });
  const msg = h('div', {});
  async function browse(p) {
    const r = await api('/api/browse?path=' + encodeURIComponent(p || '')).catch((e) => ({ error: e.message }));
    if (r.error) { browser.replaceChildren(h('div', { class: 'err' }, r.error)); return; }
    browser.classList.remove('hidden');
    pathBox.value = state.path = r.path;
    browser.replaceChildren(
      r.path ? h('div', { onclick: () => browse(r.parent) }, '⬑ ..') : null,
      r.dirs.map((d) => h('div', { onclick: () => browse(d.path) }, '📁 ' + d.name)),
      !r.dirs.length ? h('div', { class: 'note' }, 'No sub-folders') : null);
  }
  return h('div', {},
    h('div', { class: 'row2' }, pathBox, h('button', { onclick: () => browse(pathBox.value) }, 'Browse…')),
    browser,
    h('div', { class: 'row2' }, h('span', {}, 'This folder contains:'), typeSel,
      h('button', { onclick: async () => {
        try { await api('/api/libraries', { method: 'POST', body: { path: state.path, type: state.type } }); pathBox.value = ''; msg.replaceChildren(h('span', { class: 'ok' }, 'Added — scanning…')); onAdded(); }
        catch (e) { msg.replaceChildren(h('span', { class: 'err' }, e.message)); }
      } }, 'Add')),
    msg);
}

async function tabLive(body) {
  const [presets, sum, libs] = await Promise.all([api('/api/live/presets'), api('/api/live/summary'), api('/api/libraries')]);
  const status = h('div', {});
  const name = h('input', { type: 'text', placeholder: 'Name (optional)', style: 'width:200px' });
  const url = h('input', { type: 'text', placeholder: 'Playlist (.m3u/.m3u8), single stream, or YouTube live link', style: 'flex:1;min-width:300px' });
  const msg = h('span', { class: 'note' });
  const add = async (u, n) => {
    try { await api('/api/libraries', { method: 'POST', body: { path: u, type: 'iptv', name: n || undefined } }); msg.textContent = 'Added. Fetching and testing streams…'; scanStatus(status, () => setTimeout(renderSetup, 800)); }
    catch (e) { msg.textContent = e.message; msg.className = 'err'; }
  };
  const have = new Set(libs.map((l) => l.path));
  body.append(
    status,
    h('p', { class: 'note' }, 'Live channels (news, music TV, radio stations, any HLS stream) have no schedule: you join what is on right now. WBTV re-encodes them to match everything else and tests each stream so dead ones are hidden.'),
    h('h3', { style: 'margin-top:0' }, 'Add a playlist or stream'),
    h('div', { class: 'row2' }, name, url, h('button', { onclick: () => add(url.value.trim(), name.value.trim()) }, 'Add')), msg,
    h('h3', {}, 'Suggested sources'),
    h('table', {}, presets.map((p) => h('tr', {}, h('td', {}, h('b', {}, p.name), h('div', { class: 'note' }, p.note)),
      h('td', { style: 'width:90px' }, have.has(p.url) ? h('span', { class: 'ok' }, 'added') : h('button', { class: 'sm', onclick: () => add(p.url, p.name) }, 'Add'))))),
    h('p', { class: 'note' }, 'These are public community lists of free streams, not run by WBTV; availability changes and some streams are dead or region-locked. You can also paste a YouTube live URL (e.g. a news channel\'s live stream).'),
    h('h3', {}, 'Your live sources'),
    sum.length ? h('table', {}, h('tr', {}, ['Name', 'Streams', 'Working', 'Dead', 'On air', ''].map((t) => h('th', {}, t))),
      sum.map((l) => h('tr', {}, h('td', { style: 'word-break:break-all' }, l.name), h('td', {}, String(l.total)),
        h('td', {}, String(l.alive ?? 0) + (l.unchecked ? ` (+${l.unchecked} testing…)` : '')), h('td', {}, String(l.dead ?? 0)), h('td', {}, String(l.on_air ?? 0)),
        h('td', {}, h('button', { class: 'sm', onclick: async () => { await api(`/api/live/${l.id}/enable`, { method: 'POST', body: { enabled: true } }); renderSetup(); } }, 'Enable all working'), ' ',
          h('button', { class: 'sm', onclick: async () => { await api(`/api/live/${l.id}/enable`, { method: 'POST', body: { enabled: false } }); renderSetup(); } }, 'Disable all'), ' ',
          h('button', { class: 'sm', onclick: async () => { await api('/api/scan', { method: 'POST', body: { libraryId: l.id } }); scanStatus(status, () => setTimeout(renderSetup, 800)); } }, 'Refresh'), ' ',
          h('button', { class: 'sm danger', onclick: async () => { if (confirm('Remove this source and its channels?')) { await api(`/api/libraries/${l.id}`, { method: 'DELETE' }); renderSetup(); } } }, 'Remove'))))) : h('p', { class: 'note' }, 'None yet.'),
    h('div', { class: 'row2' }, h('button', { onclick: async () => { await api('/api/live/recheck', { method: 'POST', body: {} }); msg.textContent = 'Re-testing dead streams in the background…'; setTimeout(renderSetup, 4000); } }, 'Re-test dead streams'),
      h('span', { class: 'note' }, 'Big playlists start with the first 80 working channels on. Switch more on in the Channels tab (use the search box).')));
  if (sum.some((l) => l.unchecked)) pollTimer = setInterval(() => { if (setupTab === 'live') renderSetup(); }, 6000);
}

function logoCell(c) {
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: 'display:none' });
  const cell = h('span', {});
  const draw = (has) => {
    cell.replaceChildren(
      has ? h('img', { src: `/api/channels/${c.id}/logo?t=${Date.now()}`, style: 'height:22px;vertical-align:middle;margin-right:6px', title: 'Shown on screen in the corner of programmes' }) : null,
      h('button', { onclick: () => file.click() }, has ? 'Change' : 'Add'),
      has ? h('button', { onclick: async () => { await api(`/api/channels/${c.id}/logo`, { method: 'DELETE' }); draw(false); } }, '✕') : null);
  };
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    const r = await fetch(`/api/channels/${c.id}/logo`, { method: 'PUT', headers: { 'Content-Type': f.type }, body: f });
    if (r.status === 401) return location.reload();
    if (!r.ok) return alert((await r.json().catch(() => ({}))).error || 'Upload failed');
    draw(true);
  });
  draw(c.logo);
  return [cell, file];
}

async function tabChannels(body) {
  const chans = await api('/api/channels?all=1');
  const rows = chans.map((c) => {
    const patch = (b) => api(`/api/channels/${c.id}`, { method: 'PATCH', body: b }).catch((e) => alert(e.message));
    return h('tr', { class: 'chrow', 'data-n': `${c.name} ${c.number} ${c.key}`.toLowerCase(), 'data-id': c.id, 'data-items': c.item_count, style: c.item_count ? '' : 'opacity:.45' },
      h('td', {}, h('input', { type: 'number', value: c.number ?? '', min: 1, onchange: (e) => patch({ number: Number(e.target.value) }) })),
      h('td', {}, h('input', { type: 'text', value: c.name, style: 'width:100%', onchange: (e) => patch({ name: e.target.value === c.auto_name ? '' : e.target.value }) })),
      h('td', {}, ({ movie: 'Movies', music: 'Music', clips: 'Clips', radio: 'Radio', live: 'Live' }[c.kind] || 'TV')), h('td', { title: c.item_count || c.kind === 'live' ? '' : 'Nothing is in this channel: its library was removed or no longer has matching content. It stays here so your name and number come back if it returns.' }, c.kind === 'live' ? (c.item_count ? 'on air' : 'dead') : c.item_count ? String(c.item_count) : 'empty'),
      h('td', { class: 'note' }, c.key.replace(/^(tv|movie):/, '')),
      h('td', {}, h('input', { type: 'checkbox', checked: !!c.enabled, onchange: (e) => patch({ enabled: e.target.checked }) })),
      h('td', {}, logoCell(c)),
      h('td', {}, !c.item_count && c.kind !== 'live' ? h('button', { class: 'sm danger', title: 'Remove this empty channel', onclick: async () => { await api(`/api/channels/${c.id}`, { method: 'DELETE' }).catch((e) => alert(e.message)); renderSetup(); } }, '✕') : ''));
  });
  const q = h('input', { type: 'text', placeholder: 'Search channels…', style: 'min-width:220px' });
  const apply = () => { const t = q.value.toLowerCase(); for (const r of document.querySelectorAll('.chrow')) r.style.display = !t || r.dataset.n.includes(t) ? '' : 'none'; };
  q.addEventListener('input', apply);
  const bulk = (on) => async () => {
    const shown = [...document.querySelectorAll('.chrow')].filter((r) => r.style.display !== 'none' && r.dataset.items !== '0');
    if (shown.length > 60 && !confirm(`Switch ${on ? 'on' : 'off'} ${shown.length} channels?`)) return;
    for (const r of shown) await api(`/api/channels/${r.dataset.id}`, { method: 'PATCH', body: { enabled: on } }).catch(() => {});
    renderSetup();
  };
  body.append(
    h('div', { class: 'row2' }, q, h('button', { onclick: bulk(true) }, 'Enable shown'), h('button', { onclick: bulk(false) }, 'Disable shown')),
    h('div', { class: 'row2' }, h('button', { onclick: async () => { await api('/api/channels/rebuild', { method: 'POST', body: {} }); renderSetup(); } }, 'Re-infer channels'),
      chans.some((c) => !c.item_count && c.kind !== 'live') ? h('button', { class: 'danger', title: 'Delete every channel that has nothing in it', onclick: async () => { if (confirm(`Remove ${chans.filter((c) => !c.item_count && c.kind !== 'live').length} empty channels?`)) { await api('/api/channels', { method: 'DELETE' }); renderSetup(); } } }, 'Remove empty channels') : null,
      h('span', { class: 'note' }, `${chans.filter((c) => c.item_count).length} channels. Rebuilt automatically after every scan; your renames and numbers are kept. How many get created is controlled in the Settings tab.`)),
    chans.length ? h('table', {}, h('tr', {}, ['No.', 'Name', 'Type', 'Items', 'Source', 'On', 'Logo'].map((t) => h('th', {}, t))), rows) : h('p', { class: 'note' }, 'No channels yet — add a library first.'));
}

const put = (body) => api('/api/settings', { method: 'PUT', body });
const numField = (s, key, label, note, { min = 0, step = 1 } = {}) => h('div', { class: 'row2' }, h('label', { style: 'width:280px' }, label),
  h('input', { type: 'number', min, step, value: s[key], onchange: (e) => put({ [key]: Number(e.target.value) }) }), h('span', { class: 'note' }, note));
const boolField = (s, key, label, note) => h('div', { class: 'row2' }, h('label', {}, h('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => put({ [key]: e.target.checked }) }), ' ' + label),
  h('span', { class: 'note' }, note));

async function tabAds(body) {
  const [s, ads, libs] = await Promise.all([api('/api/settings'), api('/api/ads'), api('/api/libraries')]);
  const adLibs = libs.filter(isAdsLib);
  const ta = h('textarea', { placeholder: 'One link per line — YouTube, archive.org / Wayback Machine, or a direct video URL' });
  const kindSel = h('select', {}, h('option', { value: 'tv' }, 'TV channels'), h('option', { value: 'movie' }, 'Movie channels (trailers)'), h('option', { value: 'all' }, 'Any channel'));
  const msg = h('span', { class: 'note' });
  const status = h('div', {});
  const kindName = { all: 'Any', tv: 'TV', movie: 'Movies', ident: 'Idents' };
  body.append(
    status,
    boolField(s, 'adsEnabled', 'Enable ad breaks', 'Mid-programme breaks, and programmes start on the time grid. Needs some ads below.'),
    h('h3', {}, 'Ad break timing'),
    numField(s, 'breakLengthMinutes', 'Length of each ad break (minutes)', 'Target length; ads play whole, so a break can run a little over.', { min: 0.5, step: 0.5 }),
    numField(s, 'breakEveryMinutes', 'Ad break roughly every (minutes)', 'Programmes under 15 minutes never get a mid-break.', { min: 5 }),
    boolField(s, 'fillGaps', 'Fill the gap between programmes with ads', 'So the next programme starts exactly on the time grid.'),
    numField(s, 'alignMinutes', 'Programme start grid (minutes)', '5 = :00, :05, :10… ; 30 is very authentic. Also the longest gap-filler.', { min: 1 }),
    h('h3', {}, 'Add ad folders'),
    addLibraryForm(() => { reload(); scanStatus(status, reload); }, ['ads_tv', 'ads_movies', 'ads', 'ads_idents']),
    h('p', { class: 'note' }, 'Tag a folder as TV and its ads only appear on TV channels; tag one as Movies (adverts + trailers) for movie channels. A folder of short clips (up to 20 seconds) tagged Station idents is played before programmes instead of the generated ident card (turn idents on in Settings).'),
    h('div', {}, libTable(adLibs, reload, () => scanStatus(status, reload))),
    h('h3', {}, 'Add ads from links'), ta,
    h('div', { class: 'row2' }, h('span', {}, 'Show on:'), kindSel,
      h('button', { onclick: async () => { const r = await api('/api/ads', { method: 'POST', body: { urls: ta.value, kind: kindSel.value } }); msg.textContent = `${r.added} queued — downloading in the background`; ta.value = ''; setTimeout(reload, 2000); } }, 'Add'), msg),
    h('p', { class: 'note' }, 'Links are downloaded once (via yt-dlp) and then played from local storage.'),
    h('h3', {}, `Ad pool (${ads.filter((a) => a.status === 'ready').length} ready)`),
    ads.length ? h('table', {}, h('tr', {}, ['Title', 'Length', 'Channels', 'Status', ''].map((t) => h('th', {}, t))),
      ads.map((a) => h('tr', {}, h('td', { style: 'word-break:break-all' }, a.title || a.source), h('td', {}, a.duration ? `${Math.round(a.duration)}s` : ''), h('td', {}, kindName[a.kind] || a.kind),
        h('td', { class: a.status === 'error' ? 'err' : '', title: a.error || '' }, a.status),
        h('td', {}, h('button', { class: 'sm danger', onclick: async () => { await api(`/api/ads/${a.id}`, { method: 'DELETE' }); reload(); } }, '✕'))))) : h('p', { class: 'note' }, 'No ads yet.'));
  function reload() { if (setupTab === 'ads') renderSetup(); }
  if (ads.some((a) => a.status === 'pending' || a.status === 'downloading')) pollTimer = setInterval(reload, 4000);
}

function moreVoices(st) {
  const more = st.voices.filter((v) => !v.installed && (v.installable || v.installing || v.error));
  if (!more.length) return '';
  if (more.some((v) => v.installing)) setTimeout(() => { if (setupTab === 'announce') renderSetup(); }, 3000);
  return h('div', { class: 'row2', style: 'align-items:flex-start' }, h('label', { style: 'width:280px' }, 'More voices'),
    h('div', {}, more.map((v) => h('div', { style: 'margin-bottom:6px' },
      h('button', { disabled: v.installing, onclick: async () => { await api(`/api/promo/voices/${v.id}/install`, { method: 'POST' }); renderSetup(); } },
        v.installing ? 'Installing…' : `Install: ${v.label} (${v.mb} MB)`),
      v.error ? h('span', { class: 'err', style: 'margin-left:8px' }, v.error) : null)),
      h('p', { class: 'note' }, 'A one-off download from the Piper voice library, kept in your config folder. The "high quality" voices sound the most natural. Choosing a different voice re-plans the announcements.')));
}

async function tabAnnounce(body) {
  const [s, st] = await Promise.all([api('/api/settings'), api('/api/promo/status')]);
  const installed = st.voices.filter((v) => v.installed);
  const voiceSel = h('select', { onchange: (e) => put({ promoVoice: e.target.value }) }, installed.map((v) => h('option', { value: v.id, selected: v.id === s.promoVoice }, v.label)));
  const sampleMsg = h('span', { class: 'note' });
  body.append(
    st.available && installed.length ? '' : h('p', { class: 'err' }, 'The speech engine (Piper) is not installed in this container, so announcements are switched off.'),
    boolField(s, 'promosEnabled', 'Announce what is coming up next', 'Between programmes: a clip from the next programme, with a voice reading out what is on next and after that.'),
    h('div', { class: 'row2' }, h('label', { style: 'width:280px' }, 'Announcer voice'), voiceSel,
      h('button', { onclick: () => { sampleMsg.textContent = 'Loading…'; const a = new Audio('/api/promo/sample?voice=' + voiceSel.value); a.onplaying = () => (sampleMsg.textContent = ''); a.onerror = () => (sampleMsg.textContent = 'Could not play the sample'); a.play().catch(() => {}); } }, '▶ Play sample'), sampleMsg),
    moreVoices(st),
    numField(s, 'promoCount', 'Programmes to mention', 'Up next, after that, later… (1 to 4). Short gaps automatically mention fewer.', { min: 1 }),
    boolField(s, 'promoReadPlots', 'Read out descriptions', 'Uses the plot from each NFO; falls back to the title, genre and year when there is none.'),
    numField(s, 'promoMaxSeconds', 'Longest announcement (seconds)', 'The slot sits just before the next programme, after any ads, so programmes still start on the time grid.', { min: 15 }),
    h('p', { class: 'note' }, 'Voices are generated locally (Piper, offline, no cost) a moment before they air and cached. Changing these re-plans everything that has not aired yet.'));
}

function securityBlock(enabled, key) {
  const pw = h('input', { type: 'password', placeholder: enabled ? 'New password' : 'Choose a password', autocomplete: 'new-password' });
  const msg = h('span', { class: 'note' });
  const origin = location.origin;
  const mono = (t) => h('code', { style: 'display:block;word-break:break-all;margin:2px 0 8px' }, t);
  const setPw = async () => {
    try { await api('/api/auth/password', { method: 'POST', body: { password: pw.value } }); renderSetup(); } catch (e) { msg.textContent = e.message; }
  };
  const rows = [h('div', { class: 'row2' }, pw, h('button', { onclick: setPw }, enabled ? 'Change password' : 'Turn on password'), msg)];
  if (!enabled) rows.push(h('p', { class: 'note' }, 'Off: anyone on your network can open WBTV. Turn it on if you expose WBTV outside your home. Browsers log in once; apps use an access key.'));
  else rows.push(
    h('p', { class: 'note' }, 'A password is set. Other apps (the Android TV app, IPTV players, Plex/Jellyfin) use this access key instead of the password:'),
    mono(key),
    h('p', { class: 'note' }, 'IPTV playlist (key included):'), mono(origin + '/iptv/playlist.m3u?key=' + key),
    h('p', { class: 'note' }, 'XMLTV guide:'), mono(origin + '/iptv/epg.xml?key=' + key),
    h('div', { class: 'row2' },
      h('button', { onclick: async () => { await api('/api/auth/key', { method: 'POST' }); renderSetup(); } }, 'Make a new access key'),
      h('button', { onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); } }, 'Log out'),
      h('button', { onclick: async () => { if (confirm('Remove the password? Anyone on your network will be able to open WBTV.')) { await api('/api/auth', { method: 'DELETE' }); renderSetup(); } } }, 'Remove password')));
  return h('div', {}, rows);
}

async function tabSettings(body) {
  const [s, sc, hwi, au] = await Promise.all([api('/api/settings'), api('/api/scan'), api('/api/hw'), api('/api/auth/status')]);
  const apiKey = au.enabled ? (await api('/api/auth/key')).key : '';
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
  const lastScan = sc.finished ? `Last scan ${ago(sc.finished)}` : 'Not scanned yet';
  const next = sc.nextAuto ? ` · next automatic scan ${sc.nextAuto <= Date.now() ? 'any moment' : 'in ' + Math.max(1, Math.round((sc.nextAuto - Date.now()) / 60000)) + ' min'}` : '';
  body.append(
    h('h3', { style: 'margin-top:0' }, 'Library scanning'),
    boolField(s, 'autoScan', 'Rescan libraries automatically', 'Picks up new, changed and removed media. Scans are incremental, so they are quick.'),
    numField(s, 'scanIntervalMinutes', 'Rescan every (minutes)', 'Network shares give no change notifications, so WBTV checks on this interval.', { min: 5 }),
    boolField(s, 'scanOnStartup', 'Scan when WBTV starts', ''),
    numField(s, 'pauseBufferMinutes', 'Pause / rewind buffer (minutes)', 'How far back you can pause or rewind live TV (0 = off, max 30). Kept in RAM on the server (about 20 MB per minute per watched channel).', { min: 0 }),
    h('div', { class: 'row2' }, h('button', { onclick: async () => { await api('/api/scan', { method: 'POST', body: {} }); setTimeout(renderSetup, 800); } }, 'Scan now'), h('span', { class: 'note' }, lastScan + next + (sc.running ? ' · scanning…' : ''))),
    h('h3', {}, 'Security'),
    securityBlock(au.enabled, apiKey),
    h('h3', {}, 'Smart scheduling'),
    boolField(s, 'autoDaypart', 'Schedule to suit the time of day', 'Uses your genres and age ratings: cartoons and family shows after school and on Saturday mornings, mature and horror late at night, factual by day. Soft preferences, so channels never run dry. Re-plans the schedule.'),
    boolField(s, 'eraAds', 'Match adverts to the era', 'A 1990s programme gets 1990s adverts more often. WBTV reads the year from the ad title or folder name ("1994", "1990s", "80s"). Ads with no year are unaffected.'),
    h('h3', {}, 'Presentation'),
    boolField(s, 'channelBug', 'Channel bug on programmes', 'A small channel logo (add logos in the Channels tab) or, without one, the channel name, in the top-right corner.'),
    boolField(s, 'lyrics', 'Show lyrics on music radio', 'Uses a .lrc (time-synced), .srt or .txt file with the same name as the track, or lyrics stored in the file tags. Plain text is paged across the song as an estimate.'),
    boolField(s, 'identsEnabled', 'Station idents', 'A short ident before each programme: by default a generated 5 second card (big channel number and name), or your own clips if you add a Station idents folder in the Ads tab. Re-plans the schedule.'),
    boolField(s, 'signOffEnabled', 'Closedown overnight', 'TV and movie channels show a test card and tone between these times, then start up again. The guide shows "Off air".'),
    h('div', { class: 'row2' }, h('label', { style: 'width:280px' }, 'Closedown from / to'),
      h('input', { type: 'time', style: 'width:120px', value: s.signOffFrom, onchange: (e) => put({ signOffFrom: e.target.value }) }),
      h('input', { type: 'time', style: 'width:120px', value: s.signOffTo, onchange: (e) => put({ signOffTo: e.target.value }) })),
    h('h3', {}, 'Language and subtitles'),
    h('div', { class: 'row2' }, h('label', { style: 'width:280px' }, 'Preferred language'),
      h('select', { onchange: async (e) => { await put({ language: e.target.value }); renderSetup(); } },
        [['eng', 'English'], ['fre', 'French'], ['ger', 'German'], ['spa', 'Spanish'], ['ita', 'Italian'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['chi', 'Chinese'], ['rus', 'Russian'], ['por', 'Portuguese'], ['dut', 'Dutch'], ['wel', 'Welsh']].map(([v, l]) => h('option', { value: v, selected: v === s.language }, l))),
      h('span', { class: 'note' }, 'If a file has several audio tracks, the one in this language is used.')),
    h('div', { class: 'row2' }, h('label', { style: 'width:280px' }, 'Subtitles'),
      h('select', { onchange: async (e) => { await put({ subtitleMode: e.target.value }); renderSetup(); } },
        [['foreign', 'Only when there is no audio in my language'], ['always', 'Always, when the file has them'], ['off', 'Never']].map(([v, l]) => h('option', { value: v, selected: v === s.subtitleMode }, l))),
      h('span', { class: 'note' }, 'Subtitles are burned into the picture (a live stream has no subtitle menu): from a file beside the video such as Movie.en.srt, or a text track inside it. Tracks inside a file are prepared in the background the first time, so the first showing may not have them. Forced subtitles for foreign dialogue are included.')),
    h('h3', {}, 'Video encoding'),
    h('div', { class: 'row2' }, h('label', { style: 'width:280px' }, 'Stream size'),
      h('select', { onchange: async (e) => { await put({ streamHeight: Number(e.target.value) }); renderSetup(); } },
        [[720, '720p (best picture)'], [576, '576p (about 30% less CPU per channel)'], [480, '480p (lightest)']].map(([v, l]) => h('option', { value: v, selected: v === Number(s.streamHeight) }, l))),
      h('span', { class: 'note' }, 'Lower this if channels are slow to start or the server is busy with other apps. Applies to channels as they start.')),
    h('div', { class: 'row2' }, h('label', { style: 'width:280px' }, 'Hardware encoding'),
      h('select', { onchange: async (e) => { await put({ hwEncoder: e.target.value }); renderSetup(); } },
        [['auto', 'Automatic'], ['none', 'Off (CPU only)'], ['vaapi', 'Intel / AMD GPU (VAAPI)'], ['nvenc', 'NVIDIA (NVENC)']].map(([v, l]) => h('option', { value: v, selected: v === s.hwEncoder }, l)))),
    h('p', { class: 'note' }, 'Now: ' + hwi.note + ' Hardware encoding needs the GPU passed into the container (see the README). WBTV tests it first and falls back to the CPU if it does not work. Applies from the next programme.'),
    h('h3', {}, 'Channel building'),
    numField(s, 'minChannelMinutes', 'Minimum channel size (minutes)', 'A studio/genre needs this much content to get its own channel. Lower = more channels. 0 = every studio.'),
    boolField(s, 'tvGenreChannelsForAll', 'Genre channels for every TV show', 'By default only shows with no (big enough) studio go on genre channels. Turn on to put every show on its genre channels too.'),
    boolField(s, 'movieStudioChannels', 'Movie studio channels', 'e.g. a Warner Bros. film channel.'),
    numField(s, 'movieStudioMinFilms', 'Films needed for a studio channel', '', { min: 1 }),
    boolField(s, 'movieDecadeChannels', 'Movie decade channels', 'e.g. 1990s Cinema.'),
    h('p', { class: 'note' }, 'Changes rebuild the channels and re-plan everything that has not aired yet. Stream quality is set with environment variables (WBTV_WIDTH, WBTV_HEIGHT, WBTV_CRF).'));
}

const THEMES = [
  ['classic', 'Classic', ['#050b2a', '#1a3a9c', '#ffd400', '#3fd0ff']],
  ['vintage', 'Vintage', ['#1b110a', '#8a5226', '#f3d9a0', '#e9a64f']],
  ['90s', '90s', ['#12082b', '#0aa3b5', '#fff200', '#ff4fd8']],
  ['modern', 'Modern', ['#0e0f13', '#22252f', '#4c8dff', '#e8eaf0']],
  ['aero', 'Aero', ['#0b3a5e', '#63b9ec', '#fff0a0', '#d4eefc']],
  ['teletext', 'Teletext', ['#000000', '#0000c8', '#ffff00', '#00ffff']],
  ['synthwave', 'Synthwave', ['#0b021d', '#3a1a7a', '#ff2a6d', '#05d9e8']],
  ['satellite', 'Satellite (classic)', ['#c8dcf4', '#1d3fae', '#ffd90f', '#1c2672']],
  ['satellite-hd', 'Satellite HD', ['#0a2a6e', '#2f6fc4', '#ffd90f', '#ffffff']],
];
function tabAppearance(body) {
  const cur = document.documentElement.dataset.theme;
  body.append(
    h('h3', { style: 'margin-top:0' }, 'Behaviour'),
    h('div', { class: 'row2' }, h('label', {}, h('input', { type: 'checkbox', checked: autoFullscreen(), onchange: (e) => localStorage.setItem('wbtv-autofs', e.target.checked ? '1' : '0') }), ' Go fullscreen when I select a programme'),
      h('span', { class: 'note' }, 'Off: the channel plays in the small preview and you press Enter on it again (or F) for fullscreen.')),
    h('h3', {}, 'Theme'), h('p', { class: 'note' }, 'Behaviour and theme are remembered in this browser.'),
    h('div', { class: 'themes' }, THEMES.map(([id, name, sw]) => h('button', {
      class: `theme ${id === cur ? 'on' : ''}`,
      onclick: () => { document.documentElement.dataset.theme = id; localStorage.setItem('wbtv-theme', id); renderSetup(); },
    }, h('div', { class: 'swatch' }, sw.map((c) => h('i', { style: `background:${c}` }))), name))));
}

// ------------------------------------------------------------------ boot
async function gate() {
  const st = await fetch('/api/auth/status').then((r) => r.json()).catch(() => ({ enabled: false }));
  if (!st.enabled || st.authed) return;
  await new Promise((done) => {
    const pw = h('input', { type: 'password', placeholder: 'Password', autofocus: true });
    const err = h('div', { class: 'note', style: 'min-height:1.4em;color:#ff8a8a' });
    const go = async () => {
      try { await api('/api/auth/login', { method: 'POST', body: { password: pw.value } }); $('#modal').classList.add('hidden'); done(); }
      catch (e) { err.textContent = e.message; pw.select(); }
    };
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); e.stopPropagation(); });
    const m = $('#modal');
    m.classList.remove('hidden');
    m.replaceChildren(h('div', { class: 'dlg', style: 'padding:24px;max-width:360px;height:auto;text-align:center' },
      h('img', { src: '/img/logo.png', alt: 'WBTV', style: 'height:48px;margin-bottom:12px' }), h('p', {}, 'This WBTV is password protected.'), pw, err, h('button', { onclick: go }, 'Log in')));
    setTimeout(() => pw.focus(), 50);
  });
}
gate().then(() => loadGuide(false)).catch((e) => { $('#guide').textContent = 'Failed to load guide: ' + e.message; });

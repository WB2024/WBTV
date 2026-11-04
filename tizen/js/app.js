/* WBTV for Samsung (Tizen) TVs. Plain ES5, no build step: Chrome 85 on a 2022 set is the lowest target.
 * Talks to the WBTV server's own API (/api/channels, /api/epg, /live/<id>/index.m3u8) and plays through Samsung's AVPlay;
 * a desktop browser falls back to a <video> tag so the UI can be tried without a TV. */
(function () {
  'use strict';
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, EXIT: 10182, CH_UP: 427, CH_DOWN: 428,
    PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, REW: 412, FF: 417, INFO: 457, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406 };
  var STORE = 'wbtv-server';
  var AV = typeof window.webapis !== 'undefined' && window.webapis.avplay;
  var viewer = 'tz' + Math.floor(Math.random() * 1e9).toString(36);

  var S = { server: '', channels: [], epg: {}, chips: [], chip: 'all', rows: [], sel: 0, top: 0, zone: 'list', mode: 'setup',
    playing: null, retry: 0, paused: false };
  var $ = function (id) { return document.getElementById(id); };
  var VISIBLE = 10;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function now() { return Date.now() / 1000; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { var d = new Date(t * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function api(path) {
    return new Promise(function (ok, bad) {
      var x = new XMLHttpRequest();
      x.open('GET', S.server + path); x.timeout = 20000;
      x.onload = function () { if (x.status >= 200 && x.status < 300) { try { ok(JSON.parse(x.responseText)); } catch (e) { bad(e); } } else bad(new Error('HTTP ' + x.status)); };
      x.onerror = x.ontimeout = function () { bad(new Error('Cannot reach the server')); };
      x.send();
    });
  }
  function normServer(v) {
    v = (v || '').replace(/\s+/g, '').replace(/\/+$/, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    return v;
  }

  // ------------------------------------------------------------------ setup
  function showSetup(msg) {
    S.mode = 'setup';
    document.body.classList.remove('playing');
    $('guide').classList.add('hidden'); $('setup').classList.remove('hidden');
    $('addr').value = localStorage.getItem(STORE) || window.WBTV_DEFAULT || '';
    $('setupMsg').textContent = msg || '';
    S.setupFocus = 'addr'; paintSetup();
  }
  function paintSetup() {
    $('addr').classList.toggle('f', S.setupFocus === 'addr');
    $('connect').classList.toggle('f', S.setupFocus === 'connect');
    if (S.setupFocus === 'addr') { try { $('addr').focus(); } catch (e) { /* ignore */ } } else { try { $('addr').blur(); } catch (e2) { /* ignore */ } }
  }
  function connect() {
    var v = normServer($('addr').value);
    if (!v) { $('setupMsg').textContent = 'Type the server address first'; return; }
    S.server = v; $('setupMsg').textContent = 'Connecting…';
    load().then(function () { localStorage.setItem(STORE, v); showGuide(); }).catch(function (e) { $('setupMsg').textContent = 'Could not connect: ' + e.message; });
  }

  // ------------------------------------------------------------------ data
  function load() {
    var t = Math.floor(now());
    return Promise.all([api('/api/channels'), api('/api/epg?slim=1&from=' + (t - 3600) + '&to=' + (t + 6 * 3600))]).then(function (r) {
      S.channels = r[0].filter(function (c) { return c.enabled !== 0; }); S.epg = r[1].programmes || {};
      buildChips(); applyChip(S.chip, true);
    });
  }
  function refreshEpg() {
    var t = Math.floor(now());
    api('/api/epg?slim=1&from=' + (t - 3600) + '&to=' + (t + 6 * 3600)).then(function (e) { S.epg = e.programmes || {}; if (S.mode === 'guide') paintGuide(); }).catch(function () {});
  }
  function kindOf(c) { return c.kind === 'clips' ? 'tv' : c.kind; }
  var FIXED = [['all', 'All channels', null], ['tv', 'TV', 'tv'], ['movie', 'Movies', 'movie'], ['music', 'Music', 'music'], ['radio', 'Radio', 'radio'], ['live', 'Live', 'live']];
  function buildChips() {
    var chips = [], i, c, cnt;
    for (i = 0; i < FIXED.length; i++) {
      cnt = FIXED[i][2] ? S.channels.filter(function (x) { return kindOf(x) === FIXED[i][2]; }).length : S.channels.length;
      if (cnt || i === 0) chips.push({ id: FIXED[i][0], label: FIXED[i][1], n: cnt });
    }
    var seen = {}, grps = [];
    for (i = 0; i < S.channels.length; i++) { c = S.channels[i]; if (c.grp && !seen[c.grp]) { seen[c.grp] = 1; grps.push(c.grp); } }
    grps.sort();
    for (i = 0; i < grps.length; i++) chips.push({ id: 'g:' + grps[i], label: grps[i], n: S.channels.filter(function (x) { return x.grp === grps[i]; }).length });
    S.chips = chips;
  }
  function inChip(c, id) {
    if (id === 'all') return true;
    if (id.indexOf('g:') === 0) return c.grp === id.slice(2);
    return kindOf(c) === id;
  }
  function applyChip(id, keepSel) {
    var found = false, i;
    for (i = 0; i < S.chips.length; i++) if (S.chips[i].id === id) found = true;
    S.chip = found ? id : 'all';
    var prev = S.rows[S.sel] && S.rows[S.sel].id;
    S.rows = S.channels.filter(function (c) { return inChip(c, S.chip); });
    S.sel = 0; S.top = 0;
    if (keepSel && prev != null) for (i = 0; i < S.rows.length; i++) if (S.rows[i].id === prev) { S.sel = i; break; }
    fixTop();
  }
  function fixTop() { if (S.sel < S.top) S.top = S.sel; if (S.sel >= S.top + VISIBLE) S.top = S.sel - VISIBLE + 1; }

  // what is on a channel at time t; a music slot is half an hour of tracks, so follow the track actually playing
  function slotAt(chId, t) {
    var l = S.epg[chId] || [], i;
    for (i = 0; i < l.length; i++) if (l[i].start <= t && l[i].end > t) return l[i];
    return null;
  }
  function nowOf(chId, t) {
    var p = slotAt(chId, t); if (!p) return null;
    var o = { slot: p, title: p.title, sub: p.subtitle || '', start: p.start, end: p.end, item: p.item, plot: p.plot || '', nextT: null };
    if (p.trk) for (var i = 0; i < p.trk.length; i++) {
      var k = p.trk[i];
      if (k[0] <= t && k[1] > t) { o.title = k[2]; o.start = k[0]; o.end = k[1]; if (k[3]) { o.item = k[3]; o.plot = ''; } o.sub = ''; if (p.trk[i + 1]) o.nextT = p.trk[i + 1][2]; break; }
    }
    return o;
  }
  function nextProg(chId, t) {
    var l = S.epg[chId] || [];
    for (var i = 0; i < l.length; i++) if (l[i].start >= t) return l[i];
    return null;
  }

  // ------------------------------------------------------------------ guide
  function showGuide() {
    S.mode = 'guide';
    document.body.classList.remove('playing');
    $('setup').classList.add('hidden'); $('guide').classList.remove('hidden'); $('osd').classList.add('hidden');
    paintGuide();
  }
  function paintGuide() {
    var t = now(), d = new Date();
    $('clock').textContent = hhmm(t) + '  ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    var chips = $('chips'), i;
    chips.innerHTML = '';
    // keep the focused chip in view (the row does not wrap: slide the strip)
    var cur = 0; for (i = 0; i < S.chips.length; i++) if (S.chips[i].id === S.chip) cur = i;
    var first = Math.max(0, cur - 3);
    for (i = first; i < S.chips.length; i++) {
      var c = el('span', 'chip' + (S.chips[i].id === S.chip ? ' on' : '') + (S.zone === 'chips' && S.chips[i].id === S.chip ? ' f' : ''), S.chips[i].label + ' ' + S.chips[i].n);
      chips.appendChild(c);
    }
    var list = $('list'); list.innerHTML = '';
    for (i = S.top; i < Math.min(S.rows.length, S.top + VISIBLE); i++) {
      var ch = S.rows[i], o = nowOf(ch.id, t);
      var r = el('div', 'row' + (S.zone === 'list' && i === S.sel ? ' f' : '') + (ch.id === S.playing ? ' pl' : ''));
      r.appendChild(el('span', 'n', ch.number != null ? String(ch.number) : ''));
      r.appendChild(el('span', 'c', ch.name));
      r.appendChild(el('div', 't', o ? hhmm(o.start) + '  ' + o.title + (o.sub ? ' – ' + o.sub : '') : 'Nothing scheduled'));
      if (o) { var p = el('i', 'p'); p.style.width = Math.max(0, Math.min(100, (t - o.start) / Math.max(1, o.end - o.start) * 100)) + '%'; r.appendChild(p); }
      list.appendChild(r);
    }
    if (!S.rows.length) list.appendChild(el('div', 't', 'No channels in this chip'));
    paintInfo();
  }
  function paintInfo() {
    var info = $('info'); info.innerHTML = '';
    var ch = S.rows[S.sel]; if (!ch) return;
    var t = now(), o = nowOf(ch.id, t);
    if (!o) { info.appendChild(el('h2', '', ch.name)); info.appendChild(el('div', 'plot', 'Nothing scheduled right now.')); return; }
    if (o.item) { var im = el('img'); im.src = S.server + '/api/art/' + o.item; im.onerror = function () { im.style.display = 'none'; }; info.appendChild(im); }
    info.appendChild(el('h2', '', o.title));
    if (o.sub) info.appendChild(el('div', 'sub', o.sub));
    var g = (o.slot.genres || []).join(', ');
    info.appendChild(el('div', 'meta', 'NOW  ' + ch.number + ' ' + ch.name + ' · ' + hhmm(o.start) + '–' + hhmm(o.end) + (o.slot.year ? ' · ' + o.slot.year : '') + (g ? ' · ' + g : '')));
    var plot = o.plot; if (!plot && o.item) fetchPlot(o.item);
    info.appendChild(el('div', 'plot', plot || (S.plots && S.plots[o.item]) || ''));
    var nx = o.nextT ? { title: o.nextT, start: o.end } : nextProg(ch.id, o.end);
    if (nx) info.appendChild(el('div', 'nx', 'Next  ' + hhmm(nx.start) + '  ' + nx.title));
  }
  function fetchPlot(id) {
    S.plots = S.plots || {};
    if (S.plots[id] != null || S.plotBusy === id) return;
    S.plotBusy = id;
    api('/api/items/' + id).then(function (d) { S.plots[id] = (d && d.plot) || ''; S.plotBusy = null; if (S.mode === 'guide') paintInfo(); }).catch(function () { S.plots[id] = ''; S.plotBusy = null; });
  }
  function stepChip(dir) {
    var cur = 0, i; for (i = 0; i < S.chips.length; i++) if (S.chips[i].id === S.chip) cur = i;
    cur = (cur + dir + S.chips.length) % S.chips.length;
    applyChip(S.chips[cur].id); paintGuide();
  }
  function guideKey(k) {
    if (S.zone === 'chips') {
      if (k === KEY.LEFT) { stepChip(-1); return true; }
      if (k === KEY.RIGHT) { stepChip(1); return true; }
      if (k === KEY.DOWN || k === KEY.ENTER) { S.zone = 'list'; paintGuide(); return true; }
      return k === KEY.UP;
    }
    if (k === KEY.UP) { if (S.sel > 0) { S.sel--; fixTop(); } else S.zone = 'chips'; paintGuide(); return true; }
    if (k === KEY.DOWN) { if (S.sel < S.rows.length - 1) { S.sel++; fixTop(); paintGuide(); } return true; }
    if (k === KEY.CH_UP || k === 33) { S.sel = Math.max(0, S.sel - VISIBLE); fixTop(); paintGuide(); return true; }
    if (k === KEY.CH_DOWN || k === 34) { S.sel = Math.min(S.rows.length - 1, S.sel + VISIBLE); fixTop(); paintGuide(); return true; }
    if (k === KEY.REW) { stepChip(-1); return true; }
    if (k === KEY.FF) { stepChip(1); return true; }
    if (k === KEY.ENTER) { if (S.rows[S.sel]) tune(S.rows[S.sel]); return true; }
    if (k === KEY.INFO) { showSetup(''); return true; }
    if (k === KEY.RED) { load().then(paintGuide).catch(function () {}); return true; }
    if (k === KEY.LEFT || k === KEY.RIGHT) return true;
    return false;
  }

  // ------------------------------------------------------------------ playback
  var osdTimer, osdTick, msgTimer, digits = '', digitTimer;
  function setMsg(text, ms) { var m = $('msg'); if (!text) { m.classList.add('hidden'); return; } m.textContent = text; m.classList.remove('hidden'); clearTimeout(msgTimer); if (ms) msgTimer = setTimeout(function () { m.classList.add('hidden'); }, ms); }
  function url(ch) { return S.server + '/live/' + ch.id + '/index.m3u8?v=' + viewer; }
  function avStop() {
    if (AV) { try { var st = window.webapis.avplay.getState(); if (st !== 'NONE' && st !== 'IDLE') window.webapis.avplay.stop(); window.webapis.avplay.close(); } catch (e) { /* ignore */ } }
    else { var v = $('vid'); try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e2) { /* ignore */ } }
  }
  function leave() {
    if (S.playing != null) { var x = new XMLHttpRequest(); x.open('POST', S.server + '/live/' + S.playing + '/stop?v=' + viewer); x.send(); }
    avStop(); S.playing = null;
  }
  function tune(ch) {
    if (S.playing === ch.id && S.mode === 'play') { showOsd(); return; }
    if (S.playing != null && S.playing !== ch.id) leave();
    S.playing = ch.id; S.retry = 0; S.paused = false; S.mode = 'play';
    document.body.classList.add('playing');
    $('guide').classList.add('hidden'); $('setup').classList.add('hidden');
    setMsg('Tuning…');
    start(ch); showOsd();
  }
  function fail(ch, why) {
    if (S.playing !== ch.id) return;
    if (S.retry < 4) { S.retry++; setMsg('Reconnecting…'); setTimeout(function () { if (S.playing === ch.id) { avStop(); start(ch); } }, 2500); }
    else setMsg('Cannot play this channel (' + why + ')');
  }
  function start(ch) {
    var u = url(ch);
    if (AV) {
      var a = window.webapis.avplay;
      try {
        a.open(u);
        a.setDisplayRect(0, 0, 1920, 1080);
        a.setListener({
          onbufferingstart: function () { setMsg('Buffering…'); }, onbufferingcomplete: function () { setMsg(''); },
          onstreamcompleted: function () { fail(ch, 'stream ended'); },
          onerror: function (e) { fail(ch, String(e)); }, onevent: function () {}, oncurrentplaytime: function () {}
        });
        a.prepareAsync(function () { try { a.play(); setMsg(''); } catch (e) { fail(ch, e.message); } }, function (e) { fail(ch, 'prepare ' + e); });
      } catch (e) { fail(ch, e.message || String(e)); }
    } else {
      document.body.classList.add('html5');
      var v = $('vid'); v.src = u; v.onerror = function () { fail(ch, 'video error'); }; v.onplaying = function () { setMsg(''); };
      var pr = v.play(); if (pr && pr.catch) pr.catch(function () {});
    }
  }
  function togglePause() {
    try {
      if (AV) { var a = window.webapis.avplay; if (S.paused) a.play(); else a.pause(); }
      else { var v = $('vid'); if (S.paused) v.play(); else v.pause(); }
      S.paused = !S.paused; setMsg(S.paused ? '⏸ Paused' : '', 0); showOsd();
    } catch (e) { /* a live stream may refuse to pause */ }
  }
  function chanIndex(id) { for (var i = 0; i < S.rows.length; i++) if (S.rows[i].id === id) return i; return -1; }
  function zap(dir) {
    if (!S.rows.length) return;
    var i = chanIndex(S.playing); i = i < 0 ? 0 : (i + dir + S.rows.length) % S.rows.length;
    S.sel = i; fixTop(); tune(S.rows[i]);
  }
  function showOsd() {
    paintOsd(); $('osd').classList.remove('hidden');
    clearInterval(osdTick); osdTick = setInterval(paintOsd, 1000);
    clearTimeout(osdTimer); osdTimer = setTimeout(hideOsd, 5000);
  }
  function hideOsd() { $('osd').classList.add('hidden'); clearInterval(osdTick); }
  function paintOsd() {
    var o = $('osd'); o.innerHTML = '';
    if (digits) { o.appendChild(el('div', 'b', digits + '_')); return; }
    var ch = null, i; for (i = 0; i < S.channels.length; i++) if (S.channels[i].id === S.playing) ch = S.channels[i];
    if (!ch) return;
    var t = now(), n = nowOf(ch.id, t);
    o.appendChild(el('div', 'a', ch.number + '  ' + ch.name));
    o.appendChild(el('div', 'b', n ? n.title + (n.sub ? ' – ' + n.sub : '') : 'Adverts and announcements'));
    if (n) {
      var bar = el('div', 'bar'), f = el('i'); f.style.width = Math.max(0, Math.min(100, (t - n.start) / Math.max(1, n.end - n.start) * 100)) + '%'; bar.appendChild(f); o.appendChild(bar);
      var left = Math.max(0, n.end - t);
      o.appendChild(el('div', 'c', Math.floor(left / 60) + ':' + pad(Math.floor(left % 60)) + ' left · until ' + hhmm(n.end) + (n.nextT ? '   Next: ' + n.nextT : '')));
    }
  }
  function digit(d) {
    digits += d; paintOsd(); $('osd').classList.remove('hidden'); clearTimeout(digitTimer);
    digitTimer = setTimeout(function () {
      var num = parseInt(digits, 10); digits = '';
      for (var i = 0; i < S.channels.length; i++) if (S.channels[i].number === num) { tune(S.channels[i]); return; }
      setMsg('No channel ' + num, 2000); showOsd();
    }, 1500);
  }
  function playKey(k) {
    if (k >= 48 && k <= 57) { digit(String(k - 48)); return true; }
    if (k === KEY.UP || k === KEY.CH_UP) { zap(-1); return true; }
    if (k === KEY.DOWN || k === KEY.CH_DOWN) { zap(1); return true; }
    if (k === KEY.ENTER || k === KEY.INFO) { showOsd(); return true; }
    if (k === KEY.PLAYPAUSE || k === KEY.PAUSE || k === KEY.PLAY) { if (k === KEY.PLAY && !S.paused) return true; togglePause(); return true; }
    if (k === KEY.BACK || k === KEY.STOP) { leave(); setMsg(''); showGuide(); return true; }
    return k === KEY.LEFT || k === KEY.RIGHT;
  }

  // ------------------------------------------------------------------ keys
  function onKey(e) {
    var k = e.keyCode, used = false;
    if (S.mode === 'setup') {
      if (S.setupFocus === 'addr') {
        if (k === KEY.DOWN) { S.setupFocus = 'connect'; paintSetup(); used = true; }
        else if (k === KEY.ENTER) { used = false; } // let the on-screen keyboard open
      } else {
        if (k === KEY.UP) { S.setupFocus = 'addr'; paintSetup(); used = true; }
        else if (k === KEY.ENTER) { connect(); used = true; }
      }
      if (k === KEY.BACK && S.server) { showGuide(); used = true; }
      else if (k === KEY.BACK) { used = false; }
    } else if (S.mode === 'guide') {
      if (k === KEY.BACK) { try { window.tizen.application.getCurrentApplication().exit(); } catch (x) { /* browser */ } used = true; }
      else used = guideKey(k);
    } else if (S.mode === 'play') used = playKey(k);
    if (used) e.preventDefault();
  }

  function init() {
    try {
      var keys = ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaRewind', 'MediaFastForward', 'ChannelUp', 'ChannelDown', 'Info', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue'];
      for (var i = 0; i < keys.length; i++) try { window.tizen.tvinputdevice.registerKey(keys[i]); } catch (e1) { /* not on every model */ }
      for (var d = 0; d <= 9; d++) try { window.tizen.tvinputdevice.registerKey(String(d)); } catch (e2) { /* ignore */ }
    } catch (e) { /* desktop browser */ }
    document.addEventListener('keydown', onKey);
    $('connect').addEventListener('click', connect);
    window.addEventListener('unload', leave);
    var saved = localStorage.getItem(STORE) || window.WBTV_DEFAULT;
    if (saved) {
      S.server = normServer(saved);
      load().then(showGuide).catch(function (e) { showSetup('Could not connect to ' + S.server + ': ' + e.message); });
    } else showSetup('');
    setInterval(function () { if (S.mode === 'guide') paintGuide(); }, 30000);
    setInterval(function () { if (S.server) refreshEpg(); }, 5 * 60000);
  }
  init();
})();

// WBTV as a tuner: an M3U playlist + XMLTV guide for any IPTV player, and a fake HDHomeRun
// so Plex / Jellyfin / Emby / Channels can add WBTV as a Live TV source.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { logoFile } from './logos.js';

// XML 1.0 forbids most control characters outright, and one stray byte in a scraped title makes a strict parser (Plex, Jellyfin) reject the whole guide
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
export const esc = (s) => String(s ?? '').replace(XML_BAD, '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const attr = (s) => String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
const xmltvTime = (t) => {
  const d = new Date(t * 1000), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
};

export function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

export function registerIptvOut(app, db, getBroadcaster, getToken = () => '') {
  const channels = () => db.prepare(`SELECT id, kind, COALESCE(name_override, auto_name) AS name, number FROM channels
    WHERE enabled=1 AND item_count>0 AND number IS NOT NULL ORDER BY number`).all();
  const groupOf = { tv: 'TV', movie: 'Movies', music: 'Music', radio: 'Radio', live: 'Live' };
  // tokens: when a password is set, external players pass ?key=... (they can't log in interactively)
  const tq = () => { const t = getToken(); return t ? `?key=${encodeURIComponent(t)}` : ''; };

  app.get('/iptv/playlist.m3u', async (req, reply) => {
    const base = baseUrl(req);
    let out = `#EXTM3U url-tvg="${base}/iptv/epg.xml${tq()}"\n`;
    for (const c of channels()) {
      out += `#EXTINF:-1 tvg-id="wbtv.${c.id}" tvg-chno="${c.number}" tvg-name="${attr(c.name)}"${logoFile(c.id) ? ` tvg-logo="${base}/api/channels/${c.id}/logo${tq()}"` : ''} group-title="${groupOf[c.kind] || 'TV'}",${attr(c.name)}\n`;
      out += `${base}/live/${c.id}/index.m3u8${tq()}\n`;
    }
    return reply.type('audio/x-mpegurl').send(out);
  });

  app.get('/iptv/epg.xml', async (req, reply) => {
    const now = Date.now() / 1000;
    const res = await app.inject({ url: `/api/epg?from=${Math.floor(now - 3600)}&to=${Math.floor(now + 36 * 3600)}`, headers: { 'x-wbtv-key': getToken() } });
    const epg = JSON.parse(res.body);
    const chs = channels();
    let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="WBTV">\n';
    for (const c of chs) x += `<channel id="wbtv.${c.id}"><display-name>${esc(c.name)}</display-name><display-name>${c.number}</display-name>${logoFile(c.id) ? `<icon src="${esc(`${baseUrl(req)}/api/channels/${c.id}/logo${tq()}`)}"/>` : ''}</channel>\n`;
    for (const c of chs) {
      for (const p of epg.programmes[c.id] || []) {
        x += `<programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.end)}" channel="wbtv.${c.id}">`;
        x += `<title>${esc(p.title)}</title>`;
        if (p.subtitle) x += `<sub-title>${esc(p.subtitle)}</sub-title>`;
        if (p.plot) x += `<desc>${esc(p.plot)}</desc>`;
        for (const g of p.genres || []) x += `<category>${esc(g)}</category>`;
        if (p.year) x += `<date>${esc(p.year)}</date>`;
        if (p.season != null && p.episode != null) x += `<episode-num system="onscreen">S${p.season}E${p.episode}</episode-num>${p.season >= 1 && p.episode >= 1 ? `<episode-num system="xmltv_ns">${p.season - 1}.${p.episode - 1}.</episode-num>` : ''}`; // specials (season 0) have no zero-based number: it would land on season 1
        else if (p.movie) x += '<category>Movie</category>';
        x += '</programme>\n';
      }
    }
    return reply.type('application/xml').send(x + '</tv>\n');
  });

  // ---- HDHomeRun emulation
  const deviceId = () => crypto.createHash('md5').update(cfg.configDir).digest('hex').slice(0, 8).toUpperCase();
  const discover = (req) => {
    const base = baseUrl(req);
    return { FriendlyName: 'WBTV', Manufacturer: 'WBTV', ModelNumber: 'HDTC-2US', FirmwareName: 'hdhomeruntc_atsc', FirmwareVersion: '20240101',
      DeviceID: deviceId(), DeviceAuth: 'wbtv', TunerCount: 6, BaseURL: base, LineupURL: `${base}/lineup.json` };
  };
  app.get('/discover.json', async (req) => discover(req));
  app.get('/device.xml', async (req, reply) => {
    const d = discover(req);
    return reply.type('application/xml').send(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><URLBase>${esc(d.BaseURL)}</URLBase><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><friendlyName>WBTV</friendlyName><manufacturer>WBTV</manufacturer><modelName>HDHR-WBTV</modelName><modelNumber>${d.ModelNumber}</modelNumber><serialNumber>${d.DeviceID}</serialNumber><UDN>uuid:${d.DeviceID}</UDN></device></root>`);
  });
  app.get('/lineup_status.json', async () => ({ ScanInProgress: 0, ScanPossible: 1, Source: 'Cable', SourceList: ['Cable'] }));
  const lineup = async (req) => channels().map((c) => ({ GuideNumber: String(c.number), GuideName: c.name, URL: `${baseUrl(req)}/auto/v${c.number}${tq()}`, HD: 1 }));
  app.get('/lineup.json', lineup);
  app.post('/lineup.post', async () => ({ ok: true }));
  app.get('/lineup.xml', async (req, reply) => {
    const l = await lineup(req);
    return reply.type('application/xml').send(`<?xml version="1.0"?><Lineup>${l.map((c) => `<Program><GuideNumber>${esc(c.GuideNumber)}</GuideNumber><GuideName>${esc(c.GuideName)}</GuideName><URL>${esc(c.URL)}</URL></Program>`).join('')}</Lineup>`);
  });

  // HDHomeRun clients want a plain MPEG-TS stream, not HLS: remux (no re-encode) the shared channel stream.
  app.get('/auto/v:num', async (req, reply) => {
    const c = channels().find((x) => String(x.number) === req.params.num);
    if (!c) return reply.code(404).send();
    const viewer = `ts-${crypto.randomBytes(4).toString('hex')}`;
    const b = getBroadcaster(c.id);
    b.touch(viewer);
    const keep = setInterval(() => b.touch(viewer), 8000);
    let ff = null, gone = false;
    // registered BEFORE the wait below: a client that gives up while the channel is starting must not leave an encoder behind
    const cleanup = () => { if (gone) return; gone = true; clearInterval(keep); try { ff?.kill('SIGKILL'); } catch { /* already gone */ } b.leave(viewer); };
    reply.raw.on('close', cleanup);
    // wait for the first segments, as the HLS route does
    const t0 = Date.now();
    while (b.ready < 2 && Date.now() - t0 < 25000 && !b.stopped && !gone) await new Promise((r) => setTimeout(r, 200));
    if (gone) return reply;
    if (!b.playlist()) { cleanup(); return reply.code(503).send('stream not ready'); }
    const keyArg = getToken() ? `&key=${encodeURIComponent(getToken())}` : '';
    ff = spawn(cfg.ffmpeg, ['-nostdin', '-v', 'error', '-fflags', '+genpts', '-i', `http://127.0.0.1:${cfg.port}/live/${c.id}/index.m3u8?v=${viewer}${keyArg}`,
      '-c', 'copy', '-f', 'mpegts', '-mpegts_flags', '+resend_headers', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] });
    ff.on('error', cleanup);
    ff.on('exit', () => { cleanup(); if (!reply.raw.writableEnded) reply.raw.end(); });
    return reply.header('Cache-Control', 'no-cache').type('video/mp2t').send(ff.stdout);
  });
}

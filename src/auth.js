// Optional access control. Off by default (WBTV is meant for a home LAN). When a password is set:
//  - browsers log in once and get a signed cookie
//  - other apps (Android TV app, IPTV players, Plex/Jellyfin) use the API key: header "Authorization: Bearer <key>", "x-wbtv-key", or "?key=<key>"
import crypto from 'node:crypto';

const COOKIE = 'wbtv_session';
const DAYS = 30;
const PROTECTED = ['/api/', '/live/', '/iptv/', '/auto/', '/lineup', '/discover.json', '/device.xml'];
const OPEN = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/logout']);

const rand = (n) => crypto.randomBytes(n).toString('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('base64url');

export function initAuth(app, db) {
  const load = () => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='auth'").get()?.value || 'null'); } catch { return null; } };
  const save = (a) => (a
    ? db.prepare("INSERT INTO settings(key,value) VALUES('auth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(a))
    : db.prepare("DELETE FROM settings WHERE key='auth'").run());
  let auth = load();

  const sign = (exp) => crypto.createHmac('sha256', auth.secret).update(String(exp)).digest('base64url');
  const makeCookie = () => {
    const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
    return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}`;
  };
  const cookieOf = (req) => (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  const valid = (req) => {
    if (!auth) return true;
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const key = req.headers['x-wbtv-key'] || bearer || req.query?.key;
    if (key && same(key, auth.apiKey)) return true;
    const c = cookieOf(req);
    if (c) {
      const [exp, sig] = c.split('.');
      if (Number(exp) > Date.now() / 1000 && sig && same(sig, sign(exp))) return true;
    }
    return false;
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!auth) return;
    const p = req.url.split('?')[0];
    if (OPEN.has(p) || !PROTECTED.some((x) => p.startsWith(x))) return;
    if (!valid(req)) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'login required' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/auth/status', async (req) => ({ enabled: !!auth, authed: valid(req) }));

  let failures = 0;
  app.post('/api/auth/login', async (req, reply) => {
    if (!auth) return { ok: true };
    if (failures > 0) await new Promise((r) => setTimeout(r, Math.min(failures, 5) * 600)); // slow down guessing
    const pw = String(req.body?.password ?? '');
    if (!same(hashPw(pw, auth.salt), auth.hash)) { failures++; return reply.code(401).send({ error: 'Wrong password' }); }
    failures = 0;
    return reply.header('Set-Cookie', makeCookie()).send({ ok: true });
  });
  app.post('/api/auth/logout', async (req, reply) => reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`).send({ ok: true }));

  // the hook above already requires a login for everything below once a password exists
  app.post('/api/auth/password', async (req, reply) => {
    const pw = String(req.body?.password ?? '');
    if (pw.length < 4) return reply.code(400).send({ error: 'Use at least 4 characters' });
    const salt = rand(16);
    auth = { salt, hash: hashPw(pw, salt), apiKey: auth?.apiKey || rand(24), secret: rand(32) };
    save(auth);
    return reply.header('Set-Cookie', makeCookie()).send({ ok: true, key: auth.apiKey });
  });
  app.delete('/api/auth', async () => { auth = null; save(null); return { ok: true }; });
  app.get('/api/auth/key', async () => ({ key: auth?.apiKey || '' }));
  app.post('/api/auth/key', async () => {
    if (!auth) return { key: '' };
    auth.apiKey = rand(24); save(auth);
    return { key: auth.apiKey };
  });

  return { getToken: () => auth?.apiKey || '' };
}

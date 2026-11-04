// Try the TV app in a desktop browser: node tizen/dev.mjs [http://server:8420] [port]
// Serves this folder and proxies GET requests to the WBTV server (same origin, so no CORS needed). Browser testing only.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const target = new URL(process.argv[2] || 'http://127.0.0.1:8420'); const port = Number(process.argv[3]) || 8077;
const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png' };
http.createServer((req, res) => {
  if (/^\/(api|live)\//.test(req.url)) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const p = http.request({ host: target.hostname, port: target.port, path: req.url, method: 'GET' }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => res.writeHead(502).end()); p.end(); return;
  }
  const f = path.join(root, req.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f).slice(1)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log(`TV app on http://localhost:${port}  (server ${target.origin})`));

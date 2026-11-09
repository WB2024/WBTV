// WBTV desktop client: a window around the server's own web UI. The server address is remembered;
// Ctrl+Shift+S changes it, F11 toggles fullscreen.
const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const file = () => path.join(app.getPath('userData'), 'settings.json');
const load = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
const save = (o) => { try { fs.writeFileSync(file(), JSON.stringify(o)); } catch { /* read-only profile: the address is just not remembered */ } };

// "192.168.1.110:8420?key=ABC" -> { origin, key }
function parse(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try { const u = new URL(s); return { origin: u.origin, key: u.searchParams.get('key') || '' }; } catch { return null; }
}

let win;
const showConnect = () => win.loadFile(path.join(__dirname, 'connect.html'));

async function go(s) {
  // the server accepts the access key as an x-wbtv-key header, so every request (page, API, streams) carries it
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [s.origin + '/*'] }, (d, cb) => {
    if (s.key) d.requestHeaders['x-wbtv-key'] = s.key;
    cb({ requestHeaders: d.requestHeaders });
  });
  await win.loadURL(s.origin + '/');
}

function create() {
  const st = load();
  win = new BrowserWindow({
    width: st.w || 1280, height: st.h || 760, backgroundColor: '#0b0d12', title: 'WBTV', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (st.max) win.maximize();
  const remember = () => { if (win.isDestroyed()) return; const b = win.getNormalBounds(); save({ ...load(), w: b.width, h: b.height, max: win.isMaximized() }); };
  win.on('close', remember);

  // links to other sites open in the real browser; the window stays on the server (or the connect page)
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    const s = parse(load().server || '');
    if (url.startsWith('file:')) return;
    if (!s || new URL(url).origin !== s.origin) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3 && !url.startsWith('file:')) {
      win.loadFile(path.join(__dirname, 'connect.html'));
    }
  });

  const s = parse(st.server);
  if (s) go(s); else showConnect();
}

ipcMain.handle('server:get', () => load().server || '');
ipcMain.handle('server:set', async (_e, address) => {
  const s = parse(address);
  if (!s) return { error: 'That does not look like an address.' };
  try {
    const r = await fetch(s.origin + '/api/status', { signal: AbortSignal.timeout(6000), headers: s.key ? { 'x-wbtv-key': s.key } : {} });
    if (r.status !== 401 && !r.ok) return { error: `The server answered ${r.status}.` };
  } catch { return { error: 'Could not reach that address.' }; }
  save({ ...load(), server: String(address).trim() });
  await go(s);
  return {};
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'WBTV', submenu: [
      { label: 'Change server…', accelerator: 'CmdOrCtrl+Shift+S', click: showConnect },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win.webContents.reload() },
      { label: 'Fullscreen', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      { type: 'separator' }, { role: 'quit' },
    ] },
  ]));
  create();
});
app.on('window-all-closed', () => app.quit());

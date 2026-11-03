#!/usr/bin/env node
// Proposes how to mirror a Jellyfin server's libraries in WBTV: one WBTV library per Jellyfin folder, with a channel group per Jellyfin library
// (so "Managed" + "Unmanaged" folders, and films + shows that belong together, become one channel). READ-ONLY: it prints a plan, changes nothing.
//   JF_KEY=<api key> node tools/jfplan.mjs --jf http://192.168.1.111:8096 --wbtv http://192.168.1.110:8420 --map /Media=/mnt/Main20TB/Media
// The key comes from the environment and is never stored.
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const JF = arg('--jf'), WBTV = arg('--wbtv', 'http://localhost:8420'), MAP = (arg('--map', '') || '').split('=');
const KEY = process.env.JF_KEY;
if (!JF || !KEY || MAP.length !== 2) { console.error('usage: JF_KEY=... node tools/jfplan.mjs --jf <url> --wbtv <url> --map /JellyfinPrefix=/WbtvPrefix'); process.exit(1); }

// group rules: a Jellyfin library name -> the channel group it belongs to (films and shows of one theme share a channel)
const GROUPS = [[/stand\s*up/i, 'Stand Up'], [/live music/i, 'Live Music'], [/music docs?/i, 'Music Docs'], [/documentar/i, 'Documentaries'], [/^clips$/i, 'Clips'], [/^interviews?$/i, 'Interviews']];
const TYPE = { movies: 'movies', tvshows: 'tv', homevideos: 'clips' };
const mapPath = (p) => (p.startsWith(MAP[0] + '/') ? MAP[1] + p.slice(MAP[0].length) : null);

const jf = await (await fetch(`${JF}/Library/VirtualFolders`, { headers: { 'X-Emby-Token': KEY } })).json();
const mine = await (await fetch(`${WBTV}/api/libraries`)).json();
const plan = { add: [], update: [], overlaps: [], skipped: [] };
for (const lib of jf) {
  const type = TYPE[lib.CollectionType];
  if (!type) { plan.skipped.push({ name: lib.Name, why: `type "${lib.CollectionType}" is not used by WBTV` }); continue; }
  const group = (GROUPS.find(([re]) => re.test(lib.Name)) || [])[1] || null;
  const mode = group ? 'single' : 'inferred';
  for (const loc of lib.Locations) {
    const path = mapPath(loc);
    if (!path) { plan.skipped.push({ name: lib.Name, why: `${loc} is not under ${MAP[0]}` }); continue; }
    const same = mine.find((m) => m.path === path);
    const inside = mine.filter((m) => m !== same && (path.startsWith(m.path + '/')));   // a WBTV library that already contains this folder
    const around = mine.filter((m) => m !== same && (m.path.startsWith(path + '/')));   // a WBTV library inside this folder
    const label = `${lib.Name}${lib.Locations.length > 1 ? ` (${/unmanag/i.test(loc) ? 'Unmanaged' : /managed/i.test(loc) ? 'Managed' : loc.split('/').pop()})` : ''}`;
    if (inside.length) plan.overlaps.push({ jellyfin: lib.Name, folder: path, insideWbtvLibrary: inside.map((m) => `${m.id}:${m.name}`) });
    if (same) plan.update.push({ id: same.id, name: same.name, path, type: same.type === type ? type : `${same.type} -> ${type}`, group, mode, jellyfinLibrary: lib.Name });
    else plan.add.push({ name: label, path, type, group, mode, jellyfinLibrary: lib.Name });
  }
}
const known = new Set(plan.update.map((u) => u.id));
plan.notInJellyfin = mine.filter((m) => !known.has(m.id) && !String(m.path).startsWith('http') && !String(m.path).startsWith('ms://') && !plan.overlaps.some((o) => o.insideWbtvLibrary.some((s) => s.startsWith(`${m.id}:`)))).map((m) => `${m.id}:${m.name} (${m.type})`);
console.log(JSON.stringify(plan, null, 1));

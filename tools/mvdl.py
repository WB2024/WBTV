#!/usr/bin/env python3
"""mvdl - a small command-line music video fetcher that fills the same folder layout WBTV reads.

  Artist/Artist - Title.mp4  +  Artist - Title-poster.jpg  +  Artist - Title.nfo   (the <musicvideo> nfo WBTV, Jellyfin and Kodi read)

Artists come from your Navidrome (with their MusicBrainz ids); the list of an artist's videos comes from MusicBrainz
(recordings flagged as videos); the file comes from yt-dlp. Nothing is kept unless it passes two checks: the upload's
metadata (no auto-generated "- Topic" channels, lyric / audio / full-album uploads) and a motion check (an album cover
with the audio played over it is rejected). Needs: python 3.9+, yt-dlp (pip install yt-dlp), ffmpeg on PATH. No other packages.

  python mvdl.py setup                      save the Navidrome address / login and the music video folder
  python mvdl.py artists [filter]           artists in your Navidrome, and how many videos you already have of each
  python mvdl.py list "Morrissey"           that artist's videos on MusicBrainz, marked have / missing
  python mvdl.py get  "Morrissey" [-n]      download the missing ones (-n = dry run; --all-artists to do every artist)
  python mvdl.py top [20] [-n]              your 20 biggest artists (most songs in Navidrome): download all their missing videos
  python mvdl.py top 20 --lists DIR          write an empty Artist.txt per top artist; paste YouTube links in (one per line)
  python mvdl.py batch <file.txt | folder> [-n]   download every link in the list(s); the file name is the artist
  python mvdl.py url  <youtube-url | "Artist - Title"> [--force]     one video: a link, or words (searches "Artist - Title (official music video)")
"""
import argparse, getpass, hashlib, json, os, re, secrets, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from collections import Counter

CONF = os.path.join(os.path.expanduser('~'), '.mvdl.json')
UA = 'mvdl/1.0 (https://github.com/WB2024/WBTV)'
VIDEO_EXT = ('.mp4', '.mkv', '.webm', '.m4v', '.mpg', '.avi', '.mov')

# ---------- config / http ----------
def conf():
    try: return json.load(open(CONF))
    except Exception: return {}

def http_json(url, headers=None, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})}), timeout=60) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))

# ---------- Navidrome (Subsonic API) ----------
def nd(c, endpoint, **p):
    salt = secrets.token_hex(6)
    q = {'u': c['user'], 't': hashlib.md5((c['password'] + salt).encode()).hexdigest(), 's': salt, 'v': '1.16.1', 'c': 'mvdl', 'f': 'json', **p}
    r = http_json(f"{c['url'].rstrip('/')}/rest/{endpoint}?{urllib.parse.urlencode(q)}")['subsonic-response']
    if r.get('status') != 'ok': raise SystemExit(f"Navidrome said: {r.get('error', {}).get('message', r)}")
    return r

def nd_artists(c):
    out = []
    for idx in nd(c, 'getArtists').get('artists', {}).get('index', []):
        out += idx.get('artist', [])
    return out

def nd_genre(c, artist_id):
    """The artist's most common album genre in your library (used for the nfo, which WBTV turns into genre channels)."""
    try:
        g = Counter()
        for al in nd(c, 'getArtist', id=artist_id).get('artist', {}).get('album', []):
            for x in al.get('genres') or ([{'name': al['genre']}] if al.get('genre') else []): g[x['name']] += 1
        return [n for n, _ in g.most_common(2)]
    except Exception: return []

# ---------- MusicBrainz ----------
_last = [0.0]
def mb(path, **p):
    wait = 1.1 - (time.time() - _last[0])
    if wait > 0: time.sleep(wait)
    _last[0] = time.time()
    return http_json(f"https://musicbrainz.org/ws/2/{path}?{urllib.parse.urlencode({**p, 'fmt': 'json'})}")

def mb_artist(name):
    r = mb('artist', query=f'artist:"{name}"', limit=1).get('artists', [])
    return r[0]['id'] if r and r[0].get('score', 0) >= 90 else None

LIVE = re.compile(r'\b(live|remix|acoustic|demo|karaoke|instrumental|rehearsal|session)\b', re.I)
def mb_videos(mbid, live=False, max_pages=30):
    """Recordings flagged as videos, de-duplicated by cleaned title. Each: {title, year, url}."""
    seen, out = {}, []
    for page in range(max_pages):
        r = mb('recording', artist=mbid, inc='url-rels', limit=100, offset=page * 100)
        for rec in r.get('recordings', []):
            yt = next((rel['url']['resource'] for rel in rec.get('relations', []) if re.search(r'youtu\.?be', rel.get('url', {}).get('resource', ''))), None)
            if not (rec.get('video') or yt): continue
            title = rec['title']
            if not live and (LIVE.search(title) or LIVE.search(rec.get('disambiguation', ''))): continue
            key = norm(clean_title(title))
            year = (rec.get('first-release-date') or '')[:4]
            have = seen.get(key)
            if have:  # keep the earliest year and any direct link
                if year and (not have['year'] or year < have['year']): have['year'] = year
                have['url'] = have['url'] or yt
                continue
            seen[key] = {'title': clean_title(title), 'year': year if year.isdigit() else '', 'url': yt}
            out.append(seen[key])
        if len(r.get('recordings', [])) < 100: break
    return out

# ---------- names ----------
def norm(s): return re.sub(r'[^a-z0-9]+', ' ', re.sub(r'\([^)]*\)|\[[^]]*\]', ' ', s.lower().replace('&', ' and '))).strip()
def clean_title(t): return re.sub(r'\s*[\(\[](official|hd|hq|remaster|video|music video)[^)\]]*[\)\]]', '', t, flags=re.I).strip()
def file_safe(s): return re.sub(r'\s+', ' ', re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', s)).strip().rstrip('.')

def library_index(root):
    """normalised 'artist title' keys of every video already in the folder."""
    have = set()
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if not d.startswith('.')]
        for f in fn:
            if f.lower().endswith(VIDEO_EXT): have.add(norm(os.path.splitext(f)[0]))
    return have

def have_it(have, artist, title):
    return norm(f'{artist} {title}') in have or norm(f'{artist} - {title}') in have

# ---------- the two checks ----------
def judge_upload(info):
    title, chan, desc = info.get('title') or '', info.get('channel') or info.get('uploader') or '', info.get('description') or ''
    if chan.lower().endswith(' - topic') or desc.strip().lower().startswith('provided to youtube by'): return 'an auto-generated audio upload (YouTube "Topic" channel)'
    claims = re.search(r'\b(official\s+(music\s+)?video|music\s+video|official\s+hd\s+video)\b', title, re.I)
    if re.search(r'\b(full\s+album|album\s+stream)\b', title, re.I): return 'a full-album upload'
    if not claims and re.search(r'\b(lyrics?|lyric\s+video|audio|visuali[sz]er|album\s+version)\b', title, re.I): return 'a lyric / audio upload'
    d = info.get('duration')
    if d and (d < 75 or d > 20 * 60): return f'the wrong length ({int(d)}s)'
    return None

BOOTLEG = re.compile(r"\b(live|concert|bootleg|festival|tour|gig|soundboard|rehearsal|fan\s?cam|reaction|cover|tribute|karaoke|tv\s+performance|top of the pops|sessions?|full\s+show)\b", re.I)
def judge_official(info, artist):
    """Only an OFFICIAL upload is wanted (a live recording is fine when it is the official video). Returns a reason, or None when it looks official."""
    title, chan = info.get('title') or '', info.get('channel') or info.get('uploader') or ''
    claims = re.search(r'\bofficial\b', title, re.I) and not re.search(r'\bofficial\s+(audio|lyric)', title, re.I)
    on_artist_channel = norm(artist) in norm(chan) or 'vevo' in chan.lower() or bool(info.get('channel_is_verified'))
    if BOOTLEG.search(title) and not claims: return 'looks like a live / fan recording, not an official video'
    if not (claims or on_artist_channel): return "not clearly official (no 'official' in the title, and not the artist's, a verified or a VEVO channel)"
    return None

def looks_still(path, seconds=24, fps=2, w=64, h=36):
    """True when almost no frames change: a picture with the audio over it. Unknown / unreadable is never 'still'."""
    try:
        dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], capture_output=True, text=True).stdout or 0)
        ss = max(0, min(dur * 0.3, max(0, dur - seconds - 2)))
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-ss', str(ss), '-i', path, '-t', str(seconds), '-an', '-vf', f'fps={fps},scale={w}:{h},format=gray', '-f', 'rawvideo', '-'], capture_output=True, timeout=120).stdout
    except Exception: return False
    size = w * h; n = len(raw) // size
    if n < 6: return False
    changing = sum(1 for i in range(1, n) if sum(abs(a - b) for a, b in zip(raw[i * size:(i + 1) * size], raw[(i - 1) * size:i * size])) / size > 1.2)
    return changing / (n - 1) < 0.12

# ---------- yt-dlp ----------
def ytdlp(*a, **k):
    exe = shutil.which('yt-dlp')
    cmd = [exe] if exe else [sys.executable, '-m', 'yt_dlp']
    return subprocess.run(cmd + ['--no-warnings', '--no-playlist'] + list(a), capture_output=True, text=True, **k)

def candidates(artist, title, direct, only=False):
    """Metadata of possible uploads, best first: the MusicBrainz-linked video, then a YouTube search."""
    infos = []
    for q in ([direct] if direct else []) + ([] if only and direct else [f'ytsearch5:{artist} - {title} (official music video)']):
        r = ytdlp('-J', q)
        try: j = json.loads(r.stdout)
        except Exception: continue
        infos += j.get('entries') or [j]
    na, nt = norm(artist), norm(title)
    def ok(i):
        t = norm((i.get('title') or '') + ' ' + (i.get('channel') or i.get('uploader') or ''))
        return nt in t and (na in t or all(w in t for w in na.split()))
    good = [i for i in infos if i and ok(i)]
    return good or ([infos[0]] if direct and infos else [])

def download(info, tmp):
    r = ytdlp('-f', 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4',
              '--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', os.path.join(tmp, 'video.%(ext)s'), info.get('webpage_url') or info['url'])
    vid = next((f for f in os.listdir(tmp) if re.match(r'video\.(mp4|mkv|webm|m4v)$', f)), None)
    if r.returncode or not vid: raise RuntimeError((r.stderr.strip().splitlines() or ['yt-dlp failed'])[-1][:200])
    return os.path.join(tmp, vid), (os.path.join(tmp, 'video.jpg') if os.path.exists(os.path.join(tmp, 'video.jpg')) else None)

# ---------- placing ----------
def x(s): return str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
def nfo(artist, title, year, genres):
    L = ['<?xml version="1.0" encoding="utf-8" standalone="yes"?>', '<musicvideo>', f'  <title>{x(title)}</title>', f'  <artist>{x(artist)}</artist>']
    if year: L.append(f'  <year>{year}</year>')
    L += [f'  <genre>{x(g)}</genre>' for g in genres]
    return '\n'.join(L + ['  <lockdata>true</lockdata>', '</musicvideo>', ''])

def place(root, artist, title, year, genres, video, thumb):
    d = os.path.join(root, file_safe(artist)); base = file_safe(f'{artist} - {title}')
    os.makedirs(d, exist_ok=True)
    target = os.path.join(d, base + os.path.splitext(video)[1].lower())
    if os.path.exists(target): raise RuntimeError('already in the library')
    shutil.move(video, target)
    if thumb: shutil.move(thumb, os.path.join(d, f'{base}-poster.jpg'))
    open(os.path.join(d, base + '.nfo'), 'w', encoding='utf-8').write(nfo(artist, title, year, genres))
    return target

def fetch_one(root, artist, title, year, genres, direct=None, force=False, dry=False):
    print(f'  {artist} - {title}' + (f' ({year})' if year else ''), end=' ... ', flush=True)
    if dry: print('would download'); return True
    cands = candidates(artist, title, direct, only=force); why = []
    if not cands: print('no matching upload found'); return False
    for info in cands:
        bad = None if force else (judge_upload(info) or judge_official(info, artist))
        if bad: why.append(bad); continue
        tmp = tempfile.mkdtemp(prefix='mvdl-')
        try:
            video, thumb = download(info, tmp)
            if not force and looks_still(video): why.append('a still image with the audio played over it'); continue
            place(root, artist, title, year, genres, video, thumb)
            with open(os.path.join(root, '.mvdl-log.jsonl'), 'a', encoding='utf-8') as lg: lg.write(json.dumps({'when': time.strftime('%Y-%m-%d %H:%M'), 'artist': artist, 'title': title, 'source': info.get('webpage_url'), 'uploader': info.get('channel') or info.get('uploader'), 'upload_title': info.get('title')}) + chr(10))
            print('saved'); return True
        except Exception as e: why.append(str(e))
        finally: shutil.rmtree(tmp, ignore_errors=True)
    print('not kept: ' + '; '.join(dict.fromkeys(why)))
    return False

# ---------- commands ----------
def need(c):
    for k in ('url', 'user', 'password', 'root'):
        if not c.get(k): raise SystemExit('Run "python mvdl.py setup" first.')
    if not os.path.isdir(c['root']): raise SystemExit(f"The music video folder {c['root']} does not exist.")

def find_artist(c, name):
    arts = nd_artists(c); n = norm(name)
    hit = next((a for a in arts if norm(a['name']) == n), None) or next((a for a in arts if n in norm(a['name'])), None)
    return hit or {'name': name, 'id': None}

def cmd_setup(a):
    c = conf()
    c['url'] = input(f"Navidrome address [{c.get('url', 'http://192.168.1.x:4533')}]: ").strip() or c.get('url', '')
    c['user'] = input(f"Navidrome user [{c.get('user', '')}]: ").strip() or c.get('user', '')
    c['password'] = getpass.getpass('Navidrome password (hidden, blank keeps the saved one): ') or c.get('password', '')
    c['root'] = input(f"Music video folder on this PC [{c.get('root', '')}]: ").strip().strip('"') or c.get('root', '')
    nd(c, 'ping'); json.dump(c, open(CONF, 'w'), indent=1)
    try: os.chmod(CONF, 0o600)
    except OSError: pass
    print(f'Connected. Saved to {CONF}')

def cmd_artists(a):
    c = conf(); need(c); have = library_index(c['root'])
    for ar in sorted(nd_artists(c), key=lambda z: z['name'].lower()):
        if a.filter and a.filter.lower() not in ar['name'].lower(): continue
        n = sum(1 for k in have if k.startswith(norm(ar['name']) + ' '))
        print(f"{ar['name']:40} {ar.get('albumCount', '?'):>3} albums   {n:>3} videos here")

def artist_videos(c, ar):
    mbid = ar.get('musicBrainzId') or mb_artist(ar['name'])
    if not mbid: print(f"  {ar['name']}: not found on MusicBrainz"); return []
    return mb_videos(mbid)

def cmd_list(a):
    c = conf(); need(c); have = library_index(c['root']); ar = find_artist(c, a.artist)
    vids = artist_videos(c, ar)
    for v in vids: print(('have    ' if have_it(have, ar['name'], v['title']) else 'MISSING ') + f"{v['title']}  {v['year']}")
    print(f"{len(vids)} videos listed, {sum(not have_it(have, ar['name'], v['title']) for v in vids)} missing")

def cmd_top(a):
    c = conf(); need(c)
    arts = sorted((z for z in nd_artists(c) if not re.fullmatch(r'various artists?|va|unknown artist|soundtracks?|original soundtrack', z['name'].strip(), re.I)), key=lambda z: -z.get('albumCount', 0))[:max(a.count * 3, 30)]  # the song count needs a lookup each, so only the likeliest
    for ar in arts: ar['songs'] = sum(al.get('songCount', 0) for al in nd(c, 'getArtist', id=ar['id']).get('artist', {}).get('album', []))
    arts = sorted(arts, key=lambda z: -z['songs'])[:a.count]
    print('Top artists by song count: ' + ', '.join(f"{z['name']} ({z['songs']})" for z in arts))
    if a.lists:  # just make an empty list file per artist, to fill with links by hand
        os.makedirs(a.lists, exist_ok=True)
        for z in arts:
            f = os.path.join(a.lists, file_safe(z['name']) + '.txt')
            if not os.path.exists(f): open(f, 'w', encoding='utf-8').write(f"# {z['name']}: one YouTube link per line (optionally: link | Song title). Lines starting with # are ignored.\n")
        return print(f'Wrote {len(arts)} list files in {a.lists}')
    a.artist, a.all_artists, a.arts = None, False, arts
    cmd_get(a)

def read_list(path):
    """A list file is named after the artist ('Iggy Pop.txt'), or starts with 'artist: Name'. Lines: <link>  or  <link> | <title>. Returns (artist, [(link, title|None)])."""
    artist, items = re.sub(r'[ _-]*(youtube[ _-]*)?(links?|urls?|videos?)$', '', os.path.splitext(os.path.basename(path))[0].replace('_', ' '), flags=re.I).strip(), []
    for raw in open(path, encoding='utf-8-sig'):
        line = raw.strip()
        if not line or line.startswith('#'): continue
        m = re.match(r'artist\s*[:=]\s*(.+)', line, re.I)
        if m: artist = m.group(1).strip(); continue
        link, _, title = line.partition('|')
        link = link.strip()
        if re.match(r'https?://', link): items.append((link, title.strip() or None))
        else: print(f'  skipping a line that is not a link: {line[:60]}')
    return artist, items

def cmd_batch(a):
    c = conf(); need(c)
    files = [a.path] if os.path.isfile(a.path) else sorted(os.path.join(a.path, f) for f in os.listdir(a.path) if f.lower().endswith('.txt'))
    if not files: raise SystemExit('No .txt files found there.')
    ok = bad = 0
    for f in files:
        artist, items = read_list(f)
        if a.artist: artist = a.artist
        ar = find_artist(c, artist); artist = ar['name'] if ar['id'] else artist
        print(f'{artist}: {len(items)} links ({os.path.basename(f)})')
        genres = nd_genre(c, ar['id']) if ar['id'] else []
        for link, title in items:
            have = library_index(c['root'])
            r = ytdlp('-J', link)
            try: info = json.loads(r.stdout)
            except Exception: info = None
            if not info or not isinstance(info, dict): print(f'  {link} ... yt-dlp could not read it (private, removed or blocked)'); bad += 1; continue
            t = title or info.get('track') or clean_title(re.sub(r'^\s*' + re.escape(artist) + r'\s*[-:–]\s*', '', info.get('title', ''), flags=re.I))
            t = re.sub(r'\s*[\(\[]\s*official[^)\]]*[\)\]]\s*$', '', t, flags=re.I).strip()
            if have_it(have, artist, t): print(f'  {artist} - {t} ... already have it'); continue
            year = str(info.get('release_year') or str(info.get('upload_date', ''))[:4] or '')
            if a.n: print(f'  {artist} - {t} ... would download'); continue
            if fetch_one(c['root'], artist, t, year, genres, link, force=True): ok += 1
            else: bad += 1
    print(f'{ok} saved, {bad} failed' if not a.n else 'dry run only')

def cmd_get(a):
    c = conf(); need(c); have = library_index(c['root'])
    arts = getattr(a, 'arts', None) or (nd_artists(c) if a.all_artists else [find_artist(c, a.artist)])
    done = 0
    for ar in arts:
        vids = [v for v in artist_videos(c, ar) if not have_it(have, ar['name'], v['title'])]
        if not vids: continue
        print(f"{ar['name']}: {len(vids)} missing"); genres = nd_genre(c, ar['id']) if ar['id'] else []
        for v in vids[:a.limit]:
            if fetch_one(c['root'], ar['name'], v['title'], v['year'], genres, v['url'], dry=a.n): done += 1
    print(f'{done} {"would be " if a.n else ""}saved')

def cmd_url(a):
    c = conf(); need(c)
    if not re.match(r'https?://', a.url):  # typed words, not a link: search for "Artist - Title (official music video)"
        parts = re.split(r'\s+-\s+', a.url, maxsplit=1)
        if len(parts) < 2 and not (a.artist and a.title): raise SystemExit('Type it as "Artist - Title", for example: Morrissey - Everyday Is Like Sunday')
        artist, title = a.artist or parts[0].strip(), clean_title(a.title or parts[1].strip())
        ar = find_artist(c, artist); artist = ar['name'] if ar['id'] else artist
        if have_it(library_index(c['root']), artist, title) and not a.force: return print(f'Already in your library: {artist} - {title} (use --force to fetch it again)')
        return fetch_one(c['root'], artist, title, '', nd_genre(c, ar['id']) if ar['id'] else [], None, force=a.force)
    r = ytdlp('-J', a.url)
    try: info = json.loads(r.stdout)
    except Exception: raise SystemExit('yt-dlp could not read that address')
    artist = a.artist or info.get('artist') or re.split(r'\s+-\s+', info.get('title', ''), 1)[0]
    title = a.title or info.get('track') or (re.split(r'\s+-\s+', info.get('title', ''), 1) + [''])[1] or info.get('title')
    title = clean_title(title)
    genres = nd_genre(c, find_artist(c, artist)['id']) if find_artist(c, artist)['id'] else []
    fetch_one(c['root'], artist, title, (info.get('release_year') or str(info.get('upload_date', ''))[:4]) or '', genres, a.url, force=a.force)

def main():
    for st in (sys.stdout, sys.stderr): st.reconfigure(encoding='utf-8', errors='replace')
    p = argparse.ArgumentParser(prog='mvdl', description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    s = p.add_subparsers(dest='cmd')
    s.add_parser('setup').set_defaults(f=cmd_setup)
    q = s.add_parser('artists'); q.add_argument('filter', nargs='?'); q.set_defaults(f=cmd_artists)
    q = s.add_parser('list'); q.add_argument('artist'); q.set_defaults(f=cmd_list)
    q = s.add_parser('get'); q.add_argument('artist', nargs='?'); q.add_argument('-n', action='store_true', help='dry run')
    q.add_argument('--all-artists', action='store_true'); q.add_argument('--limit', type=int, default=50); q.set_defaults(f=cmd_get)
    q = s.add_parser('top', help='download missing videos for your top artists by song count'); q.add_argument('count', nargs='?', type=int, default=20)
    q.add_argument('-n', action='store_true', help='dry run'); q.add_argument('--limit', type=int, default=50); q.add_argument('--lists', metavar='DIR', help='instead of downloading, write an empty list file per artist into DIR'); q.set_defaults(f=cmd_top)
    q = s.add_parser('batch', help='download the links in a list file, or every .txt in a folder'); q.add_argument('path'); q.add_argument('--artist', help='the artist, if the file name does not say'); q.add_argument('-n', action='store_true', help='dry run'); q.set_defaults(f=cmd_batch)
    q = s.add_parser('url'); q.add_argument('url'); q.add_argument('--artist'); q.add_argument('--title'); q.add_argument('--force', action='store_true'); q.set_defaults(f=cmd_url)
    a = p.parse_args()
    if not a.cmd: p.print_help(); return
    if a.cmd == 'get' and not (a.artist or a.all_artists): p.error('give an artist, or --all-artists')
    a.f(a)

if __name__ == '__main__':
    main()

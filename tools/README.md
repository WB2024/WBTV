# WBTV tools

## mvtool: tidy your music videos

Sorts out a music video folder so WBTV (and Jellyfin / Kodi) get proper artist, title, **release year** and genre, instead of YouTube upload dates and file-name noise.

Target layout: `<Music Videos>/<Artist>/<Artist> - <Title>.mp4`, with `<Artist> - <Title>.nfo` and `-poster.jpg` beside each file.

- **audit** reads only. It reports what each file is called, what it should be called, and where the year and genre would come from.
- **fix** is a dry run by default. With `--apply` it renames and moves files, writes a clean `.nfo` for each (backing up the old one), and moves extra copies of the same song (keeping the best quality) into a hidden `.duplicates` folder. Nothing is deleted. A folder whose artist your music library does not know is left alone.
- **undo** puts everything back from the undo log that `fix --apply` writes into `<folder>/.mvtool/`.

Years and genres come from your own music library (WBTV's database, filled from folders or Navidrome): the earliest real year of the matching song, and its genre (or the artist's usual genre).

```bash
# 1. read-only report (the media folder is mounted read-only, so this cannot change anything)
docker run --rm -v "/path/to/Music Videos":/mv:ro -v /opt/wbtv:/db:ro wb20244/wbtv:latest \
  node tools/mvtool.mjs audit /mv --db /db/wbtv.db --csv /tmp/report.csv

# 2. dry run, then do it
docker run --rm -v "/path/to/Music Videos":/mv -v /opt/wbtv:/db:ro wb20244/wbtv:latest node tools/mvtool.mjs fix /mv --db /db/wbtv.db
docker run --rm -v "/path/to/Music Videos":/mv -v /opt/wbtv:/db:ro wb20244/wbtv:latest node tools/mvtool.mjs fix /mv --db /db/wbtv.db --apply

# 3. changed your mind
docker run --rm -v "/path/to/Music Videos":/mv wb20244/wbtv:latest node tools/mvtool.mjs undo /mv/.mvtool/<date>/undo.json
```

If your WBTV database is in use, copy `wbtv.db` (and its `-wal`/`-shm` files) somewhere first and point `--db` at the copy. Then let WBTV scan the library twice (the second scan confirms the old file names are really gone).

## mvdl.py - fetch music videos from the command line

A stand-alone, dependency-free Python tool (needs `yt-dlp` and `ffmpeg`) that fills the same `Artist/Artist - Title.mp4` + poster + `.nfo` layout WBTV reads.
Artists come from Navidrome, video lists from MusicBrainz, files from yt-dlp. Lyric / audio / "Topic" uploads and still-image-with-audio files are rejected.

    python tools/mvdl.py setup                   # Navidrome login + your local music video folder (saved to ~/.mvdl.json)
    python tools/mvdl.py artists                 # your Navidrome artists and how many videos you have of each
    python tools/mvdl.py list "Morrissey"        # what MusicBrainz knows, marked have / MISSING
    python tools/mvdl.py get "Morrissey" -n      # dry run; drop -n to download, or use --all-artists
    python tools/mvdl.py url <youtube-url> --force   # one chosen video (--force skips the checks)

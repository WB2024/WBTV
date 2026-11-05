# Everything WBTV does

The complete feature list, by area. For what's new in each version see the [releases](https://github.com/WB2024/WBTV/releases). For where WBTV is ahead of, and behind, other tools see [COMPARISON.md](COMPARISON.md).

## Channels, built for you

- **Automatic channel inference** from your `.nfo` tags and folders. You never create a channel.
  - TV shows go on a channel named after their `<studio>` (BBC One, ITV1, Channel 4...). A show can sit on several studio channels.
  - Shows with no (big enough) studio land on themed **genre channels**, e.g. *The Spooky Channel* for Horror.
  - Movie libraries feed movie channels only: **genre** (*Fright Night Cinema*), **studio** and **decade** (*1990s Cinema*) channels.
  - **Music videos** become genre and decade channels (*Pop Videos*, *Rock Box*, *1990s Music TV*), numbered from 400.
  - **Radio** stations by genre and decade (*Jazz FM*, *1990s Radio*), numbered from 800.
  - **Spoken-word stations**: interviews, podcasts and audiobooks, one station per library.
  - **Live** channels (IPTV playlists, HLS links, YouTube live), numbered from 600.
- Duplicate station names are disambiguated automatically.
- **Edit anything**: rename, renumber, switch channels on and off, upload a logo. Your edits survive rescans.
- Minimum channel size, genre channels for every show, movie studio/decade channels and the films needed for a studio channel are all adjustable.
- Channel search box, and *Enable shown* for bulk switching. Empty channels (their library was removed) are marked *empty* and can be removed with one click.

## Music video discovery and download (IMVDb, optional)

- Setup > **Music videos**: lists the artists in your music library (Navidrome or folders), looks each one up on [IMVDb](https://imvdb.com/developers/api), and shows their videos with *in your library* marked. Download one, a selection, or everything you are missing.
- Saved as `Artist/Artist - Title.mp4` with a clean `.nfo` (the real release year from IMVDb, your library's genre for that artist, the IMVDb id and the director) and a poster, then WBTV rescans so the video appears in your channels.
- You need your own free IMVDb app key. It is stored on the server and never shown in the browser. It is off until a **WBTV password**, the key, and a **writable music video folder** are all in place: WBTV keeps your media read-only unless you choose to make that one folder writable.
- One download at a time, at low priority; a failed download shows its reason and can be retried; the queue survives a restart.
- **`tools/mvdl.py`** is a lightweight command-line version that runs on your own computer: it reads artists from Navidrome (`top 20` takes the artists with the most songs), finds official videos through MusicBrainz and yt-dlp, appends "(official music video)" to searches, and can work through text files of YouTube links (one file per artist, or a folder of them). It only keeps official uploads (a live recording is fine when it is the official video), and rejects lyric or audio videos and still images. See [tools/README.md](../tools/README.md).
- Downloading from YouTube or Vimeo may go against their terms. It is your choice to use it, and WBTV does not enable it by default.

## Channel groups

- Every TV, movie, music-video and clips library can be given a **channel group** (Setup > Libraries). Libraries that share a group name become **one channel**: for example *Stand Up Films*, *Stand Up Shows* and their *Unmanaged* folders all in the group "Stand Up".
- Each library chooses how it becomes channels: **genre / studio channels** (the default), **one channel** (only the group channel), or **both**.
- **Clips / interviews** is a library type for short videos of every kind: one channel, shuffled back to back, no ad breaks.
- `tools/jfplan.mjs` reads a Jellyfin server and proposes a matching set of WBTV libraries and groups (read-only).

## The schedule

- **A real, persistent schedule**, planned ahead (about 14 hours) and saved. The guide, the stream and the XMLTV feed always agree.
- **Join mid-programme**, like real TV. Every viewer of a channel shares one live stream.
- **History**: scroll back through what already aired.
- **Programmes start on the dot**, with a lead-in of ads and announcements where enabled.
- **Always tunable**: between programmes a channel is still on air (ad breaks, announcements).
- **Automatic dayparting**: WBTV leans towards what suits the time of day from your own genres and age ratings: cartoons after school and on Saturday morning, mature and horror content late. Switch it off in Settings.
- **Stable re-planning**: a rescan only re-plans what hasn't aired yet and doesn't reshuffle the rest of the guide.

## Guide and watching

- **EPG grid** (Freeview-style): what's on now, what was on, what's next, with poster, plot, cast, studio, year, rating and genres.
- **Live preview** in the guide.
- **Filter chips**: All channels, TV, Movies, Music, Radio, Live, Networks and Genres, plus **one chip for every channel group** that has its own channel (chips with nothing in them are hidden). On Android TV, Up from the top row reaches the chips, and Rewind / Fast-forward step through them from anywhere in the guide.
- **Pause, rewind, skip and return to live**, on a rolling server-side buffer (10 minutes by default, adjustable).
- **Info banner** with a progress bar, "N min left", what's next, and how far behind live you are. On radio the banner follows the *track* you are watching.
- **Channel surfing**: number entry (0-9), last channel, channel up/down.
- **Nine themes**: Classic, Vintage, 90s, Modern, Aero, Teletext, Synthwave, and two Satellite looks (classic and HD) inspired by the early-2000s UK satellite guide. Web and Android TV.
- **Keyboard control** on the web (arrows, Enter, 0-9, Space, L, F, G/Esc, `[` `]`).
- **Fullscreen on select** option.

## Authentic TV presentation

- **"Coming up next" announcements**: after each programme a continuity slot plays a clip from inside the next programme while a voice reads what's on next and after that, with UP NEXT / AFTER THAT / LATER captions. Uses each programme's description, with sensible fallbacks.
  - **Generated locally and offline** with [Piper](https://github.com/rhasspy/piper): free, no AI service, nothing leaves your network.
  - Two British voices built in; **more voices (British and American, including high-quality ones) install with one click** from Setup > Announcements, with a sample button.
  - **Natural speech**: years ("nineteen eighty-nine"), episode codes ("season four, episode ten"), abbreviations, numbers and punctuation pauses are said the way a person would say them.
  - Choose how many programmes to mention and how long the slot may run; announcements never hold up a tune-in.
- **Classic ad breaks**: mid-programme breaks of a length and frequency you set.
  - Sources: YouTube, archive.org, direct links (downloaded once with yt-dlp), or **local folders** tagged *TV* or *Movies* so trailers only play on movie channels.
  - **Long ad-break compilations** supported: each break plays a random chunk, like joining a recorded break in progress.
  - **Era-matched adverts**: the year is read from an ad's title or folder name (`1994`, `1990s`, `80s`) and ads from the programme's era are preferred.
  - WBTV ships with no ads; they come from you.
- **Channel logos / name bug** on programmes (upload a logo or fall back to the channel name).
- **Station idents**: a short ident before each programme: a generated card (big channel number and name), or **your own clips** from a folder added as *Station idents / bumpers* (up to 20 seconds each, chosen at random).
- **Closedown**: an overnight test card ("Off air") in a time window you choose, shown in the guide too.
- All of the above are individually switchable in Settings.

## Languages and subtitles

- **Preferred audio language**: if a file has several audio tracks, the one in your language is used (commentary tracks are avoided), not just the first.
- **Subtitles burned into the picture** (a live stream has no subtitle menu): *only when there is no audio in your language* (the default), *always*, or *never*. Forced subtitles for foreign dialogue inside an English film are included.
- Subtitles come from a file beside the video (`Movie.en.srt`, `.ass`, `.vtt`) or from a text track inside it. Tracks inside a file are extracted once, in the background, ahead of the programme airing, and cached.
- Not yet: bitmap subtitles (PGS/DVD), and choosing a different language per channel.

## Music and radio

- **Music-video channels** playing back to back with an **Artist - Title lower-third**. Uses `<musicvideo>` NFOs, or just name files `Artist - Title.mp4`.
- **Radio stations** from audio files (mp3, flac, m4a, ogg, ...): the screen shows **cover art, now-playing text and a live waveform**.
  - **Tidy stations**: a song plays once across different releases, tracks under 45 seconds or over 15 minutes are skipped, and sub-genres fold into one station per family.
  - **Station look** (Setup): classic, a blurred cover-art backdrop, or frequency bars.
  - **Lyrics**: a time-synced `.lrc`, an `.srt`, or a `.txt`/`.lyrics` file next to the track (same name), or lyrics stored in the file's tags. Synced lyrics follow the song with the next line previewed; plain text is paged across the song as an estimate. Switch off in Settings.
  - **Cover art** from `cover.jpg` / `folder.jpg` / `front.jpg` in the folder, or the picture embedded in the files (read once per album and filled in gradually for existing libraries).
  - Tags are read from the files; filenames like `01 - Artist - Title.flac` are understood when tags are missing. Junk dates (e.g. `0001-01-01`) are ignored in favour of the real year or a `[1985]` folder name.
- **Spoken-word stations** (library types *Radio: interviews / podcasts / audiobooks*):
  - **Interviews**: shuffled.
  - **Podcasts**: one channel per show by default, episodes oldest first, looping. Or one station that rotates between shows.
  - **Audiobooks**: one station playing one book at a time, chapters in order, then the next book. Or, with *one channel per show / book* ticked (Setup > Libraries), a channel per book that always plays in order and loops. **`.m4b` supported**, including embedded cover art.
  - Show/book, author, date, track number and description come from the tags, with folder names as the fallback.

## Live TV and IPTV

- Add an **M3U/M3U8 playlist** (URL or file), a **single HLS stream** or a **YouTube live link**; each stream becomes a channel in the same guide, with pause/rewind and the same themes.
- **Health checks** hide dead streams; one-click suggestions for public community lists (e.g. iptv-org news) are built in.
- YouTube live (including separate video and audio streams) is resolved with yt-dlp each time you tune in.
- Large playlists start with the first 80 working channels enabled; enable more in bulk.

## Jellyfin and Emby as a source

- Setup > Libraries > *Read TV and films from Jellyfin / Emby*: enter the server address and an API key (Jellyfin: Dashboard > API Keys), then add the TV and movie libraries you want.
- Titles, plots, studios, genres, ratings, cast and pictures come from the server, so channels are inferred exactly as from folders (a studio becomes a channel, a genre a themed one). Folder and server libraries can be mixed.
- Playback reads the original files from the server over HTTP; the API key is kept on the WBTV server, is never put in an item path, and is hidden from logs.
- If the server is down during a scan, nothing is removed. Pictures are downloaded a few hundred at a time per scan.
- Not yet: Plex as a source, music/audiobooks from a server, and fetching subtitles through the server's own subtitle endpoint (embedded subtitles are extracted by reading the file).

## Navidrome as a source (music)

- Add a Navidrome (or other Subsonic / OpenSubsonic) server under Setup > Libraries with its address and your login; choose *All music* or a single music folder. Songs become radio stations by genre and decade, exactly as from folders.
- **Cover art** (one picture per album) and **lyrics** (time-synced where the server has them) come from the server, so radio screens look right even when the files carry no embedded art.
- WBTV stores a login token and salt, not your password, and hides them from logs.
- Not yet: spoken-word libraries from Audiobookshelf, and Plex.

## Works with your other apps

- **HDHomeRun emulation**: add WBTV as a Live TV tuner in **Plex, Jellyfin and Emby**. The MPEG-TS stream is remuxed, not re-encoded.
- **M3U playlist** (`/iptv/playlist.m3u`) and **XMLTV guide** (`/iptv/epg.xml`) for TiviMate, VLC, Kodi, Channels and any IPTV app.
- **Documented HTTP API** ([docs/API.md](API.md)): everything the web UI and the Android app do is available to scripts and your own clients.
- `GET /api/status` for monitoring (channels running, viewers, load, memory, voice queue); `GET /healthz` for container health checks.

## Android TV / Fire TV app

- Native **Kotlin / Jetpack Compose / Media3**, built for the remote. Opens on your last channel like switching a TV on.
- The same guide, themes, filter chips and pause/rewind as the web UI, plus channel surfing and number entry.
- A full **settings screen** on the TV: theme, fullscreen behaviour, access key, and the server's own switches (ad breaks, announcements, logos, idents, closedown, dayparting, era-matched ads, stream size, rescans, scan now).
- Crash-recovery relaunch, retries while a channel is starting, a "Tuning..." indicator, and surf debouncing so flipping through channels doesn't flood the server.
- Needs Android 8+; tested on a Fire TV (Android 9). APK in each [release](https://github.com/WB2024/WBTV/releases).

## Samsung (Tizen) TV app

- A TV-only client for Samsung TVs in plain JavaScript (no build step), with the same guide, chip row (one chip per channel group), banner and number entry as the other apps. Music and radio slots show the picture and description of the track playing now.
- Live playback through Samsung's **AVPlay**; a desktop browser falls back to a `<video>` tag, and `tizen/dev.mjs` lets you try the guide in one.
- Install with Apps2Samsung (**Custom WGT File**), Tizen Studio's command line, or the TizenBrew module. First run asks for the server address.
- The server sends `Access-Control-Allow-Origin: *` on GET requests to `/api/` and `/live/` so a page served from the TV can read the guide and streams. Anything that changes data is unchanged.
- Tested on one 2022 The Frame (Tizen 6.5). See [tizen/README.md](../tizen/README.md).

## Performance

- **One shared encode per watched channel**, stopped about 25 seconds after the last viewer leaves.
- **Stream size** setting (720p / 576p / 480p); 576p uses roughly 30% less CPU per channel.
- **Hardware encoding**: Intel/AMD VAAPI and NVIDIA NVENC, with a real self-test and automatic CPU fallback.
- **Incremental scans** that lean on NFO data (including `durationinseconds`, so ffprobe is rarely needed), run automatically on a timer, on startup, or on demand.
- Cold-start protection: a cap on simultaneous channel starts and abandoned tune-ins start nothing, so channel-surfing can't swamp the server. Voice generation runs at low priority and skips channels you've left.
- Slow tune-ins are logged with a timing breakdown.

## Reliability and safety

- **Your media is read-only** and is never modified.
- **Offline-share protection**: if a network share or mount disappears, WBTV will not wipe its library; it waits for a second scan to confirm before removing anything.
- Settings are validated before they are saved; a bad value can't hang the scheduler.
- The server logs and continues on unexpected errors instead of dying; the container has a health check.
- **Optional password and access key** for browsers, apps, IPTV players and tuners.

## Install and run

- One Docker container (Node 24, ffmpeg, yt-dlp, Piper built in). Images for **amd64** (arm64 built by CI).
- Config and database in a single volume; live segments in a tmpfs.
- Works on Unraid, Synology/QNAP, TrueNAS, Proxmox LXC and plain Linux.
- Free and open source under the **MIT licence**.

<p align="center">
  <img src="Images/Assets/1.png" alt="WBTV - Live TV, your way" width="640">
</p>

<p align="center">
  <img src="Images/Assets/6.png" alt="Live TV. Your Way." width="360">
</p>

**WBTV turns your own media library into a live TV service.** Point it at your movies and shows, and it builds
channels from your `.nfo` tags, then "broadcasts" them on a persistent schedule. Open a channel and you join
whatever is on *right now*, mid-programme, exactly like real television, complete with an old-school EPG guide
and (if you like) nostalgic ad breaks.

<p align="center">
  <img src="Images/Assets/11.png" alt="EPG style TV guide, your media your rules, classic ad breaks, self-hosted" width="700">
</p>

<p align="center">
  <img src="Images/Screenshots/web-guide-classic.jpg" alt="The WBTV guide" width="900">
</p>

## Features

| | |
|---|---|
| <img src="Images/Assets/7.png" width="120"><br>**EPG-style guide** | A Freeview-era grid: what's on now, what was on, what's next. Poster, plot, cast and studio for every programme. |
| <img src="Images/Assets/8.png" width="120"><br>**Your media, your rules** | Add folders like in Jellyfin and say what they contain (TV, Movies, Ads). Channels are built automatically from your NFO tags. |
| <img src="Images/Assets/9.png" width="120"><br>**Classic ad breaks** | Optional mid-programme breaks and programmes that start on the dot, using old adverts you supply (links or local folders). |
| <img src="Images/Assets/10.png" width="120"><br>**Self-hosted** | One Docker container. Your files stay read-only on your disk. Web UI plus a native Android TV app. |

- **Channels are inferred from your tags.**
  - TV shows go on a channel named after their `<studio>` tag (BBC One, ITV1, Channel 4...). A show can be on several studio channels.
  - Shows with no (big enough) studio land on themed genre channels, e.g. *The Spooky Channel* for Horror.
  - Movie libraries only feed movie channels: genre channels (*Fright Night Cinema*), studio channels and decade channels (*1990s Cinema*).
  - Rename, renumber or disable any channel in Setup. Your edits survive rescans.
- **Fast, incremental scans** that lean on NFO data (including `durationinseconds`, so ffprobe is rarely needed). Rescans run automatically on a timer.
- **A real schedule.** Planned ahead and persisted, so the guide and the stream always agree, with history you can scroll back to. Every viewer of a channel shares one live stream.
- **Ad breaks (optional).** Add YouTube / archive.org / direct links (downloaded once with yt-dlp) or point at local folders tagged *TV* or *Movies* (so trailers only play on movie channels). Long ad-break compilations are supported: each break plays a random chunk, like joining a recorded break in progress.
- **"Coming up next" announcements.** After each programme a continuity slot plays: a clip from inside the next programme with a voice reading out what's on next and after that, using each programme's description (with sensible fallbacks), plus UP NEXT / AFTER THAT / LATER captions. The voice is generated locally with [Piper](https://github.com/rhasspy/piper): offline, free, no AI service. Two British voices (Alan and Jenny).
- **Filter chips** above the guide: All channels, TV, Movies, Networks (studio channels) and Genres.
- **Pause and rewind live TV.** A rolling buffer on the server (10 minutes by default) lets you pause, skip back and return to live, on the web and on Android TV.
- **Know how long is left.** The info banner shows a progress bar and "N min left" for the current programme, what's next, and how far behind live you are if you've paused.
- **Always tunable.** Between programmes (ad breaks and announcements) a channel is still on air and you can still tune to it.
- **Nine themes**: Classic, Vintage, 90s, Modern, Aero, Teletext, Synthwave and two **Satellite** looks (classic and HD) inspired by the early-2000s UK satellite guide, with the live preview kept. On the web and on Android TV.
- **Android TV app** with a proper remote-control experience, a full settings screen, and server controls (ads, announcements, rescans) right from the sofa (see below).

## Quick start

```yaml
# docker-compose.yml
services:
  wbtv:
    image: wb20244/wbtv:latest
    container_name: wbtv
    restart: unless-stopped
    ports:
      - 8420:8080
    environment:
      - TZ=Europe/London
    volumes:
      - /opt/wbtv:/config                  # database + downloaded ads
      - /mnt/Main20TB:/mnt/Main20TB:ro     # your media, read-only
    tmpfs:
      - /tmp/wbtv:size=2g                  # live stream segments (incl. the pause/rewind buffer)
```

```bash
docker compose up -d
```

Then open `http://<host>:8420`, click **Setup**, and add your first library folder.

| Environment variable | Default | |
|---|---|---|
| `WBTV_WIDTH` / `WBTV_HEIGHT` | `1280` / `720` | Stream resolution |
| `WBTV_CRF` | `23` | x264 quality (lower = better and bigger) |
| `WBTV_PRESET` | `veryfast` | x264 speed preset |
| `WBTV_BROWSE_ROOTS` | `/mnt,/media,/data` | Folders the in-app folder browser may show |
| `PIPER_BIN` / `PIPER_VOICES` | `/opt/piper/piper` / `/opt/piper/voices` | Speech engine and voice folder (already in the image) |

> **No authentication.** WBTV is designed for your home network. Don't expose it to the internet.

## Setup

<p align="center">
  <img src="Images/Screenshots/web-setup-libraries.jpg" alt="Libraries" width="48%">
  <img src="Images/Screenshots/web-setup-channels.jpg" alt="Channels" width="48%">
</p>
<p align="center">
  <img src="Images/Screenshots/web-setup-ads.jpg" alt="Ads" width="48%">
  <img src="Images/Screenshots/web-setup-announcements.jpg" alt="Announcements" width="48%">
</p>
<p align="center">
  <img src="Images/Screenshots/web-setup-settings.jpg" alt="Settings" width="48%">
</p>

1. **Libraries**: add a folder and say what's in it. *TV Shows* and *Movies* feed channels; *Ads* folders feed ad breaks.
2. **Channels**: check what was built, rename or renumber things, switch channels off.
3. **Ads** (optional): turn on ad breaks, set how long and how often, add ad folders or links.
4. **Announcements**: switch the "coming up next" voice-overs on or off, pick the voice (with a sample button), and choose how many programmes to mention and how long it may run.
5. **Settings**: automatic rescans, the pause/rewind buffer, and how many channels get created (minimum channel size, genre channels for every show, movie studio and decade channels).
6. **Appearance**: pick a theme, and choose whether selecting a programme jumps straight to fullscreen.

Use the **filter chips** above the guide (or `[` and `]`) to show only TV channels, movie channels, networks or genres:

<p align="center">
  <img src="Images/Screenshots/web-guide-filters.jpg" alt="Filter chips: Movies" width="80%">
</p>

**Web keys:** arrows to browse, Enter to watch, 0-9 for a channel number, Space to pause, Left/Right to rewind or skip in fullscreen, L to go back to live, F for fullscreen, G or Esc for the guide.

## Themes

<p align="center">
  <img src="Images/Screenshots/web-guide-vintage.jpg" alt="Vintage" width="48%">
  <img src="Images/Screenshots/web-guide-90s.jpg" alt="90s" width="48%">
</p>
<p align="center">
  <img src="Images/Screenshots/web-guide-modern.jpg" alt="Modern" width="48%">
  <img src="Images/Screenshots/web-guide-aero.jpg" alt="Aero" width="48%">
</p>
<p align="center">
  <img src="Images/Screenshots/web-guide-teletext.jpg" alt="Teletext" width="48%">
  <img src="Images/Screenshots/web-guide-synthwave.jpg" alt="Synthwave" width="48%">
</p>
<p align="center">
  <img src="Images/Screenshots/web-guide-satellite.jpg" alt="Satellite (classic)" width="48%">
  <img src="Images/Screenshots/web-guide-satellite-hd.jpg" alt="Satellite HD" width="48%">
</p>

## Android TV app

<p align="center">
  <img src="Images/Assets/2.png" alt="WBTV app icon" width="120">
</p>

`android/` contains a native Kotlin / Jetpack Compose / Media3 app. It opens on your last channel, like switching a
TV on, and is built for the remote.

<p align="center">
  <img src="Images/Screenshots/tv-loading.png" alt="Loading" width="48%">
  <img src="Images/Screenshots/tv-welcome.png" alt="First launch" width="48%">
</p>
<p align="center">
  <img src="Images/Screenshots/tv-guide-classic.png" alt="Guide, Classic theme" width="48%">
  <img src="Images/Screenshots/tv-settings.png" alt="Settings" width="48%">
</p>
<p align="center">
  <img src="Images/Screenshots/tv-guide-satellite.png" alt="Guide, Satellite (classic) theme" width="48%">
  <img src="Images/Screenshots/tv-guide-satellite-hd.png" alt="Guide, Satellite HD theme" width="48%">
</p>

| Key | Watching | In the guide |
|---|---|---|
| Up / Down, CH+ / CH- | next / previous channel | move between channels; Up from the top row goes to the filter chips and **Settings** |
| Left | last channel | previous programme |
| Right | info banner (progress, minutes left) | next programme |
| OK / Guide | open guide | tune it (a live programme, or any programme if the channel is between programmes); fullscreen if the setting is on |
| Play / Pause | pause or resume live TV | same |
| Rewind / Fast-forward | back 30 s / forward 30 s (past the live edge = back to live) | |
| 0-9 | jump to channel number | same |
| Menu | settings | settings |
| Back | press twice to exit | close the guide |

**Settings** (Menu, or Up from the top row of the guide then the Settings button): theme, fullscreen behaviour, and the server's own switches (ad breaks, "coming up next" announcements, automatic rescans, pause/rewind buffer, scan now), so you can change them without a laptop.

**Build** (needs JDK 17+ and the Android SDK, e.g. from Android Studio):

```bash
cd android
./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
adb connect <tv-ip>:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

On first launch the app asks for your server address, e.g. `192.168.1.110:8420`. Tested on a Fire TV (Android 9);
it needs Android 8 or newer.

## Project layout

```
src/         Node.js server: scanner, channel inference, scheduler, live HLS broadcaster, API
public/      Web UI (vanilla JS)
android/     Android TV app (Kotlin, Compose, Media3); unit tests: ./gradlew testDebugUnitTest
Images/      Artwork (Assets) and screenshots (Screenshots)
test/        Unit tests (npm test)
Dockerfile   Node 24 + ffmpeg + yt-dlp + Piper (speech)
```

<p align="center">
  <img src="Images/Assets/3.png" alt="WBTV" width="160">
</p>

# How WBTV compares

WBTV is one of several projects that turn your media into live TV. They make different trade-offs, and which is best depends on what you want. This page tries to be fair, including where others are ahead.

*Last checked 2 Nov 2026, from each project's own README and documentation (nothing here was benchmarked). Spotted a mistake? Please open an issue and I'll fix it.*

## The short version

- **Pick WBTV** if you want something that builds the channels itself from your tagged library (a studio becomes a channel, a genre becomes "The Spooky Channel"), looks like early-2000s TV, has its own Android TV / Fire TV app, and speaks "coming up next" between programmes. It is free and runs as one container.
- **Pick [ErsatzTV](https://github.com/ErsatzTV/ErsatzTV) or [Tunarr](https://github.com/chrisbenincasa/tunarr)** if you want to hand-build channels and schedules, use Plex/Jellyfin/Emby as the source, watch through Plex/Jellyfin/TiviMate or any IPTV player, or need hardware transcoding today.
- **Pick [FieldStation42](https://fieldstation42.com)** if you want a cable-box simulator on a CRT or Raspberry Pi, with the deepest scheduling and sign-off/bumper authenticity.
- **Pick [MediaWave2000](https://github.com/Mamaweegee123/MediaWave2000)** if you want a point-and-click desktop app on one Mac or Windows PC.

## Feature comparison

✅ yes · 🟡 partial · ❌ no

| | **WBTV** | ErsatzTV | Tunarr | FieldStation42 | MediaWave2000 |
|---|---|---|---|---|---|
| Free and open source | ✅ | ✅ | ✅ | ✅ | 🟡 free, licence not stated |
| Reads local folders directly | ✅ | ✅ | ✅ | ✅ | ✅ |
| Uses Kodi/Jellyfin `.nfo` metadata | ✅ | 🟡 | ✅ | 🟡 | ❌ |
| **Builds channels automatically from studio/genre tags** | ✅ | ❌ | ❌ | ❌ | 🟡 folder = channel |
| Works with no configuration | ✅ | ❌ | 🟡 | ❌ | ✅ |
| TV guide (EPG grid) in the browser | ✅ | ✅ | ✅ | 🟡 on-screen only | ❌ |
| **Own native Android TV / Fire TV app** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Spoken "coming up next" announcements** | ✅ | ❌ | ❌ | 🟡 clips | ❌ |
| Ad breaks from YouTube/archive.org URLs | ✅ | ❌ | ❌ | ❌ | 🟡 beta |
| Separate ad pools for TV and movie channels | ✅ | ❌ | ❌ | 🟡 | 🟡 |
| Music-video channels | ✅ | 🟡 | 🟡 | ✅ | ✅ |
| Radio channels from audio files | ✅ | ❓ | ❓ | ✅ | ✅ |
| Live IPTV / M3U / YouTube live as channels | ✅ | ❓ | ❓ | ✅ | 🟡 |
| Pause / rewind live TV | ✅ | ❓ | ❓ | ❌ | 🟡 |
| Themes (Freeview, Satellite, 90s, Aero, ...) | ✅ 9 | ❌ | ❌ | 🟡 | ✅ |
| One-container Docker install | ✅ | ✅ | ✅ | ❌ | n/a |
| Plex / Jellyfin / Emby as a source | ❌ | ✅ | ✅ | ❌ | ❌ |
| **M3U + XMLTV output / HDHomeRun emulation** | ❌ | ✅ | ✅ | ❌ | ❌ |
| Hardware transcoding | ❌ | ✅ | ✅ | n/a | ❌ |
| Hand-built schedules, dayparting, drag-and-drop editor | ❌ | ✅ | ✅ | ✅ | ❌ |
| Channel logos / on-screen bug | ❌ | ✅ | ✅ | ✅ | ✅ |
| Sign-off and station bumpers | ❌ | ❌ | ❌ | ✅ | ❌ |
| Subtitles / audio track choice | ❌ | ✅ | ✅ | ❓ | 🟡 |
| Login / users | ❌ | ❓ | ❓ | 🟡 API key | n/a |
| ARM / Raspberry Pi image | ❌ | ✅ | ✅ | ✅ | ❌ |
| Established community and docs site | ❌ new | ✅ | ✅ | ✅ | 🟡 |

## What is on the roadmap

The gaps above that I plan to close first: M3U/XMLTV/HDHomeRun output, hardware transcoding, optional login, ARM images, subtitles and audio tracks, and channel logos. Ideas that nobody else does and I want to build: automatic dayparting from your metadata (kids' shows before 7pm, horror late), and ads matched to the era of what is airing.

## Notes

- Paid products exist too (for example Curacast and NostalgiaTV); WBTV will always be free.
- WBTV is young and maintained by one person. If you need something battle-tested for a household today, ErsatzTV and Tunarr have years of mileage behind them.

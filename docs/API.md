# WBTV HTTP API

Everything the web UI and the Android TV app do goes through this API, so you can script WBTV or build your own client. All JSON unless noted. The base URL is your server, e.g. `http://192.168.1.110:8420`.

## Authentication

Off by default. When you set a password (Setup > Settings > Security) every endpoint below except `/healthz` and `/api/auth/*` needs one of:

- the session cookie from `POST /api/auth/login` (browsers), or
- the **access key**, sent as `Authorization: Bearer <key>`, `x-wbtv-key: <key>`, or `?key=<key>` (apps, scripts, IPTV players).

A missing or wrong credential returns `401 {"error":"login required"}`.

## Good to know

- JSON answers over about 1.4 KB are gzipped for clients that send `Accept-Encoding: gzip` (the guide shrinks about 20 times). Browsers, Android and most HTTP libraries do this on their own.
- `GET` requests to `/api/*` and `/live/*` carry `Access-Control-Allow-Origin: *`, so a page served from another origin (the Samsung TizenBrew route) can read the guide and streams. Nothing that changes data is opened up.

| Method & path | Notes |
|---|---|
| `GET /healthz` | Always open. `{ok:true}` |
| `GET /api/auth/status` | `{enabled, authed}` |
| `POST /api/auth/login` | `{password}` sets the session cookie |
| `POST /api/auth/logout` | clears the cookie |
| `POST /api/auth/password` | `{password}` (4+ chars) turns the password on or changes it; returns `{key}` |
| `DELETE /api/auth` | turns the password off |
| `GET /api/auth/key` / `POST /api/auth/key` | read / regenerate the access key |

## Guide and channels

| Method & path | Notes |
|---|---|
| `GET /api/channels` | Enabled channels: `id, key, kind, name, number, enabled, item_count`. `kind` is `tv`, `movie`, `music`, `radio` or `live`. `?all=1` includes disabled ones |
| `PATCH /api/channels/:id` | `{name?, number?, enabled?}` |
| `POST /api/channels/rebuild` | Re-infer channels and re-plan |
| `GET /api/epg?from=&to=` | Unix seconds. `{now, from, to, programmes: {channelId: [{id, item, start, end, title, subtitle, plot, season, episode, year, genres, ...}]}}` |
| `GET /api/channels/:id/now` | What is on right now |
| `GET /api/items/:id` | Full metadata for a programme's item |
| `GET /api/art/:id` | Poster / cover image |

## Watching

| Method & path | Notes |
|---|---|
| `GET /live/:channelId/index.m3u8?v=<viewerId>` | The channel's live HLS stream. Pass a random `v` per viewer and `POST /live/:id/stop?v=` when done so the server can stop encoding. Includes the pause/rewind window |
| `GET /auto/v<number>` | The same channel as a plain MPEG-TS stream (no re-encode), used by the HDHomeRun emulation |

## Libraries, scanning, live sources

| Method & path | Notes |
|---|---|
| `GET /api/libraries`, `POST /api/libraries`, `DELETE /api/libraries/:id` | `{path, type, name?}`. Types: `tv`, `movies`, `music`, `radio`, `iptv`, `ads`, `ads_tv`, `ads_movies`. `iptv` takes a URL or a file |
| `GET /api/scan`, `POST /api/scan` | Status / start (`{libraryId?}`) |
| `GET /api/browse?path=` | Folder browser for the setup UI |
| `GET /api/live/presets`, `GET /api/live/summary`, `POST /api/live/recheck`, `POST /api/live/:lib/enable` | IPTV / YouTube-live sources |

## Settings and ads

| Method & path | Notes |
|---|---|
| `GET /api/settings`, `PUT /api/settings` | Partial update, e.g. `{adsEnabled:true}`. Credentials are never included |
| `GET /api/status` | What the server is doing now: version, uptime, memory, CPU load, running channels with viewer counts, voice-over queue. Useful when something feels slow |
| `GET /api/hw` | Which video encoder is active (`software`, `vaapi`, `nvenc`) and why |
| `GET /api/ads`, `POST /api/ads`, `DELETE /api/ads/:id` | Ad URLs (`POST {urls, kind}`) |
| `GET /api/promo/status`, `GET /api/promo/sample?voice=` | "Coming up next" voices |

## Tuner / IPTV output

| Path | Use |
|---|---|
| `/iptv/playlist.m3u` | M3U playlist for any IPTV player |
| `/iptv/epg.xml` | XMLTV guide (as far ahead as the schedule is planned, about 14 hours) |
| `/discover.json`, `/lineup.json`, `/lineup_status.json`, `/device.xml` | HDHomeRun emulation for Plex, Jellyfin, Emby and Channels |

When a password is set, URLs shown in Setup > Settings > Security already include `?key=`.

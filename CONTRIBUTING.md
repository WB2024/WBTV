# Contributing to WBTV

Thanks for wanting to help. Bug reports, ideas, documentation fixes and pull requests are all welcome.

## Reporting a bug
Open an [issue](https://github.com/WB2024/WBTV/issues/new/choose) and include your WBTV version, how you run it, and the output of `http://<server>:8420/api/status` and `docker logs wbtv`.

## Running it locally
Needs Node 22.13+ (24 recommended), ffmpeg and ffprobe on your PATH.

```bash
npm ci
npm test                         # unit tests
PORT=8099 WBTV_CONFIG=./cfg WBTV_TMP=./tmp WBTV_BROWSE_ROOTS=/path/to/media node src/server.js
```

Piper (announcement voices) and yt-dlp are optional for local development; without them announcements and YouTube sources are simply skipped.

The Android TV app lives in `android/` (JDK 17+, Android SDK): `./gradlew assembleDebug` and `./gradlew testDebugUnitTest`.

## Pull requests
- Keep changes focused, and add or update a test where it makes sense (`test/`).
- `npm test` must pass; CI runs it and builds the image for amd64 and arm64.
- The web UI is deliberately dependency-free vanilla JS; please keep it that way.
- By contributing you agree your work is released under the project's [MIT licence](LICENSE).

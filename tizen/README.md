# WBTV for Samsung (Tizen) TVs

A small TV-only client in plain ES5 (no build step, no framework), made for the remote. It talks to your WBTV server's own API and plays the live channels through Samsung's **AVPlay**.

Tested on a 2022 Samsung The Frame (Tizen 6.5). The app asks for Tizen 4.0 or newer, but only that one TV has been tried.

## What it does

- The guide: channel rows with what is on now and a progress bar, a picture and description for the selected channel, and what is on next.
- A chip row: All, TV, Movies, Music, Radio, Live, plus one chip for every channel group on your server.
- Music and radio slots follow the **track playing now**, so the picture and description match what you hear.
- Live playback with a banner (title, time left, next track), pause, number entry and channel up/down.
- First run asks for the server address (for example `192.168.1.110:8420`) and remembers it.
- If your server has a password, add its access key (WBTV Setup shows it) to the address: `192.168.1.110:8420?key=YOURKEY`.

## Remote control

| In the guide | |
|---|---|
| Up / Down | Move through channels |
| Up on the first channel | Move into the chip row |
| Left / Right (chips) | Pick a chip |
| Down or OK (chips) | Back to the channel list |
| OK | Watch the highlighted channel |
| Rewind / Fast-forward | Previous / next chip from anywhere |
| Channel +/- | Page through the list |
| Red | Reload channels and guide |
| Info | Change the server address |
| Back | Exit |

| Watching | |
|---|---|
| Up / Down, Channel +/- | Next / previous channel in the current chip |
| 0-9 | Type a channel number |
| OK / Info | Show the banner |
| Play / Pause | Pause / resume |
| Back / Stop | Return to the guide |

## Install

A Samsung TV only runs apps that are signed. There are two ways to get this one on.

### 1. Apps2Samsung (easiest)

1. Turn on Developer mode on the TV: open **Apps**, press **1 2 3 4 5**, switch Developer mode **On**, enter your computer's IP as the Host PC IP, and power the TV off and on.
2. Install [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung), pick your TV, choose **Custom WGT File**, and select `WBTV-Tizen.wgt` from the [release](https://github.com/WB2024/WBTV/releases). It signs the package for you.
3. Open **WBTV** from the app list and enter your server address.

### 2. Tizen Studio command line (build it yourself)

You need Tizen Studio (or its command-line tools) with the **TV Extensions** and **Samsung Certificate Extension** packages, and a Samsung certificate profile made in Certificate Manager (sign in with a free Samsung account; tick your TV so its ID goes in the certificate).

```sh
tizen package -t wgt -s <your-profile> -o out -- tizen      # tizen/ is the app folder (leave dev.mjs out if you like)
tizen install -n WBTV.wgt -s <tv-ip>:26101 -- out
tizen run -p WbtvTV0001.WBTV -s <tv-ip>:26101
```

### 3. TizenBrew

The repository's `package.json` carries the TizenBrew module fields (`packageType: app`, `appPath: tizen/index.html`), so the module name is `WB2024/WBTV`. This route is less tested: the page is then served by TizenBrew rather than packaged, so it is a different origin from your server. The server allows that for read-only (GET) requests to `/api` and `/live`.

## Try it in a desktop browser

```sh
node tizen/dev.mjs http://192.168.1.110:8420 8077    # then open http://localhost:8077
```

`dev.mjs` serves this folder and forwards GET requests to your server, so no CORS setup is needed. It only forwards reads; it is for trying the guide, not for the TV. Playback in a browser falls back to a plain `<video>` tag.

## Notes

- Developer mode must stay on for installs, and the Host PC IP must be the machine you install from. Apps already installed keep working when you change it.
- The server sends `Access-Control-Allow-Origin: *` on GET `/api/*` and `/live/*` so a page served from the TV can read the guide and streams. Nothing that changes data is opened up.
- Samsung's AVPlay is used when it is there; otherwise the app uses an HTML5 `<video>` tag.

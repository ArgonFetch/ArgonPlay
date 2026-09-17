# <p align="center">Argon Play</p>

<p align="center">
  <img src="icons/icon.svg" width="120" alt="Argon Play">
</p>

<p align="center">
  <strong>YouTube, played from an ArgonFetch instance.</strong><br>
  The page never starts YouTube's player, so there is nothing for an ad to interrupt.
</p>

---

## What it does

Argon Play does not block ads. It does not touch YouTube's player at all. It hides it, asks an
[ArgonFetch](https://github.com/ArgonFetch/ArgonFetch) instance for the same video's streams, and
plays those in a player of its own, mounted in the box YouTube already sized.

The rest of the page is untouched - title, description, comments, recommendations, search,
navigation. Only the picture comes from somewhere else.

- **Looks like the page it sits in.** The chrome is built to the current YouTube player's
  measurements, read off the running player rather than guessed at, and uses its icons. The
  settings menu resizes and slides between sub-menus the way theirs does, play morphs into pause
  along the same path, the volume arcs scale with the level. The accent is ArgonFetch purple
  instead of red.
- **Seeks properly.** Video and audio arrive as separate byte-range streams and are kept in sync,
  so the timeline works the way a timeline should.
- **Full quality ladder**, up to whatever the source has and your browser can decode.
- **Subtitles**, in every language the video carries, taken from the page's own caption list.
- **Ambient mode**, redrawn from our video, because hiding YouTube's player takes its glow with it.
- **Theater mode**, driven through YouTube's own size button so the page rearranges exactly as it
  always did, corners squared off with it.
- **Autoplay**, following the video the page itself would have played next.
- **The Download button finally does something.** If the page has one, Argon Play takes it over; if
  it does not, it adds one. Either way it offers the real renditions, sound included.
- **Your instance or the public one.** Point it at a self-hosted ArgonFetch and no request leaves
  your network except the one to the source.

## Install

Nothing is published to a store yet, so load it unpacked.

**Chrome, Edge, Brave** - open `chrome://extensions`, turn on *Developer mode*, choose *Load
unpacked*, and pick this folder.

**Firefox** - rename `manifest.firefox.json` over `manifest.json` first, then open
`about:debugging#/runtime/this-firefox`, choose *Load Temporary Add-on*, and pick it. Firefox drops
temporary add-ons when it restarts.

The two manifests differ in one line: Chrome runs the background as a service worker, Firefox as an
event page, and each rejects the other's key. Shipping both keys in one file makes Chrome build an
MV2-style background page instead, so they are kept apart.

The options page opens on install. The defaults work; the only setting worth a thought is which
instance to use.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Instance | `https://app.argonfetch.dev` | Where the streams come from. *Test* says whether it answers |
| Take over the player | on | Off leaves YouTube's player exactly as it was |
| Highest quality | 1080p | Argon Play never asks for more, and drops to what your browser can decode |
| Prefer H.264 | off | On trades bytes for hardware decoding. Off picks the smaller stream, usually VP9 |
| Autoplay | on | A browser you have not clicked in yet still refuses, and the player says so |
| Starting volume | 100% | |

## How it works

```
youtube.com/watch
      │
      │  content script: hide ytd-player, mount ours in #player-container
      ▼
 background worker  ──►  GET /api/Fetch/GetPlayback?url=…   (your instance)
      │                        │
      │                        └─ video[] and audio[] tracks, each seekable
      ▼
  <video> + <audio>  ──►  GET /api/Stream/Media/{key}  with Range
```

The background worker is the only thing that talks to the instance: a content script inherits
`youtube.com` as its origin and the instance's CORS policy does not list it, while the worker's
host permission waives CORS entirely. The media elements load their streams directly, which needs
no permission at all - YouTube's CSP restricts `script-src`, not `media-src`.

### Why two elements

YouTube keeps its better pictures as video-only streams with the sound stored separately. A player
that wants 1080p has two files to play at once, so the video element is the clock and the audio is
corrected towards it: a jump when they are more than 250 ms apart, and a playback rate nudged by up
to 5% when they are closer than that, which closes a small gap without being audible. Neither is
allowed to play while the other is starved.

### What comes from the page rather than from the instance

The instance supplies the media. Everything else a player needs is already in the page, put there
by YouTube under the viewer's own session, so Argon Play reads it instead of asking for it:

| From `ytInitialPlayerResponse` / `ytInitialData` | Used for |
|---|---|
| `captions.playerCaptionsTracklistRenderer.captionTracks` | the subtitle list, with signed URLs |
| `…autoplay.sets[0].autoplayVideo.watchEndpoint.videoId` | what Autoplay plays next |

Both live in YouTube's own JavaScript world, which a content script cannot reach, so `page.js`
runs there (`"world": "MAIN"`), reads the two values and posts them across. It only ever reads and
only ever posts; a page-world script that takes instructions from the page is a way in.

Captions are fetched from `timedtext` with `&fmt=vtt`, which is same-origin and therefore carries
the viewer's cookies, then wrapped in a blob and attached as a `<track>`.

Calling InnerTube (`/youtubei/v1/player`) instead would mean re-requesting what is already there,
and it answers `UNPLAYABLE` without the attestation token the page's own player holds.

### Why ArgonFetch needed a new endpoint

`GetResource`, the endpoint the downloader uses, muxes video and audio with FFmpeg as it writes the
response. That is right for a download and wrong for a player: a muxed response has no length and
ignores `Range`, so the timeline cannot go past what has already arrived.
[`GetPlayback`](https://docs.argonfetch.dev/api#playing-instead-of-downloading) was added for this,
and hands over the tracks apart, with codecs named, each served by a route that answers ranges.

Argon Play still works against an instance that predates it - it falls back to `GetResource` and
plays the muxed stream, with a timeline that cannot seek and a chip that says so. Update the
instance to get seeking.

## Layout

```
manifest.json          MV3, with the Firefox keys alongside the Chrome ones
background.js          the only thing that talks to an instance; self-contained on purpose
content/
  argon.js             DOM helpers, the icon set, and track selection
  player.js            the player: the two elements, their sync, and the chrome
  boot.js              everything that knows about YouTube
  page.js              runs in YouTube's own world; reads captions and up-next, posts them out
  player.css           the chrome, at YouTube's measurements
options/               settings
popup/                 on/off, instance health, re-resolve
```

## Known limits

- **A cold resolve is not instant.** yt-dlp takes a few seconds on a video the instance has not
  seen; the player says what it is waiting for.
- **Watch pages only.** Shorts, embeds and the miniplayer are left to YouTube.
- **Live streams are not handled.** They resolve to a manifest, which this does not play.
- **Age-restricted and members-only videos** need an instance with `COOKIES_PATH` configured.
- **Firefox temporary add-ons** are dropped on restart until this is signed.
- **Captions and Autoplay need `world: "MAIN"`**, which is Chrome 111+ and Firefox 128+. On
  anything older the player works and those two rows simply do not appear.
- **Captions are styled with `::cue`**, which is far less expressive than YouTube's own renderer;
  positioning and per-cue styling from the source are mostly lost.

## License

This project is licensed under the GPL-3.0 License. See [LICENSE](LICENSE) for details.

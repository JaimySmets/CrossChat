# CrossChat

A Manifest V3 browser extension that replaces YouTube's live chat with a self-rendered
panel sourced from **Twitch**, rendering native Twitch emotes **plus 7TV, BTTV and FFZ**
(global + per-channel) — the third-party emotes that the old iframe-embed approach can't
show. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design.

## MVP status

Read-only, **no OAuth** (anonymous Twitch IRC read). Implemented:

- YouTube DOM adapter: channel detection and an **Enable Twitch chat** toggle overlaid on
  `ytd-live-chat-frame`. CrossChat stays off until you click it (so you can arrange theatre
  mode first); enabling hides — not destroys — YouTube's native chat so it can be restored.
  The panel is dark-mode themed, re-asserts itself across theatre toggles, and resets per
  channel on SPA navigation.
- Twitch read via anonymous IRC-over-WebSocket, owned by the service worker, behind the
  `ChatSource` interface (so EventSub can replace it later without touching the UI).
- Emote Registry: 7TV/BTTV/FFZ global + per-channel sets merged with a precedence rule
  (channel > global; provider order 7TV > BTTV > FFZ), applied as a case-sensitive
  whole-word pass over message text. Twitch user id is resolved with no auth via the FFZ
  room endpoint.
- YouTube→Twitch handle mapping persisted in `chrome.storage.local`, prompted in-panel.

**Deferred (post-MVP, already interface-ready):** OAuth, EventSub read, sending
(`ChatSink` + Helix), Kick, YouTube-as-target.

## Develop

```bash
npm install
npm run dev      # vite dev server + HMR (keep running)
# or
npm run build    # tsc --noEmit && vite build  -> dist/
```

Load `dist/` (after `npm run build`) or the dev build at `chrome://extensions` →
Developer mode → **Load unpacked**.

## Try it

1. Open a YouTube **live** stream (a live-chat panel must exist on the page).
2. Arrange your layout (e.g. theatre mode), then click **Enable Twitch chat** in the chat
   panel's top-right corner.
3. When prompted, enter the Twitch username to read from for that channel.
4. Messages stream into the panel with names, colors, and Twitch + 7TV/BTTV/FFZ emotes.
   Click **↩ YouTube chat** to switch back at any time.
5. Navigate to another stream without reloading → the toggle resets; enable it again there.

## Content-Security-Policy note

Emote images are injected as `<img>` into the YouTube document, so they load under
**YouTube's page Content-Security-Policy**. This has been verified in-browser: emotes from
all CDNs (`cdn.7tv.app`, `cdn.betterttv.net`, `cdn.frankerfacez.com`, `static-cdn.jtvnw.net`)
render fine, so no `declarativeNetRequest` rule to relax `img-src` is needed.

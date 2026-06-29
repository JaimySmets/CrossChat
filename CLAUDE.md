# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CrossChat is a Manifest V3 browser extension (TypeScript + Vite via `@crxjs/vite-plugin`) that
replaces YouTube's live chat with a self-rendered panel sourced from Twitch, compositing in
7TV/BTTV/FFZ emotes that the old iframe-embed approach couldn't render.

## Commands

```bash
npm run dev        # vite dev server + HMR; keep running, then load dist/ as unpacked
npm run build      # tsc --noEmit (typecheck) && vite build -> dist/
npm run typecheck  # tsc --noEmit only
```

There is no test suite or linter. `tsc` is the only static gate and `strict` is on (plus
`noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`) — keep the build clean.

Load the extension at `chrome://extensions` → Developer mode → **Load unpacked** → pick `dist/`.
Verification is manual: open a YouTube **live** stream (a live-chat panel must exist), click
**Enable Twitch chat** in the chat frame's top-right, enter the Twitch login when prompted.

## Architecture

Two execution contexts, bridged by a single typed `chrome.runtime` port. **The content script
holds no sockets and no tokens** — it only renders and forwards user input; the service worker
owns all connections, identity resolution, and emote compositing.

- **Content script** (`src/content/`): `youtube-adapter.ts` is the entry. It detects the
  channel handle, mounts the enable/disable toggle, and on opt-in swaps YouTube's native chat
  for the `Panel` (`panel/`). The worker pushes render-ready `NormalizedMessage`s back.
- **Service worker** (`src/background/`): `service-worker.ts` is the entry; it spawns one
  `engine/engine.ts` `Session` per connected panel. The Session resolves the channel, builds
  the emote registry, drives a `ChatSource` (anonymous IRC), applies the registry in `emit`, and
  on login sends through a `ChatSink` (`sinks/`); OAuth identity is owned by `auth/`.
- **Shared contract** (`src/shared/`): `protocol.ts` defines the `PanelToWorker` /
  `WorkerToPanel` message union and `PORT_NAME`; `messaging.ts` wraps the port for both ends;
  `types.ts` holds the platform-agnostic types (`NormalizedMessage`, `Fragment`, `ChatSource`,
  `ChatSink`, `SendResult`, `ResolvedChannel`, `AuthState`).

### Two-pass emote rendering (the core design)

1. A `ChatSource` splits out only **platform-native** emotes (Twitch emotes, which arrive
   identified in the wire payload) into `emote` fragments; the rest stays as `text` fragments.
2. The **Emote Registry** (`emotes/registry.ts`) does a second pass over `text` fragments,
   substituting 7TV/BTTV/FFZ emotes via case-sensitive **whole-word** token matching.

The registry merges global + per-channel sets from all three providers into one `name → emote`
map, resolving collisions by score: channel sets beat global, then provider rank 7TV > BTTV > FFZ
(`PROVIDER_RANK`). Globals are cached ~6h, per-channel sets ~30m, keyed by Twitch user id.

### Abstractions designed for extension

The `ChatSource`/`ChatSink` interfaces and `NormalizedMessage` exist so Twitch can be swapped or
joined by Kick (and a YouTube *send* target) without touching the UI or registry. Honor these
boundaries: a new platform is a new source/sink module, not changes to the engine or panel.

## Implementation notes — no-auth shortcuts & what's unbuilt

`ARCHITECTURE.md` describes the architecture as built. A few Twitch paths are deliberate no-auth
shortcuts, isolated behind interfaces so the official equivalents can replace them later:

- Read is **anonymous Twitch IRC-over-WebSocket** (`sources/twitch-irc-source.ts`), not EventSub.
  This is the kept read path (login-free reading is a goal), not a throwaway — but the
  `ChatSource` seam lets an authenticated EventSub read drop in later.
- Twitch user id is resolved with **no auth via FFZ's room endpoint** (`engine/resolve.ts` →
  `emotes/ffz.ts`), not Helix `/users`. If FFZ has no record, `userId` is empty but IRC read
  still works (channel-specific emotes just won't load). On send, `broadcaster_id` is
  resolved/confirmed via Helix `/users?login=` with the user token.
- Badges are resolved to real artwork via **anonymous Twitch GraphQL** (`badges/twitch-badges.ts`,
  public web Client-Id, no secret), not Helix `/chat/badges`; on any miss/failure `render.ts`
  falls back to CSS role chips. The `getUserToken()` seam there still returns null — wiring badges
  to Helix now that a user token exists is an open follow-up. The gql endpoint is an undocumented
  no-auth spike.

Sending **is** built: OAuth via the **implicit grant** (`auth/twitch-auth.ts`, `chrome.identity`;
Twitch offers no PKCE for public clients) and a `ChatSink` over Helix `POST /chat/messages`
(`sinks/twitch-sink.ts`, scope `user:write:chat`). The composer is hidden until login; read stays
anonymous so lurkers never authenticate. Still unbuilt but interface-ready: **EventSub read,
Kick, a YouTube send target, an emote picker, and token refresh** (the implicit grant has none —
the panel re-prompts login on expiry).

These endpoints (IRC tags, FFZ, gql, Helix) churn — verify shapes against live behavior when
touching them.

### YouTube DOM adapter gotchas

YouTube is a SPA and re-stamps the chat frame on theatre toggles and navigation. The adapter
relies on: `yt-navigate-finish` for SPA nav, MutationObservers on the frame and on
`ytd-watch-flexy[theater]`, and a `reassert()` fixpoint that keeps the panel mounted and the
hijack marker set so re-stamped native chat stays hidden and can't overlap the panel. Native
chat is **hidden in place, not detached**, on enable (`frame[data-cc-hijacked]` → CSS
`display:none`): the chat is an `<iframe>`, and removing it from the DOM discards its browsing
context, so a stash-and-restore would reveal a blank frame. The toggle floats over the frame
while disabled and re-homes into the panel header (beside the gear) while enabled. The toggle is
mounted per-channel and the session resets on channel change.

Note: emote `<img>`s load under YouTube's page CSP, but this has been verified in-browser to
work — emotes render, so no `declarativeNetRequest` rule to relax `img-src` is needed.

# CrossChat — Architecture Design Document

> Working name: **CrossChat**. A browser extension that replaces YouTube's live chat with
> a chat panel sourced from another streaming platform (Twitch first, Kick later), rendered
> with full third-party emote support (7TV, BTTV, FFZ) so the viewing experience matches what
> native Twitch/Kick users see.

**Status:** Pre-implementation design. Intended as the seed reference for a Claude Code build.
**Last updated:** 2026-06-14

---

## 1. Motivation & Problem Statement

An existing extension ("Twitch Chat for YouTube") embeds Twitch chat onto YouTube live pages
by injecting an `<iframe src="https://www.twitch.tv/embed/.../chat">` into YouTube's
`ytd-live-chat-frame` container. This works, but the iframe is Twitch's own cross-origin
document, and locally-installed emote extensions (7TV, BTTV, FFZ) do **not** inject into it.
The result: the user sees raw emote *text* while everyone else sees emote *images*.

This cannot be patched onto the iframe approach — it is structural. The fix is to **stop
embedding Twitch's chat UI and render our own chat panel**, over which we have full control of
message rendering and can therefore composite in third-party emotes ourselves.

### Goals (v1)
- Replace YouTube live chat with a self-rendered chat panel.
- Read chat from Twitch in real time.
- Render Twitch native emotes + 7TV + BTTV + FFZ (global and per-channel sets).
- Send messages back to the source platform (Twitch), with emote autocomplete/picker.
- Preserve the original extension's nice YouTube-side behaviors: channel-handle detection,
  YouTube→source username mapping with persistence, dark-mode matching, height sync.

### Non-Goals (v1)
- YouTube as a **chat source** (read path). Explicitly deferred — see §7.
- Relaying/bridging messages between two platforms' chats.
- Moderation tooling beyond what a normal chatter has.

### Deferred / Future
- **Kick** as a second source (and target). Official OAuth 2.1 API exists; fits the
  abstraction. Second platform to add, not YouTube.
- YouTube as a *target* (sending into YouTube chat) — possible but quota-limited; see §7.

---

## 2. Key Design Decisions (and rationale)

| Decision | Rationale |
|---|---|
| Render our own chat panel instead of embedding an iframe | The iframe is the root cause of the emote gap. Self-rendering is the only way to composite 7TV/BTTV/FFZ. |
| Source/Sink abstraction from day one | Lets Twitch be v1 while keeping Kick (and a YouTube *target*) addable without rewrites. Designing against the *shape* of two APIs keeps the abstraction from being secretly Twitch-shaped. |
| All-EventSub for Twitch (read + send via Helix) | We need an OAuth token to send anyway, so anonymous IRC reads buy nothing. EventSub gives cleaner structured JSON than IRC and is Twitch's recommended path. One connection style to maintain. |
| OAuth token + WebSocket owned by the background service worker | Content scripts are the wrong place for a long-lived authenticated socket. The worker owns connection lifecycle and tokens; the content script is a thin renderer. |
| Twitch first, Kick second, YouTube-source last/never | Ranked purely by integration friendliness. Twitch wants to be read; Kick has an official API; YouTube read is polling + quota-capped and doesn't scale to a published extension. |
| Markdown design doc in-repo | Versioned with code, directly readable by Claude Code. |

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ YouTube live page (content script context)                       │
│                                                                   │
│  ┌────────────────────┐      injects/sizes      ┌──────────────┐ │
│  │ YouTube DOM Adapter │ ───────────────────────▶│ Chat Panel UI │ │
│  │  - channel handle   │                          │  - message    │ │
│  │  - chat container   │                          │    list       │ │
│  │  - video height     │                          │  - input box  │ │
│  │  - dark mode        │                          │  - emote      │ │
│  └────────────────────┘                          │    picker     │ │
│            │                                       └──────┬───────┘ │
│            │   chrome.runtime messaging (port)            │         │
└────────────┼───────────────────────────────────────────-─┼─────────┘
             │                                              │
┌────────────▼──────────────────────────────────────────---▼─────────┐
│ Background Service Worker                                           │
│                                                                    │
│  ┌──────────────┐   ┌─────────────────┐   ┌─────────────────────┐  │
│  │ Auth Manager │   │  Chat Engine     │   │ Emote Registry      │  │
│  │ - OAuth flow │   │  (Source/Sink)   │   │ - Twitch native     │  │
│  │ - token store│──▶│  - TwitchSource  │◀──│ - 7TV  (global+chan)│  │
│  │ - refresh    │   │  - TwitchSink    │   │ - BTTV (global+chan)│  │
│  └──────────────┘   │  - [KickSource]  │   │ - FFZ  (global+chan)│  │
│                     │  - [KickSink]    │   │ merged name→img map │  │
│                     └─────────────────┘   └─────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

The content script never holds tokens or sockets. It renders and forwards user input. The
worker resolves identities, owns the live connection, normalizes inbound messages, applies the
emote registry, and pushes render-ready message objects to the panel.

---

## 4. Core Abstractions

### 4.1 ChatSource (read)
A platform-agnostic inbound stream of normalized messages.

```ts
interface ChatSource {
  platform: "twitch" | "kick";          // (youtube deferred)
  connect(channel: ResolvedChannel): Promise<void>;
  disconnect(): void;
  onMessage(cb: (msg: NormalizedMessage) => void): void;
  onState(cb: (s: ConnectionState) => void): void;
}
```

### 4.2 ChatSink (send)
A platform-agnostic outbound path.

```ts
interface ChatSink {
  platform: "twitch" | "kick" | "youtube";  // youtube allowed as TARGET only
  send(channel: ResolvedChannel, text: string): Promise<SendResult>;
  capabilities(): { canSend: boolean; rateLimitHint?: number };
}
```

### 4.3 NormalizedMessage
The single internal shape every source must produce. Rendering and emote compositing operate
only on this, never on platform-specific payloads.

```ts
interface NormalizedMessage {
  id: string;
  author: { displayName: string; color?: string; badges: Badge[] };
  fragments: Fragment[];   // text + platform-native emotes, pre-split by the source
  timestamp: number;
  platform: string;
}

type Fragment =
  | { type: "text"; value: string }
  | { type: "emote"; name: string; url: string; provider: "twitch"|"7tv"|"bttv"|"ffz" };
```

Important: the **source** is responsible only for splitting out *platform-native* emotes
(e.g. Twitch emotes, which arrive identified in the event payload). The **Emote Registry**
(§5) does a second pass over remaining `text` fragments to substitute 7TV/BTTV/FFZ emotes,
since those are client-side overlays not present in the wire payload.

### 4.4 ResolvedChannel
```ts
interface ResolvedChannel {
  platform: string;
  login: string;        // e.g. twitch username
  userId: string;       // numeric/string platform ID — needed for emote sets + EventSub
  displayName?: string;
}
```

---

## 5. Emote Registry

The differentiator. Builds a merged `name → emote` lookup per channel.

### Sources of emotes
1. **Twitch native** — already identified in the EventSub message payload; the source emits
   them as `emote` fragments directly. No registry lookup needed.
2. **7TV** — global set + per-channel set (keyed by the platform user ID). First-class Kick
   support too, which is a point in Kick's favor later.
3. **BTTV** — global + per-channel.
4. **FFZ** — global + per-channel.

### Build process (per channel connect)
1. Resolve `userId` for the channel (Twitch Helix `/users`, Kick equivalent later).
2. Fetch global sets for 7TV / BTTV / FFZ (cacheable across channels, refresh periodically).
3. Fetch per-channel sets for each provider using `userId`.
4. Merge into one `Map<emoteName, {url, provider}>`. Define precedence on name collisions
   (suggested: channel-specific over global; provider order configurable, default 7TV > BTTV > FFZ).

### Apply process (per message)
For each `text` fragment in a `NormalizedMessage`, tokenize on whitespace, and for each token
that exactly matches (case-sensitive) a registry key, replace it with an `emote` fragment.
Emotes are whole-word matches — do not substitute inside larger words.

> Note: exact, case-sensitive whole-word matching mirrors how the real extensions behave and
> how Twitch itself treats emote names on send.

### Caching
- Global sets: cache with a TTL (e.g. hours), shared across channels.
- Per-channel sets: cache keyed by `(platform, userId)`, refresh on reconnect or TTL.
- Endpoints/scopes for each provider should be verified against current docs at build time —
  these APIs evolve.

---

## 6. Platform Modules

### 6.1 Twitch (v1 — full read + send)
- **Auth:** Registered Twitch application (dev console) → Client-Id. User OAuth (PKCE flow
  suited to an extension) producing a User Access Token.
  - Scopes: `user:read:chat` (read via EventSub), `user:write:chat` (send).
- **Read:** EventSub WebSocket, subscribe to `channel.chat.message`. Structured payload with
  author, badges, and message fragments (incl. native emotes).
- **Send:** `POST https://api.twitch.tv/helix/chat/messages` with `broadcaster_id`,
  `sender_id`, `message`. Emotes are sent as their case-sensitive names in plain text — there
  is no special emote payload. This is *why* sending "just works": every platform's
  client-side emote extension beautifies the same plain words on the receiving end.
- **ID resolution:** Helix `/users?login=` → numeric user ID, used for both EventSub and
  emote-set fetches.
- **Token lifecycle:** access tokens expire; implement refresh. This is the single most
  fiddly part of the project — budget for it accordingly.

> NOTE for the implementer: verify the *current* EventSub subscription shape, transport
> handshake (session welcome → subscribe via Helix with the session id), and required scopes
> against dev.twitch.tv at implementation time. Twitch has been actively moving chat off IRC
> toward EventSub + Helix; do not build on IRC chat commands (deprecated).

### 6.2 Kick (deferred — second platform)
- Official public API, OAuth 2.1. App registered at Kick developer settings → client id/secret.
- Chat send/receive supported. Maps onto `ChatSource`/`ChatSink` the same way Twitch does.
- Younger API: expect endpoint/scope churn; verify against docs.kick.com at build time.
- 7TV/BTTV/FFZ emote sets largely exist for Kick too, so the Emote Registry mostly reused.

### 6.3 YouTube
- **As source (read): NOT IMPLEMENTED, possibly never.** Data API v3 `liveChatMessages.list`
  is polling (laggy, not streaming) and quota-metered (~10k units/day default, exhausted fast
  by live-chat polling). Does not scale to a published, multi-user extension.
- **As target (send): possible future opt-in.** `liveChatMessages.insert` requires Google
  OAuth + YouTube scope + write quota, and introduces UX ambiguity (which audience am I
  talking to?). Kept behind the `ChatSink` interface so it *can* be added without touching
  the core, but flagged experimental.

---

## 7. YouTube DOM Adapter (reused knowledge)

The original extension already solved the YouTube-side glue; port these specifics:

- **Channel handle:** scrape from
  `ytd-video-owner-renderer a.yt-simple-endpoint.style-scope.yt-formatted-string`, strip the
  `https://www.youtube.com/@` prefix, lowercase.
- **Chat container / injection point:** `ytd-live-chat-frame` — empty it and inject the panel.
- **Height sync:** match `document.querySelector('video').clientHeight`; re-sync on resize.
- **Dark mode:** `window.matchMedia('(prefers-color-scheme: dark)')` to theme the panel.
- **YouTube→source username mapping:** persist via `chrome.storage.local`, keyed by YouTube
  handle. Prompt the user when unknown. (The original also pulled a shared mapping JSON from a
  GitHub raw URL — optional; consider shipping our own or relying on storage + prompt.)

SPA caveat: YouTube is a single-page app; navigations don't reload the content script. The
adapter must observe URL/navigation changes (e.g. `yt-navigate-finish` event or a
MutationObserver) and re-inject/reconnect when the user moves between streams.

---

## 8. Extension Structure (Manifest V3)

```
crosschat/
├── manifest.json            # MV3; permissions, host permissions, OAuth redirect
├── src/
│   ├── content/
│   │   ├── youtube-adapter.ts   # DOM detection, injection, height/dark-mode, SPA nav
│   │   └── panel/               # chat panel UI (message list, input, emote picker)
│   ├── background/
│   │   ├── service-worker.ts    # entry; message routing between panel and engine
│   │   ├── auth/                # OAuth flows + token storage/refresh (per platform)
│   │   ├── engine/              # ChatSource/ChatSink orchestration, normalization
│   │   ├── sources/             # twitch-source.ts  [kick-source.ts]
│   │   ├── sinks/               # twitch-sink.ts     [kick-sink.ts] [youtube-sink.ts]
│   │   └── emotes/              # registry, provider fetchers (7tv/bttv/ffz), cache
│   ├── shared/                  # NormalizedMessage, interfaces, types, constants
│   └── ui/                      # shared components/styling
├── ARCHITECTURE.md          # this document
└── README.md
```

### Permissions (anticipated)
- `storage` — username mapping, token cache, emote cache.
- Host permissions for `*.youtube.com` (content script), plus the API/socket origins for
  Twitch (and later Kick) and the emote provider CDNs.
- An OAuth redirect surface for the extension (e.g. `chrome.identity` launchWebAuthFlow).

---

## 9. Message Flow (end to end)

**Inbound (read + render):**
1. Adapter detects channel handle → asks worker to resolve source channel.
2. Worker maps YouTube handle → Twitch login (storage/prompt), resolves `userId`.
3. Worker builds Emote Registry for the channel (cached where possible).
4. Worker connects `TwitchSource` (EventSub), subscribes to `channel.chat.message`.
5. On each event: source emits `NormalizedMessage` with native-emote fragments split out.
6. Emote Registry second pass substitutes 7TV/BTTV/FFZ tokens in text fragments.
7. Worker pushes render-ready message to the panel; panel appends to the list.

**Outbound (send):**
1. User types in panel input (with emote autocomplete/picker over the registry).
2. Panel sends raw text to worker.
3. Worker calls `TwitchSink.send()` → Helix `POST /chat/messages` with the user's token.
4. Message echoes back through the normal inbound EventSub path and renders like any other.

---

## 10. Risks & Open Questions

- **OAuth lifecycle** is the heaviest single piece. Token expiry/refresh, and the extension
  redirect flow, need care. ~half the total effort lives here.
- **API churn:** verify Twitch EventSub shapes/scopes and all three emote providers' endpoints
  at build time; verify Kick's API when that module starts.
- **Platform ToS:** because this is published (not a personal script), read each platform's
  developer terms before wiring it in. Twitch and Kick offer official integration-friendly
  APIs; that's exactly why they're the chosen targets. Scale raises visibility/risk vs a
  private tool — design around supported APIs only.
- **Trademark/naming:** "CrossChat" as the project identity, with platform marks (Twitch,
  YouTube, 7TV) used descriptively in the tagline/description rather than baked into the brand
  name. Confirm Chrome Web Store + GitHub availability before committing.
- **Emote name collisions** across providers — precedence rule needs to be defined and
  configurable (default suggested in §5).
- **Rate limits** on send (Twitch) and on emote-provider fetches — cache aggressively; respect
  hints.
- **YouTube SPA navigation** — robust re-injection on in-app navigation is a common source of
  bugs; test moving between streams without full reloads.

---

## 11. Suggested Build Order (for the skeleton)

1. **MV3 skeleton + YouTube DOM Adapter:** detect channel, inject an empty panel, sync height
   and dark mode, handle SPA navigation. (Pure front-end, no auth — fastest path to "it's on
   the page".)
2. **Twitch read, unauthenticated proof:** stand up the `ChatSource` interface and a Twitch
   source; get messages rendering as plain text first.
   - (If a no-auth read shortcut is convenient for early bring-up, fine for a throwaway spike,
     but the real path is EventSub which needs the token from step 4 — don't over-invest in a
     temporary IRC read.)
3. **Emote Registry:** add 7TV/BTTV/FFZ fetch + merge + the per-message substitution pass.
   This is the payoff milestone — emotes start rendering.
4. **OAuth (Auth Manager):** Twitch app registration, PKCE flow, token storage + refresh.
5. **EventSub read (authenticated) + Send (Sink):** switch reads to EventSub, add the input
   box and Helix send, with emote autocomplete over the registry.
6. **Polish:** username mapping/persistence, reconnection, caching TTLs, error states.
7. **(Later) Kick module:** second source/sink against the same interfaces.

Implement behind the Source/Sink/Registry interfaces throughout so that step 7 — and any
future YouTube *target* — is additive rather than invasive.

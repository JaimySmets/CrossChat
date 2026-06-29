# CrossChat

CrossChat is a Manifest V3 browser extension that swaps YouTube's live chat for the streamer's
Twitch chat, rendering native Twitch emotes along with 7TV, BTTV and FFZ. Reading needs no
account; logging into Twitch lets you send messages too.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design and [`CLAUDE.md`](./CLAUDE.md) for a
map of the code.

## Features

- Reads a Twitch channel's chat inside YouTube, in place of the native chat.
- Renders real emotes: native Twitch plus 7TV, BTTV and FFZ, both global and per-channel.
- Reading is anonymous, no login required.
- Optional Twitch login to send messages.
- Remembers which Twitch channel maps to each YouTube channel.
- Themeable, configurable panel that survives theatre mode and in-app navigation.

## Develop

```bash
npm install
npm run dev        # vite dev server + HMR
npm run build      # typecheck + build to dist/
npm run typecheck  # typecheck only
```

There is no test suite or linter; `tsc` (strict) is the only static gate, so keep the build
clean. Verification is manual: build, load it, and exercise it on a live stream.

## How it works

Two execution contexts talk over one typed `chrome.runtime` port. The content script renders the
panel and forwards what you type; it holds no sockets and no tokens. The service worker owns the
connections and your Twitch identity, running one session per panel that resolves the channel,
streams messages in through a `ChatSource`, composites emotes, and sends through a `ChatSink`
when you are logged in.

These source and sink boundaries are deliberate: adding a platform should mean a new module, not
changes to the engine or panel.

## Privacy

CrossChat has no backend and no analytics. It talks only to Twitch and the emote providers from
your browser. Your Twitch token, channel mappings and settings stay in `chrome.storage.local` on
your machine.

## Contributing

Issues and pull requests are welcome. Keep the build clean and respect the source/sink
boundaries above. The Twitch and emote-provider APIs change often, so verify request shapes
against current docs when working on those paths.

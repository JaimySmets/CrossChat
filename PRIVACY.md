# Privacy Policy

_Last updated: 5 July 2026_

CrossChat is a browser extension that replaces YouTube's live chat with the corresponding
Twitch channel's chat, rendering Twitch, 7TV, BTTV and FFZ emotes.

## Summary

CrossChat has no backend server and no analytics. It does not collect, transmit, sell, or
share any of your personal data. Everything the extension stores stays in your browser, on
your own machine.

## What CrossChat stores locally

The extension keeps the following in `chrome.storage.local` on your device:

- **Settings and preferences** — your panel and theme configuration.
- **Channel mappings** — which Twitch channel corresponds to each YouTube channel, so it
  works automatically the next time you visit.
- **Twitch access token** — only if you choose to log in with Twitch to send messages. This
  token is stored so you do not have to log in again on every visit.

This data never leaves your machine and is never sent to the developer or any third party.

## Network connections

To function, the extension communicates directly from your browser with the following
services. These connections send only what is needed to read and render chat, and are never
used for tracking:

- **Twitch** — to read chat, resolve the channel, and (only after you log in) send messages
  on your behalf.
- **7TV, BetterTTV, FrankerFaceZ** — to fetch emote sets and load emote and badge images.

CrossChat does not add tracking, telemetry, or advertising to any of these requests.

## Authentication

Logging in with Twitch is optional and only needed to send messages. It uses Twitch's
official OAuth flow via `chrome.identity`. The resulting access token is stored locally and
used solely to send messages through Twitch's API. If you only read chat, you never log in
and no token is stored.

## Data collection

CrossChat does not collect any user data as defined by the Chrome Web Store, meaning it does
not transmit any data off your device to the developer or third parties. Specifically, it
does not collect personally identifiable information, authentication credentials, personal
communications, location, browsing history, or user activity.

## Removing your data

Uninstalling the extension removes everything it stored in your browser. You can also clear
it at any time from your browser's extension storage settings.

## Changes to this policy

If this policy changes, the updated version will be published in this repository with a new
date above.

## Contact

Questions can be raised via the project's GitHub repository:
<https://github.com/JaimySmets/CrossChat>

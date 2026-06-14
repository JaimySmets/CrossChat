// Background service worker entry (ARCHITECTURE.md §3, §8).
// Owns the live connection, normalization and the emote registry. The content
// script holds no sockets and no platform tokens. Each connected panel gets a
// Session that resolves the channel and streams normalized messages back.
import { onPanelConnect } from "../shared/messaging";
import { Session } from "./engine/engine";

onPanelConnect((port) => {
  const session = new Session(port);
  port.onMessage((msg) => {
    switch (msg.type) {
      case "attach":
        void session.attach(msg.youtubeHandle);
        break;
      case "set-mapping":
        void session.setMapping(msg.youtubeHandle, msg.twitchLogin);
        break;
      case "detach":
        session.detach();
        break;
    }
  });
  port.onDisconnect(() => session.detach());
});

console.debug("[crosschat] service worker started");

// Background service worker entry (ARCHITECTURE.md §3, §8).
// Owns the live connection, normalization and the emote registry. The content
// script holds no sockets and no platform tokens. Each connected panel gets a
// Session that resolves the channel and streams normalized messages back.
import { onPanelConnect } from "../shared/messaging";
import { ACTION_TOGGLE } from "../shared/protocol";
import { Session } from "./engine/engine";

// Toolbar button: the action is owned here, but the enable/disable state lives
// per-tab in the content-script adapter, so just forward the click to the tab.
// Tabs without our content script (non-YouTube pages) have no receiver; the
// rejected promise is expected and swallowed.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null) return;
  void chrome.tabs.sendMessage(tab.id, { type: ACTION_TOGGLE }).catch(() => {});
});

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
      case "login":
        void session.login();
        break;
      case "logout":
        void session.logout();
        break;
      case "send":
        void session.send(msg.text);
        break;
    }
  });
  port.onDisconnect(() => session.detach());
});

console.debug("[crosschat] service worker started");

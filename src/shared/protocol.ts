// Wire protocol for the panel <-> service-worker port (ARCHITECTURE.md §3, §9).
import type { ConnectionState, NormalizedMessage, ResolvedChannel } from "./types";

/** Stable name used for chrome.runtime port connections. */
export const PORT_NAME = "crosschat";

/** Messages sent from the content-script panel to the service worker. */
export type PanelToWorker =
  | { type: "attach"; youtubeHandle: string }
  | { type: "set-mapping"; youtubeHandle: string; twitchLogin: string }
  | { type: "detach" };

/** Messages sent from the service worker to the content-script panel. */
export type WorkerToPanel =
  | { type: "state"; state: ConnectionState }
  | { type: "message"; message: NormalizedMessage }
  | { type: "channel-resolved"; channel: ResolvedChannel }
  | { type: "need-mapping"; youtubeHandle: string };

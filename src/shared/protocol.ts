// Wire protocol for the panel <-> service-worker port (ARCHITECTURE.md §3, §9).
import type { AuthState, ConnectionState, NormalizedMessage, ResolvedChannel } from "./types";

/** Stable name used for chrome.runtime port connections. */
export const PORT_NAME = "crosschat";

/**
 * One-shot runtime message relayed worker -> content script when the toolbar
 * action button is clicked. Distinct from the panel port (PanelToWorker): the
 * action is owned by the worker, but the toggle state lives per-tab in the
 * content-script adapter, so the worker forwards the click to the tab.
 */
export const ACTION_TOGGLE = "cc-action-toggle";

/** Messages sent from the content-script panel to the service worker. */
export type PanelToWorker =
  | { type: "attach"; youtubeHandle: string }
  | { type: "set-mapping"; youtubeHandle: string; twitchLogin: string }
  | { type: "detach" }
  | { type: "login" }
  | { type: "logout" }
  | { type: "send"; text: string }
  // Periodic no-op from the panel: receiving it resets the service worker's
  // idle timer so a silent socket (e.g. a dead channel or a dropped network)
  // can't let Chrome suspend the worker and freeze the read connection.
  | { type: "ping" }
  // OS network transition observed in the content script's DOM context, where
  // online/offline events are reliable (they aren't in the service worker).
  | { type: "network"; online: boolean };

/** Messages sent from the service worker to the content-script panel. */
export type WorkerToPanel =
  | { type: "state"; state: ConnectionState }
  | { type: "message"; message: NormalizedMessage }
  | { type: "channel-resolved"; channel: ResolvedChannel }
  | { type: "need-mapping"; youtubeHandle: string }
  | { type: "auth"; auth: AuthState }
  | { type: "send-result"; ok: boolean; error?: string };

// Thin typed wrappers over chrome.runtime ports so both ends share one contract.
import { PORT_NAME, type PanelToWorker, type WorkerToPanel } from "./protocol";

/** Panel-side: connect to the worker and exchange typed messages. */
export interface PanelPort {
  send(msg: PanelToWorker): void;
  onMessage(cb: (msg: WorkerToPanel) => void): void;
  onDisconnect(cb: () => void): void;
  disconnect(): void;
}

export function connectToWorker(): PanelPort {
  const port = chrome.runtime.connect({ name: PORT_NAME });
  return {
    send: (msg) => port.postMessage(msg),
    onMessage: (cb) => port.onMessage.addListener((m) => cb(m as WorkerToPanel)),
    onDisconnect: (cb) => port.onDisconnect.addListener(cb),
    disconnect: () => port.disconnect(),
  };
}

/** Worker-side: a single connected panel. */
export interface WorkerPort {
  send(msg: WorkerToPanel): void;
  onMessage(cb: (msg: PanelToWorker) => void): void;
  onDisconnect(cb: () => void): void;
}

/**
 * Worker-side: register a handler for incoming panel connections.
 * Returns an unsubscribe function.
 */
export function onPanelConnect(handler: (port: WorkerPort) => void): () => void {
  const listener = (port: chrome.runtime.Port) => {
    if (port.name !== PORT_NAME) return;
    handler({
      send: (msg) => port.postMessage(msg),
      onMessage: (cb) => port.onMessage.addListener((m) => cb(m as PanelToWorker)),
      onDisconnect: (cb) => port.onDisconnect.addListener(cb),
    });
  };
  chrome.runtime.onConnect.addListener(listener);
  return () => chrome.runtime.onConnect.removeListener(listener);
}

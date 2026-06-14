// Content-script entry / YouTube DOM adapter (ARCHITECTURE.md §7).
// Thin renderer: detects the channel, mounts an enable toggle, and — only once
// the user opts in — swaps YouTube's native chat for the CrossChat panel, themes
// it, bridges it to the worker, and keeps it intact across theatre toggles and
// SPA navigations. Holds no sockets and no platform tokens.
//
// Why a toggle instead of auto-injecting: YouTube (and third-party theatre
// extensions) re-stamp and re-measure the chat frame's contents when the layout
// changes. If we hijack the frame and *then* the layout changes, YouTube's
// re-stamped chat collides with our panel (the theatre "overlap" bug). Letting
// the user enable CrossChat once their layout is settled — and re-asserting our
// DOM whenever YouTube mutates the frame — keeps it stable either way.
import { Panel } from "./panel/panel";
import { connectToWorker, type PanelPort } from "../shared/messaging";

const CHAT_FRAME = "ytd-live-chat-frame";
const WATCH_FLEXY = "ytd-watch-flexy";
const OWNER_LINK =
  "ytd-video-owner-renderer a.yt-simple-endpoint.style-scope.yt-formatted-string";

/** Lowercased @handle (preferred) or channel path fallback, used as mapping key. */
function detectChannelHandle(): string | null {
  const link = document.querySelector<HTMLAnchorElement>(OWNER_LINK);
  if (!link) return null;
  const href = link.getAttribute("href") ?? link.href;
  const at = href.match(/@([^/?#]+)/);
  if (at) return at[1].toLowerCase();
  // Fallback for channels without an @handle (e.g. /channel/UC...).
  const seg = href.split("/").filter(Boolean).pop();
  return seg ? seg.toLowerCase() : null;
}

/** Resolve once an element matching `selector` exists, or null after timeout. */
function waitForElement(selector: string, timeoutMs = 15000): Promise<Element | null> {
  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

class CrossChatAdapter {
  private port: PanelPort | null = null;
  private panel: Panel | null = null;
  private currentHandle: string | null = null;
  private frame: HTMLElement | null = null;
  private toggle: HTMLButtonElement | null = null;
  /** YouTube's native chat children, stashed (not destroyed) while CrossChat is on. */
  private stashed: ChildNode[] | null = null;
  private enabled = false;
  private frameObserver: MutationObserver | null = null;
  private theaterObserver: MutationObserver | null = null;
  private readonly darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  start(): void {
    this.darkQuery.addEventListener("change", (e) => this.panel?.setTheme(e.matches));
    // YouTube is a SPA — re-evaluate on in-app navigation (§7 SPA caveat).
    window.addEventListener("yt-navigate-finish", () => void this.sync());
    void this.sync();
  }

  /** (Re)mount the toggle for the page we are currently on. Does NOT auto-connect. */
  private async sync(): Promise<void> {
    if (!location.pathname.startsWith("/watch")) {
      this.teardown();
      return;
    }
    const frame = await waitForElement(CHAT_FRAME);
    if (!frame) {
      this.teardown(); // not a live stream (no chat frame)
      return;
    }
    await waitForElement(OWNER_LINK);

    const handle = detectChannelHandle();
    if (!handle) return;

    // New channel → tear down any active session; user re-enables per channel.
    if (handle !== this.currentHandle) {
      this.teardown();
      this.currentHandle = handle;
    }

    this.frame = frame as HTMLElement;
    this.mountToggle(this.frame);
    this.watchFrame(this.frame);
    this.watchTheater();
  }

  // --- Toggle UI ----------------------------------------------------------

  private mountToggle(frame: HTMLElement): void {
    if (!this.toggle) {
      const btn = document.createElement("button");
      btn.className = "cc-toggle";
      btn.addEventListener("click", () => (this.enabled ? this.disable() : this.enable()));
      this.toggle = btn;
    }
    // The toggle is absolutely positioned within the frame; give it a context.
    if (getComputedStyle(frame).position === "static") frame.style.position = "relative";
    this.updateToggleLabel();
    if (this.toggle.parentElement !== frame) frame.appendChild(this.toggle);
  }

  private updateToggleLabel(): void {
    if (!this.toggle) return;
    this.toggle.textContent = this.enabled ? "↩ YouTube chat" : "Enable Twitch chat";
    this.toggle.dataset.on = this.enabled ? "1" : "0";
  }

  // --- Enable / disable ---------------------------------------------------

  private enable(): void {
    if (this.enabled || !this.frame || !this.currentHandle) return;

    // Stash YouTube's native chat (everything except our own toggle) so we can
    // restore it on disable instead of destroying it.
    this.stashed = Array.from(this.frame.childNodes).filter((n) => n !== this.toggle);
    for (const n of this.stashed) n.remove();

    const panel = new Panel();
    panel.setTheme(this.darkQuery.matches);
    this.panel = panel;
    // Panel fills the frame via CSS (height/width 100%); YouTube sizes/positions
    // the frame itself in both default and theatre layouts.
    this.frame.insertBefore(panel.root, this.toggle);
    this.enabled = true;
    this.updateToggleLabel();

    this.ensurePort();
    this.port!.send({ type: "attach", youtubeHandle: this.currentHandle });
  }

  private disable(): void {
    if (!this.enabled) return;
    this.port?.send({ type: "detach" });
    this.panel?.destroy();
    this.panel = null;
    if (this.frame && this.stashed) {
      for (const n of this.stashed) this.frame.insertBefore(n, this.toggle);
    }
    this.stashed = null;
    this.enabled = false;
    this.updateToggleLabel();
  }

  // --- DOM invariants -----------------------------------------------------

  /** Watch the frame's children so YouTube's re-stamps can't break our state. */
  private watchFrame(frame: HTMLElement): void {
    this.frameObserver?.disconnect();
    this.frameObserver = new MutationObserver(() => this.reassert());
    this.frameObserver.observe(frame, { childList: true });
  }

  /** Theatre toggles restyle/re-stamp the frame without an SPA navigation. */
  private watchTheater(): void {
    this.theaterObserver?.disconnect();
    const flexy = document.querySelector(WATCH_FLEXY);
    if (!flexy) return;
    this.theaterObserver = new MutationObserver(() => this.reassert());
    this.theaterObserver.observe(flexy, { attributes: true, attributeFilter: ["theater"] });
  }

  /**
   * Re-establish our DOM invariant after any YouTube mutation. Idempotent and
   * self-terminating (reaches a fixpoint, so it won't loop on its own writes):
   *  - the toggle is always present and stays on top (last child);
   *  - when enabled, the frame holds only our panel + toggle (re-stamped YouTube
   *    chat is removed — this is what prevents the theatre overlap).
   */
  private reassert(): void {
    const frame = this.frame;
    if (!frame) return;

    if (this.enabled && this.panel) {
      for (const child of Array.from(frame.children)) {
        if (child !== this.panel.root && child !== this.toggle) child.remove();
      }
      if (this.panel.root.parentElement !== frame) {
        frame.insertBefore(this.panel.root, this.toggle);
      }
    }

    if (this.toggle && frame.lastElementChild !== this.toggle) {
      frame.appendChild(this.toggle); // keep on top
    }
  }

  // --- Worker bridge ------------------------------------------------------

  private ensurePort(): void {
    if (this.port) return;
    const port = connectToWorker();
    this.port = port;
    port.onMessage((msg) => {
      if (!this.panel) return;
      switch (msg.type) {
        case "state":
          this.panel.setState(msg.state);
          break;
        case "message":
          this.panel.addMessage(msg.message);
          break;
        case "channel-resolved":
          this.panel.hideMapping();
          break;
        case "need-mapping":
          this.panel.showMapping(msg.youtubeHandle, (twitchLogin) =>
            port.send({ type: "set-mapping", youtubeHandle: msg.youtubeHandle, twitchLogin }),
          );
          break;
      }
    });
    port.onDisconnect(() => {
      this.port = null;
    });
  }

  private teardown(): void {
    this.disable(); // restores native chat if we had hijacked the frame
    this.frameObserver?.disconnect();
    this.frameObserver = null;
    this.theaterObserver?.disconnect();
    this.theaterObserver = null;
    this.toggle?.remove();
    this.toggle = null;
    this.frame = null;
    this.currentHandle = null;
  }
}

new CrossChatAdapter().start();

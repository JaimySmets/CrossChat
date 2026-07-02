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
import { ACTION_TOGGLE } from "../shared/protocol";

const CHAT_FRAME = "ytd-live-chat-frame";
const WATCH_FLEXY = "ytd-watch-flexy";
const OWNER_LINK =
  "ytd-video-owner-renderer a.yt-simple-endpoint.style-scope.yt-formatted-string";

// Header icons, sized via CSS. The YouTube glyph keeps its brand red so the
// "return to native chat" action reads at a glance; the swap arrows mean
// "change the mapped Twitch channel".
const YOUTUBE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#f00" d="M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81z"/><path fill="#fff" d="M10 15V9l5.2 3z"/></svg>';
const SWAP_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99zM21 9l-3.99-4v3H10v2h7.01v3z"/></svg>';

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
  private currentLogin: string | null = null;
  private frame: HTMLElement | null = null;
  private toggle: HTMLButtonElement | null = null;
  private enabled = false;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private frameObserver: MutationObserver | null = null;
  private theaterObserver: MutationObserver | null = null;
  private readonly darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  start(): void {
    this.darkQuery.addEventListener("change", (e) => this.panel?.setSystemDark(e.matches));
    // YouTube is a SPA — re-evaluate on in-app navigation (§7 SPA caveat).
    window.addEventListener("yt-navigate-finish", () => void this.sync());
    // The service worker can't observe online/offline reliably, so detect them
    // here (a real DOM context) and forward the hint so the read socket can
    // drop/reconnect at once instead of waiting out its liveness watchdog.
    window.addEventListener("online", () => this.port?.send({ type: "network", online: true }));
    window.addEventListener("offline", () => this.port?.send({ type: "network", online: false }));
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
    // When floating, the toggle is absolutely positioned within the frame; give
    // it a positioning context. While enabled it lives in the panel header
    // instead (see enable()), so don't yank it back into the frame here.
    if (getComputedStyle(frame).position === "static") frame.style.position = "relative";
    this.updateToggleLabel();
    if (!this.enabled && this.toggle.parentElement !== frame) frame.appendChild(this.toggle);
  }

  private updateToggleLabel(): void {
    if (!this.toggle) return;
    if (this.enabled) {
      // In-header icon button: a YouTube glyph with a custom (instant) tooltip.
      this.toggle.innerHTML = YOUTUBE_SVG;
      this.toggle.dataset.ccTip = "Back to YouTube chat";
      this.toggle.setAttribute("aria-label", "Back to YouTube chat");
      this.toggle.style.order = "2";
    } else {
      // Floating call-to-action over the native chat: text reads clearer here.
      this.toggle.textContent = "Enable Twitch chat";
      delete this.toggle.dataset.ccTip;
      this.toggle.setAttribute("aria-label", "Enable Twitch chat");
      this.toggle.style.order = "";
    }
    this.toggle.dataset.on = this.enabled ? "1" : "0";
    // Floating overlay only while disabled; in-header button while enabled.
    this.toggle.dataset.floating = this.enabled ? "0" : "1";
  }

  /** A header icon button that re-opens the mapping prompt to switch the Twitch
   *  channel for the current YouTube handle. Created fresh per enable (the panel,
   *  and thus its header, is rebuilt each time). */
  private makeChangeChannelButton(): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "cc-chan";
    btn.style.order = "1";
    btn.dataset.ccTip = "Change Twitch channel";
    btn.setAttribute("aria-label", "Change Twitch channel");
    btn.innerHTML = SWAP_SVG;
    btn.addEventListener("click", () => {
      if (!this.panel || !this.currentHandle) return;
      const handle = this.currentHandle;
      this.panel.showMapping(
        handle,
        (twitchLogin) => this.port?.send({ type: "set-mapping", youtubeHandle: handle, twitchLogin }),
        this.currentLogin ?? undefined,
      );
    });
    return btn;
  }

  // --- Enable / disable ---------------------------------------------------

  /** Toolbar action relay: same effect as clicking the in-frame toggle. No-op
   *  unless a chat frame exists on this page (so the toggle has been mounted);
   *  enable() itself guards on a resolved frame + handle. */
  toggleFromAction(): void {
    if (!this.toggle) return;
    if (this.enabled) this.disable();
    else this.enable();
  }

  private enable(): void {
    if (this.enabled || !this.frame || !this.currentHandle) return;

    // Hide YouTube's native chat rather than detaching it: the live chat is an
    // <iframe>, and removing an iframe from the DOM discards its browsing
    // context, so re-inserting it later yields a blank frame. A CSS marker
    // (see panel.css) keeps the iframe's document alive while it's hidden.
    this.frame.dataset.ccHijacked = "1";

    const panel = new Panel({
      onSend: (text) => this.port?.send({ type: "send", text }),
      onLogin: () => this.port?.send({ type: "login" }),
      onLogout: () => this.port?.send({ type: "logout" }),
    });
    panel.setSystemDark(this.darkQuery.matches);
    void panel.init();
    this.panel = panel;
    // Panel fills the frame via CSS (height/width 100%); YouTube sizes/positions
    // the frame itself in both default and theatre layouts.
    this.frame.appendChild(panel.root);
    this.enabled = true;
    this.updateToggleLabel();
    // Re-home the toggle from its floating overlay into the panel header, beside
    // the gear, now that a header exists to hold it.
    if (this.toggle) panel.mountAction(this.toggle);
    panel.mountAction(this.makeChangeChannelButton());

    this.ensurePort();
    this.port!.send({ type: "attach", youtubeHandle: this.currentHandle });
  }

  private disable(): void {
    if (!this.enabled) return;
    this.stopKeepAlive();
    this.port?.send({ type: "detach" });
    // Rescue the toggle from the panel header before the panel is destroyed, so
    // it survives as the floating overlay over the revealed native chat.
    if (this.toggle && this.frame) this.frame.appendChild(this.toggle);
    this.panel?.destroy();
    this.panel = null;
    // Reveal YouTube's native chat again (it was only hidden, never detached).
    if (this.frame) delete this.frame.dataset.ccHijacked;
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
   *  - when enabled, the hijack marker stays set (so any re-stamped native chat
   *    is hidden by CSS, preventing the theatre overlap) and our panel stays
   *    mounted; the toggle rides inside the panel header, untouched here.
   *  - when disabled, the floating toggle overlay stays present and on top.
   */
  private reassert(): void {
    const frame = this.frame;
    if (!frame) return;

    if (this.enabled && this.panel) {
      frame.dataset.ccHijacked = "1";
      if (this.panel.root.parentElement !== frame) frame.appendChild(this.panel.root);
      return;
    }

    if (this.toggle && frame.lastElementChild !== this.toggle) {
      frame.appendChild(this.toggle); // keep the floating overlay on top
    }
  }

  // --- Worker bridge ------------------------------------------------------

  private ensurePort(): void {
    if (this.port) return;
    const port = connectToWorker();
    this.port = port;
    this.startKeepAlive();
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
          // Remember the resolved login so the change-channel prompt can prefill
          // it, and clear any messages from a previously mapped channel.
          this.currentLogin = msg.channel.login;
          this.panel.setChannel(msg.channel);
          this.panel.clearMessages();
          this.panel.hideMapping();
          break;
        case "need-mapping":
          this.panel.showMapping(msg.youtubeHandle, (twitchLogin) =>
            port.send({ type: "set-mapping", youtubeHandle: msg.youtubeHandle, twitchLogin }),
          );
          break;
        case "auth":
          this.panel.setAuth(msg.auth);
          break;
        case "send-result":
          this.panel.sendResult(msg.ok, msg.error);
          break;
      }
    });
    port.onDisconnect(() => {
      this.port = null;
      this.stopKeepAlive();
      // The worker went away (crash, or Chrome suspended it). The content
      // script is the durable side and still knows the channel, so rebuild the
      // bridge and re-attach instead of leaving the panel frozen on its last
      // state. A short delay avoids a tight loop if the worker keeps dying.
      if (!this.enabled) return;
      this.panel?.setState({ status: "reconnecting", attempt: 1 });
      setTimeout(() => {
        if (!this.enabled || this.port || !this.currentHandle) return;
        this.ensurePort();
        this.port!.send({ type: "attach", youtubeHandle: this.currentHandle });
      }, 1000);
    });
  }

  /**
   * Keep the service worker awake while chat is enabled. Chrome suspends an MV3
   * worker after ~30s without activity, and a silent read socket (dead channel
   * or dropped network) produces none — which would freeze the connection. A
   * periodic port message resets that idle timer from this never-suspended
   * context. Cleared on detach/disconnect.
   */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAlive = setInterval(() => this.port?.send({ type: "ping" }), 20_000);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
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
    this.currentLogin = null;
  }
}

const adapter = new CrossChatAdapter();
adapter.start();

// Toolbar button click, relayed by the service worker (see service-worker.ts).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === ACTION_TOGGLE) adapter.toggleFromAction();
});

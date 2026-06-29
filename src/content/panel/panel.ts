// The CrossChat panel UI (ARCHITECTURE.md §3, §7). Vanilla TS, no framework.
// Owns its DOM subtree; the adapter mounts/sizes it and feeds it data.
import "./panel.css";
import type { AuthState, ConnectionState, NormalizedMessage } from "../../shared/types";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  saveSettings,
  type ChatSettings,
} from "../settings";
import { renderMessage } from "./render";
import { buildSettingsView } from "./settings-view";

/** Keep the DOM bounded for long sessions (Phase 4 concern, cheap to do now). */
const MAX_MESSAGES = 250;

/** Outbound actions the panel forwards to the adapter (which owns the port). */
export interface PanelHandlers {
  onSend(text: string): void;
  onLogin(): void;
  onLogout(): void;
}

export class Panel {
  readonly root: HTMLElement;
  private header: HTMLElement;
  private statusIcon: HTMLElement;
  private status: HTMLElement;
  private actions: HTMLElement;
  private list: HTMLElement;
  private mapping: HTMLElement;
  private mappingInput: HTMLInputElement;
  private mappingButton: HTMLButtonElement;
  private composer: HTMLElement;
  private loginButton: HTMLButtonElement;
  private sendInput: HTMLInputElement;
  private sendButton: HTMLButtonElement;
  private sendAs: HTMLElement;
  private logoutButton: HTMLButtonElement;
  private sendError: HTMLElement;
  private emoteTip: HTMLElement;
  private emoteTipImg: HTMLImageElement;
  private emoteTipName: HTMLElement;
  private emoteTipProvider: HTMLElement;
  private tip: HTMLElement;
  private autoscroll = true;

  private settings: ChatSettings = { ...DEFAULT_SETTINGS };
  private systemDark = false;
  private unsubscribeSettings: (() => void) | null = null;
  private onDocClick: ((e: MouseEvent) => void) | null = null;

  constructor(private readonly handlers?: PanelHandlers) {
    this.root = document.createElement("div");
    this.root.className = "cc-root";

    // Header: connection status (left) + actions (right): the adapter's
    // enable/disable toggle, the change-channel button and the settings gear
    // sit side by side here. The status pairs an animated icon (spinner →
    // checkmark, driven purely by CSS off the banner's data-status) with text.
    this.header = document.createElement("div");
    this.header.className = "cc-banner";
    const statusGroup = document.createElement("div");
    statusGroup.className = "cc-status-group";
    this.statusIcon = document.createElement("span");
    this.statusIcon.className = "cc-status-icon";
    this.status = document.createElement("span");
    this.status.className = "cc-status";
    statusGroup.append(this.statusIcon, this.status);
    this.actions = document.createElement("div");
    this.actions.className = "cc-actions";
    this.header.append(statusGroup, this.actions);

    this.list = document.createElement("div");
    this.list.className = "cc-messages";

    this.mapping = document.createElement("div");
    this.mapping.className = "cc-mapping cc-hidden";
    const prompt = document.createElement("p");
    const row = document.createElement("div");
    row.className = "cc-mapping-row";
    this.mappingInput = document.createElement("input");
    this.mappingInput.placeholder = "twitch username";
    this.mappingInput.autocapitalize = "off";
    this.mappingInput.spellcheck = false;
    this.mappingButton = document.createElement("button");
    this.mappingButton.textContent = "Connect";
    row.append(this.mappingInput, this.mappingButton);
    this.mapping.append(prompt, row);

    // Composer: the opt-in send path. Hidden until we know the auth state. When
    // logged out it shows a single "Log in with Twitch" call-to-action; when
    // logged in it swaps to the message input + "Sending as <name>" footer. CSS
    // shows/hides the two halves off the `data-auth` attribute.
    this.composer = document.createElement("div");
    this.composer.className = "cc-composer cc-hidden";
    this.composer.dataset.auth = "out";

    this.loginButton = document.createElement("button");
    this.loginButton.className = "cc-login";
    this.loginButton.textContent = "Log in to Twitch to chat";
    this.loginButton.addEventListener("click", () => this.handlers?.onLogin());

    const sendRow = document.createElement("div");
    sendRow.className = "cc-send-row";
    this.sendInput = document.createElement("input");
    this.sendInput.className = "cc-send-input";
    this.sendInput.placeholder = "Send a message";
    this.sendInput.autocapitalize = "off";
    this.sendInput.maxLength = 500; // Twitch chat message cap
    this.sendButton = document.createElement("button");
    this.sendButton.className = "cc-send-btn";
    this.sendButton.textContent = "Chat";
    sendRow.append(this.sendInput, this.sendButton);

    this.sendError = document.createElement("div");
    this.sendError.className = "cc-send-error cc-hidden";

    const meta = document.createElement("div");
    meta.className = "cc-send-meta";
    this.sendAs = document.createElement("span");
    this.sendAs.className = "cc-send-as";
    this.logoutButton = document.createElement("button");
    this.logoutButton.className = "cc-logout";
    this.logoutButton.textContent = "Log out";
    this.logoutButton.addEventListener("click", () => this.handlers?.onLogout());
    meta.append(this.sendAs, this.logoutButton);

    this.composer.append(this.loginButton, sendRow, this.sendError, meta);

    const submitSend = () => {
      const text = this.sendInput.value.trim();
      if (!text) return;
      this.handlers?.onSend(text);
      this.sendButton.disabled = true; // re-enabled on send-result
    };
    this.sendButton.addEventListener("click", submitSend);
    this.sendInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitSend();
      }
    });

    // Emote hover card: a single shared preview (large emote + name + provider),
    // positioned on demand. pointer-events:none in CSS so it never steals hover.
    this.emoteTip = document.createElement("div");
    this.emoteTip.className = "cc-emote-tip cc-hidden";
    this.emoteTipImg = document.createElement("img");
    this.emoteTipName = document.createElement("span");
    this.emoteTipName.className = "cc-emote-tip-name";
    this.emoteTipProvider = document.createElement("span");
    this.emoteTipProvider.className = "cc-emote-tip-provider";
    this.emoteTip.append(this.emoteTipImg, this.emoteTipName, this.emoteTipProvider);

    // Shared instant tooltip for header icon buttons. We avoid the native
    // `title` (it's slow to appear and can't be themed); this mirrors the
    // emote hover card's approach — one repositioned node, pointer-events:none.
    this.tip = document.createElement("div");
    this.tip.className = "cc-tip cc-hidden";

    this.root.append(this.header, this.list, this.mapping, this.composer, this.emoteTip, this.tip);

    // Keep keystrokes typed into our inputs from bubbling to the page. YouTube
    // and other extensions bind global single-key shortcuts on document (e.g. a
    // theatre-mode extension toggling on "t"); without this, typing "t" in the
    // chat or settings inputs would fire them. One delegated handler covers every
    // input in the panel (send box, channel mapping, settings keyword field).
    for (const type of ["keydown", "keyup", "keypress"] as const) {
      this.root.addEventListener(type, (e) => {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") e.stopPropagation();
      });
    }

    // Delegated, zero-delay tooltips for any control with data-cc-tip (header
    // icon buttons and the settings rows alike).
    this.root.addEventListener("pointerover", (e) => {
      const t = (e.target as HTMLElement).closest("[data-cc-tip]") as HTMLElement | null;
      if (t) this.showTip(t);
    });
    this.root.addEventListener("pointerout", (e) => {
      const t = (e.target as HTMLElement).closest("[data-cc-tip]");
      if (!t) return;
      // Ignore moves that stay within the same target (e.g. label → its checkbox)
      // so the tooltip doesn't flicker.
      const related = e.relatedTarget as Node | null;
      if (related && t.contains(related)) return;
      this.hideTip();
    });

    this.list.addEventListener("scroll", () => {
      const nearBottom =
        this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
      this.autoscroll = nearBottom;
      this.hideEmoteTip(); // the hovered emote has moved out from under the cursor
    });

    // Delegated hover handling — one pair of listeners covers all emotes.
    this.list.addEventListener("pointerover", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("cc-emote")) this.showEmoteTip(t as HTMLImageElement);
    });
    this.list.addEventListener("pointerout", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("cc-emote")) this.hideEmoteTip();
    });

    this.applySettings(this.settings);
    this.setState({ status: "idle" });
  }

  /** Load persisted settings, mount the gear/popover, and sync across tabs. */
  async init(): Promise<void> {
    this.settings = await loadSettings();
    this.applySettings(this.settings);
    this.mountSettings();
    this.unsubscribeSettings = onSettingsChanged((next) => {
      this.settings = next;
      this.applySettings(next);
    });
  }

  /** Whether the OS prefers a dark scheme; feeds the "auto" theme choice. */
  setSystemDark(dark: boolean): void {
    this.systemDark = dark;
    this.applyTheme();
  }

  /** Mount an adapter-owned control into the header. Visual order is set by each
   *  control's CSS `order`, so insertion order here doesn't matter. */
  mountAction(el: HTMLElement): void {
    this.actions.appendChild(el);
  }

  setState(state: ConnectionState): void {
    this.header.dataset.status = state.status;
    this.status.textContent = describeState(state);
  }

  addMessage(msg: NormalizedMessage): void {
    this.list.appendChild(renderMessage(msg, this.settings));
    while (this.list.childElementCount > MAX_MESSAGES) {
      this.list.firstElementChild?.remove();
    }
    if (this.autoscroll) this.list.scrollTop = this.list.scrollHeight;
  }

  clearMessages(): void {
    this.list.replaceChildren();
    this.autoscroll = true;
  }

  // --- Composer / auth ----------------------------------------------------

  /** Reveal the composer and switch between the login CTA and the send input. */
  setAuth(auth: AuthState): void {
    this.composer.classList.remove("cc-hidden");
    this.composer.dataset.auth = auth.loggedIn ? "in" : "out";
    this.hideSendError();
    if (auth.loggedIn) {
      this.sendAs.textContent = `Sending as ${auth.displayName}`;
      this.sendButton.disabled = false;
    } else {
      this.sendInput.value = "";
    }
  }

  /** Apply the outcome of a send: clear on success, surface the error otherwise. */
  sendResult(ok: boolean, error?: string): void {
    this.sendButton.disabled = false;
    if (ok) {
      this.sendInput.value = "";
      this.hideSendError();
      this.sendInput.focus();
    } else {
      this.sendError.textContent = error || "Send failed";
      this.sendError.classList.remove("cc-hidden");
    }
  }

  private hideSendError(): void {
    this.sendError.textContent = "";
    this.sendError.classList.add("cc-hidden");
  }

  // --- Emote hover card ---------------------------------------------------

  /** Show the large preview for a hovered emote, positioned just above it. */
  private showEmoteTip(emote: HTMLImageElement): void {
    this.emoteTipImg.src = emote.currentSrc || emote.src;
    this.emoteTipName.textContent = emote.dataset.name ?? emote.alt;
    this.emoteTipProvider.textContent = (emote.dataset.provider ?? "").toUpperCase();

    // Reveal first so the card has measurable dimensions, then place it.
    this.emoteTip.classList.remove("cc-hidden");
    const rootRect = this.root.getBoundingClientRect();
    const r = emote.getBoundingClientRect();
    const tip = this.emoteTip.getBoundingClientRect();

    const centerX = r.left - rootRect.left + r.width / 2;
    const left = Math.max(4, Math.min(centerX - tip.width / 2, rootRect.width - tip.width - 4));
    let top = r.top - rootRect.top - tip.height - 6;
    if (top < 4) top = r.bottom - rootRect.top + 6; // flip below if no room above

    this.emoteTip.style.left = `${left}px`;
    this.emoteTip.style.top = `${top}px`;
  }

  private hideEmoteTip(): void {
    this.emoteTip.classList.add("cc-hidden");
  }

  // --- Icon-button tooltip -------------------------------------------------

  /**
   * Show the shared tooltip for a control, clamped to the panel. Header icon
   * buttons get a single-line tip below them; settings rows (inside the popover)
   * get a wrapping tip to the left of the popover, vertically centered on the
   * row — falling back to below if the left gutter is too narrow.
   */
  private showTip(target: HTMLElement): void {
    const text = target.getAttribute("data-cc-tip");
    if (!text) return;
    const inSettings = !!target.closest(".cc-settings");
    this.tip.textContent = text;
    this.tip.classList.toggle("cc-tip--wrap", inSettings);
    this.tip.classList.remove("cc-hidden");

    const rootRect = this.root.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const tip = this.tip.getBoundingClientRect();
    const x = r.left - rootRect.left;
    const y = r.top - rootRect.top;

    if (inSettings) {
      const left = x - tip.width - 8;
      if (left >= 4) {
        const top = Math.max(
          4,
          Math.min(y + r.height / 2 - tip.height / 2, rootRect.height - tip.height - 4),
        );
        this.tip.style.left = `${left}px`;
        this.tip.style.top = `${top}px`;
        return;
      }
      // Narrow panel: drop below the row instead.
    }

    const centerX = x + r.width / 2;
    const left = Math.max(4, Math.min(centerX - tip.width / 2, rootRect.width - tip.width - 4));
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${r.bottom - rootRect.top + 6}px`;
  }

  private hideTip(): void {
    this.tip.classList.add("cc-hidden");
  }

  // --- Settings -----------------------------------------------------------

  private mountSettings(): void {
    const { gearButton, popover } = buildSettingsView(this.settings, (patch) => {
      this.settings = { ...this.settings, ...patch };
      this.applySettings(this.settings);
      void saveSettings(this.settings);
    });
    this.actions.appendChild(gearButton);
    this.root.appendChild(popover);

    gearButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hideTip();
      popover.classList.toggle("cc-hidden");
    });
    // Close on outside click or Esc.
    this.onDocClick = (e) => {
      if (popover.classList.contains("cc-hidden")) return;
      const target = e.target as Node;
      // Use containment, not identity: the gear's click target is the inner
      // <svg>/<path>, so `target === gearButton` never holds — without this the
      // outside-click handler would close, then the gear's toggle re-open it.
      if (!popover.contains(target) && !gearButton.contains(target)) {
        popover.classList.add("cc-hidden");
      }
    };
    document.addEventListener("click", this.onDocClick, true);
    popover.addEventListener("click", (e) => e.stopPropagation());
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") popover.classList.add("cc-hidden");
    });
  }

  /** Write every appearance setting onto the root (CSS does the rest). */
  private applySettings(s: ChatSettings): void {
    this.root.dataset.timestamps = s.showTimestamps ? "1" : "0";
    this.root.dataset.altrows = s.alternatingRows ? "1" : "0";
    this.root.dataset.roles = s.showRoleBadges ? "1" : "0";
    this.root.style.setProperty("--cc-font-size", `${s.fontSize}px`);
    this.root.style.setProperty("--cc-emote-scale", String(s.emoteScale));
    this.applyTheme();
  }

  private applyTheme(): void {
    const dark =
      this.settings.theme === "dark" ||
      (this.settings.theme === "auto" && this.systemDark);
    this.root.dataset.theme = dark ? "dark" : "light";
  }

  /**
   * Show the "map this YouTube handle to a Twitch login" prompt. When
   * `currentLogin` is given the prompt is in "change channel" mode: the input is
   * prefilled with (and selects) the current login so it can be edited.
   */
  showMapping(
    youtubeHandle: string,
    onSubmit: (twitchLogin: string) => void,
    currentLogin?: string,
  ): void {
    const prompt = this.mapping.querySelector("p")!;
    prompt.textContent = currentLogin
      ? `Connected to Twitch channel for @${youtubeHandle}. Switch to another Twitch username:`
      : `No Twitch channel mapped for @${youtubeHandle}. Enter the Twitch username:`;
    this.mappingButton.textContent = currentLogin ? "Switch" : "Connect";
    this.mapping.classList.remove("cc-hidden");
    const submit = () => {
      const login = this.mappingInput.value.trim().toLowerCase();
      if (!login || login === currentLogin) return this.hideMapping();
      onSubmit(login);
      this.hideMapping();
    };
    this.mappingButton.onclick = submit;
    this.mappingInput.onkeydown = (e) => {
      if (e.key === "Enter") submit();
      else if (e.key === "Escape") this.hideMapping();
    };
    if (currentLogin) this.mappingInput.value = currentLogin;
    this.mappingInput.focus();
    this.mappingInput.select();
  }

  hideMapping(): void {
    this.mapping.classList.add("cc-hidden");
    this.mappingInput.value = "";
  }

  destroy(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    if (this.onDocClick) document.removeEventListener("click", this.onDocClick, true);
    this.onDocClick = null;
    this.root.remove();
  }
}

function describeState(state: ConnectionState): string {
  switch (state.status) {
    case "idle":
      return "CrossChat — idle";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "reconnecting":
      return `Reconnecting (attempt ${state.attempt})…`;
    case "disconnected":
      return "Disconnected";
    case "error":
      return `Error: ${state.message}`;
  }
}

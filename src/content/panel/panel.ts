// The CrossChat panel UI (ARCHITECTURE.md §3, §7). Vanilla TS, no framework.
// Owns its DOM subtree; the adapter mounts/sizes it and feeds it data.
import "./panel.css";
import type { ConnectionState, NormalizedMessage } from "../../shared/types";
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

export class Panel {
  readonly root: HTMLElement;
  private header: HTMLElement;
  private status: HTMLElement;
  private actions: HTMLElement;
  private list: HTMLElement;
  private mapping: HTMLElement;
  private mappingInput: HTMLInputElement;
  private mappingButton: HTMLButtonElement;
  private emoteTip: HTMLElement;
  private emoteTipImg: HTMLImageElement;
  private emoteTipName: HTMLElement;
  private emoteTipProvider: HTMLElement;
  private autoscroll = true;

  private settings: ChatSettings = { ...DEFAULT_SETTINGS };
  private systemDark = false;
  private unsubscribeSettings: (() => void) | null = null;
  private onDocClick: ((e: MouseEvent) => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "cc-root";

    // Header: connection status (left) + actions (right): the adapter's
    // enable/disable toggle and the settings gear sit side by side here.
    this.header = document.createElement("div");
    this.header.className = "cc-banner";
    this.status = document.createElement("span");
    this.status.className = "cc-status";
    this.actions = document.createElement("div");
    this.actions.className = "cc-actions";
    this.header.append(this.status, this.actions);

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

    this.root.append(this.header, this.list, this.mapping, this.emoteTip);

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

  /** Mount the adapter's enable/disable toggle into the header, left of the gear. */
  mountAction(el: HTMLElement): void {
    this.actions.insertBefore(el, this.actions.firstChild);
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
      popover.classList.toggle("cc-hidden");
    });
    // Close on outside click or Esc.
    this.onDocClick = (e) => {
      if (popover.classList.contains("cc-hidden")) return;
      const target = e.target as Node;
      if (!popover.contains(target) && target !== gearButton) {
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
    this.root.dataset.density = s.density;
    this.root.dataset.altrows = s.alternatingRows ? "1" : "0";
    this.root.dataset.roles = s.colorRoles ? "1" : "0";
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

  /** Show the "map this YouTube handle to a Twitch login" prompt. */
  showMapping(youtubeHandle: string, onSubmit: (twitchLogin: string) => void): void {
    const prompt = this.mapping.querySelector("p")!;
    prompt.textContent = `No Twitch channel mapped for @${youtubeHandle}. Enter the Twitch username:`;
    this.mapping.classList.remove("cc-hidden");
    const submit = () => {
      const login = this.mappingInput.value.trim().toLowerCase();
      if (!login) return;
      onSubmit(login);
      this.hideMapping();
    };
    this.mappingButton.onclick = submit;
    this.mappingInput.onkeydown = (e) => {
      if (e.key === "Enter") submit();
    };
    this.mappingInput.focus();
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

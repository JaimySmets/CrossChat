// The CrossChat panel UI (ARCHITECTURE.md §3, §7). Vanilla TS, no framework.
// Owns its DOM subtree; the adapter mounts/sizes it and feeds it data.
import "./panel.css";
import type { ConnectionState, NormalizedMessage } from "../../shared/types";
import { renderMessage } from "./render";

/** Keep the DOM bounded for long sessions (Phase 4 concern, cheap to do now). */
const MAX_MESSAGES = 250;

export class Panel {
  readonly root: HTMLElement;
  private banner: HTMLElement;
  private list: HTMLElement;
  private mapping: HTMLElement;
  private mappingInput: HTMLInputElement;
  private mappingButton: HTMLButtonElement;
  private autoscroll = true;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "cc-root";

    this.banner = document.createElement("div");
    this.banner.className = "cc-banner";

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

    this.root.append(this.banner, this.list, this.mapping);

    this.list.addEventListener("scroll", () => {
      const nearBottom =
        this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
      this.autoscroll = nearBottom;
    });

    this.setState({ status: "idle" });
  }

  setTheme(dark: boolean): void {
    this.root.dataset.theme = dark ? "dark" : "light";
  }

  setState(state: ConnectionState): void {
    this.banner.dataset.status = state.status;
    this.banner.textContent = describeState(state);
  }

  addMessage(msg: NormalizedMessage): void {
    this.list.appendChild(renderMessage(msg));
    while (this.list.childElementCount > MAX_MESSAGES) {
      this.list.firstElementChild?.remove();
    }
    if (this.autoscroll) this.list.scrollTop = this.list.scrollHeight;
  }

  clearMessages(): void {
    this.list.replaceChildren();
    this.autoscroll = true;
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

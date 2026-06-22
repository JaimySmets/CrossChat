// Pure DOM rendering for normalized messages (ARCHITECTURE.md §4.3).
// Operates only on NormalizedMessage — no platform-specific knowledge here.
import type { Fragment, NormalizedMessage } from "../../shared/types";
import type { ChatSettings } from "../settings";

/** Badge ids we surface as lightweight role chips, in chip-display order. */
const ROLE_LABELS: Record<string, string> = {
  broadcaster: "HOST",
  moderator: "MOD",
  vip: "VIP",
  subscriber: "SUB",
};

function renderFragments(fragments: Fragment[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const part of fragments) {
    if (part.type === "text") {
      frag.appendChild(document.createTextNode(part.value));
    } else {
      const img = document.createElement("img");
      img.className = "cc-emote";
      img.src = part.url;
      img.alt = part.name;
      // No native `title`: the panel shows a richer hover card (name + preview)
      // keyed off these data attributes.
      img.dataset.name = part.name;
      img.dataset.provider = part.provider;
      img.loading = "lazy";
      frag.appendChild(img);
    }
  }
  return frag;
}

/** Concatenated text content of a message, lowercased, for keyword matching. */
function messageText(msg: NormalizedMessage): string {
  let out = "";
  for (const part of msg.fragments) if (part.type === "text") out += part.value;
  return out.toLowerCase();
}

function matchesKeyword(text: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (!k) continue;
    const re = new RegExp(`(?:^|\\W)${escapeRegExp(k)}(?:$|\\W)`);
    if (re.test(text)) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Build one chat-line element for a normalized message. */
export function renderMessage(msg: NormalizedMessage, settings: ChatSettings): HTMLElement {
  const line = document.createElement("div");
  line.className = "cc-msg";
  line.dataset.id = msg.id;

  if (settings.highlightKeywords.length && matchesKeyword(messageText(msg), settings.highlightKeywords)) {
    line.classList.add("cc-msg--highlight");
  }

  // Timestamp — always rendered; CSS hides it when timestamps are off.
  const time = document.createElement("span");
  time.className = "cc-time";
  time.textContent = formatTime(msg.timestamp);
  line.appendChild(time);

  // Badges: prefer real artwork when the registry resolved a URL, otherwise fall
  // back to a lightweight CSS role chip (no image fetch). Subscribers surface
  // their cumulative months (from badge-info) in the tooltip either way.
  for (const badge of msg.author.badges) {
    const tooltip =
      badge.id === "subscriber" && badge.count
        ? `Subscribed for ${badge.count} ${badge.count === 1 ? "month" : "months"}`
        : (badge.title ?? badge.id);

    if (badge.url) {
      const img = document.createElement("img");
      img.className = "cc-badge";
      img.src = badge.url;
      img.alt = tooltip;
      img.title = tooltip;
      line.appendChild(img);
      continue;
    }

    const label = ROLE_LABELS[badge.id];
    if (!label) continue;
    const chip = document.createElement("span");
    chip.className = "cc-chip";
    chip.dataset.role = badge.id;
    chip.textContent = label;
    chip.title = tooltip;
    line.appendChild(chip);
  }

  const name = document.createElement("span");
  name.className = "cc-name";
  name.textContent = msg.author.displayName;
  if (msg.author.color) name.style.color = msg.author.color;
  line.appendChild(name);

  line.appendChild(document.createTextNode(": "));

  const body = document.createElement("span");
  body.className = "cc-body";
  body.appendChild(renderFragments(msg.fragments));
  line.appendChild(body);

  return line;
}

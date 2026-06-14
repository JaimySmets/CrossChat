// Pure DOM rendering for normalized messages (ARCHITECTURE.md §4.3).
// Operates only on NormalizedMessage — no platform-specific knowledge here.
import type { Fragment, NormalizedMessage } from "../../shared/types";

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
      img.title = part.name;
      img.loading = "lazy";
      img.dataset.provider = part.provider;
      frag.appendChild(img);
    }
  }
  return frag;
}

/** Build one chat-line element for a normalized message. */
export function renderMessage(msg: NormalizedMessage): HTMLElement {
  const line = document.createElement("div");
  line.className = "cc-msg";
  line.dataset.id = msg.id;

  for (const badge of msg.author.badges) {
    if (!badge.url) continue;
    const b = document.createElement("img");
    b.className = "cc-badge";
    b.src = badge.url;
    b.alt = badge.title ?? badge.id;
    b.title = badge.title ?? badge.id;
    line.appendChild(b);
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

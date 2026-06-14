// Apply pass (ARCHITECTURE.md §5). Second pass over text fragments: tokenize on
// whitespace and replace tokens that EXACTLY (case-sensitive, whole-word) match
// a registry key with emote fragments. Native-emote fragments pass through.
import type { Fragment, NormalizedMessage } from "../../shared/types";
import type { EmoteRegistry } from "./registry";

export function applyRegistry(msg: NormalizedMessage, registry: EmoteRegistry): NormalizedMessage {
  const out: Fragment[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.type === "text") last.value += s;
    else out.push({ type: "text", value: s });
  };

  for (const frag of msg.fragments) {
    if (frag.type !== "text") {
      out.push(frag);
      continue;
    }
    // Split keeping whitespace so spacing is preserved exactly.
    for (const token of frag.value.split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        pushText(token);
        continue;
      }
      const hit = registry.lookup(token);
      if (hit) out.push({ type: "emote", name: token, url: hit.url, provider: hit.provider });
      else pushText(token);
    }
  }

  return { ...msg, fragments: out };
}

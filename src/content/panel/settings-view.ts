// The gear button + settings popover DOM. Pure vanilla DOM, no persistence:
// each control reports a partial patch via `onChange`; the Panel persists and
// applies. Keeps panel.ts lean.
import type { ChatSettings } from "../settings";

export interface SettingsView {
  /** The ⚙ button, mounted in the panel header. */
  gearButton: HTMLButtonElement;
  /** The floating settings card, mounted in the panel root. Hidden by default. */
  popover: HTMLElement;
}

type OnChange = (patch: Partial<ChatSettings>) => void;

/** Build a labelled row wrapping a control, with an optional hover tooltip. */
function row(labelText: string, control: HTMLElement, tip?: string): HTMLElement {
  const r = document.createElement("label");
  r.className = "cc-set-row";
  if (tip) r.dataset.ccTip = tip;
  const span = document.createElement("span");
  span.className = "cc-set-label";
  span.textContent = labelText;
  r.append(span, control);
  return r;
}

/** Material "settings" gear, sized via CSS (width/height on the svg). */
const GEAR_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>';

export function buildSettingsView(initial: ChatSettings, onChange: OnChange): SettingsView {
  const gearButton = document.createElement("button");
  gearButton.className = "cc-gear";
  gearButton.dataset.ccTip = "Chat settings";
  gearButton.setAttribute("aria-label", "Chat settings");
  gearButton.style.order = "3";
  gearButton.innerHTML = GEAR_SVG;

  const popover = document.createElement("div");
  popover.className = "cc-settings cc-hidden";

  // Timestamps -------------------------------------------------------------
  const timestamps = document.createElement("input");
  timestamps.type = "checkbox";
  timestamps.checked = initial.showTimestamps;
  timestamps.addEventListener("change", () =>
    onChange({ showTimestamps: timestamps.checked }),
  );

  // Time format ------------------------------------------------------------
  const clock = document.createElement("select");
  for (const [value, label] of [
    ["auto", "Auto"],
    ["24h", "24-hour"],
    ["12h", "12-hour"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    clock.appendChild(opt);
  }
  clock.value = initial.clock;
  clock.addEventListener("change", () =>
    onChange({ clock: clock.value as ChatSettings["clock"] }),
  );

  // Theme ------------------------------------------------------------------
  const theme = document.createElement("select");
  for (const [value, label] of [
    ["auto", "Auto"],
    ["light", "Light"],
    ["dark", "Dark"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    theme.appendChild(opt);
  }
  theme.value = initial.theme;
  theme.addEventListener("change", () =>
    onChange({ theme: theme.value as ChatSettings["theme"] }),
  );

  // Font size --------------------------------------------------------------
  const fontSize = document.createElement("input");
  fontSize.type = "range";
  fontSize.min = "11";
  fontSize.max = "20";
  fontSize.step = "1";
  fontSize.value = String(initial.fontSize);
  const fontValue = document.createElement("span");
  fontValue.className = "cc-set-value";
  fontValue.textContent = `${initial.fontSize}px`;
  fontSize.addEventListener("input", () => {
    const px = Number(fontSize.value);
    fontValue.textContent = `${px}px`;
    onChange({ fontSize: px });
  });
  // Value sits left of the slider so the slider right-aligns with the other
  // right-side controls (the keyword input, selects).
  const fontWrap = document.createElement("div");
  fontWrap.className = "cc-set-inline";
  fontWrap.append(fontValue, fontSize);

  // Emote size -------------------------------------------------------------
  const emote = document.createElement("select");
  for (const [value, label] of [
    ["1", "Small"],
    ["1.25", "Medium"],
    ["1.5", "Large"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    emote.appendChild(opt);
  }
  emote.value = String(initial.emoteScale);
  emote.addEventListener("change", () => onChange({ emoteScale: Number(emote.value) }));

  // Alternating rows -------------------------------------------------------
  const altRows = document.createElement("input");
  altRows.type = "checkbox";
  altRows.checked = initial.alternatingRows;
  altRows.addEventListener("change", () =>
    onChange({ alternatingRows: altRows.checked }),
  );

  // Role badges ------------------------------------------------------------
  const roleBadges = document.createElement("input");
  roleBadges.type = "checkbox";
  roleBadges.checked = initial.showRoleBadges;
  roleBadges.addEventListener("change", () =>
    onChange({ showRoleBadges: roleBadges.checked }),
  );

  // Highlight keywords -----------------------------------------------------
  const keywords = document.createElement("input");
  keywords.type = "text";
  keywords.placeholder = "comma,separated";
  keywords.autocapitalize = "off";
  keywords.spellcheck = false;
  keywords.value = initial.highlightKeywords.join(", ");
  const commitKeywords = () =>
    onChange({
      highlightKeywords: keywords.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  keywords.addEventListener("change", commitKeywords);
  keywords.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitKeywords();
  });

  const title = document.createElement("div");
  title.className = "cc-set-title";
  title.textContent = "Chat settings";

  popover.append(
    title,
    row("Show timestamps", timestamps, "Show the time each message was sent."),
    row(
      "Time format",
      clock,
      "12- or 24-hour clock for timestamps. Auto follows your browser's locale.",
    ),
    row("Theme", theme, "Light, dark, or match your system theme."),
    row("Font size", fontWrap, "Text size for chat messages."),
    row("Emote size", emote, "Display size of emotes within messages."),
    row(
      "Alternating rows",
      altRows,
      "Tint every other message with a faint background for readability.",
    ),
    row(
      "Show role badges",
      roleBadges,
      "Show moderator / VIP / subscriber / broadcaster badges next to usernames.",
    ),
    row(
      "Highlight words",
      keywords,
      "Highlight any message containing one of these comma-separated words.",
    ),
  );

  return { gearButton, popover };
}

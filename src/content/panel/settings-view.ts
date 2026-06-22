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

/** Build a labelled row wrapping a control. */
function row(labelText: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("label");
  r.className = "cc-set-row";
  const span = document.createElement("span");
  span.className = "cc-set-label";
  span.textContent = labelText;
  r.append(span, control);
  return r;
}

export function buildSettingsView(initial: ChatSettings, onChange: OnChange): SettingsView {
  const gearButton = document.createElement("button");
  gearButton.className = "cc-gear";
  gearButton.title = "Chat settings";
  gearButton.setAttribute("aria-label", "Chat settings");
  gearButton.textContent = "⚙";

  const popover = document.createElement("div");
  popover.className = "cc-settings cc-hidden";

  // Timestamps -------------------------------------------------------------
  const timestamps = document.createElement("input");
  timestamps.type = "checkbox";
  timestamps.checked = initial.showTimestamps;
  timestamps.addEventListener("change", () =>
    onChange({ showTimestamps: timestamps.checked }),
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
  const fontWrap = document.createElement("div");
  fontWrap.className = "cc-set-inline";
  fontWrap.append(fontSize, fontValue);

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

  // Density (compact) ------------------------------------------------------
  const compact = document.createElement("input");
  compact.type = "checkbox";
  compact.checked = initial.density === "compact";
  compact.addEventListener("change", () =>
    onChange({ density: compact.checked ? "compact" : "cozy" }),
  );

  // Alternating rows -------------------------------------------------------
  const altRows = document.createElement("input");
  altRows.type = "checkbox";
  altRows.checked = initial.alternatingRows;
  altRows.addEventListener("change", () =>
    onChange({ alternatingRows: altRows.checked }),
  );

  // Color roles ------------------------------------------------------------
  const colorRoles = document.createElement("input");
  colorRoles.type = "checkbox";
  colorRoles.checked = initial.colorRoles;
  colorRoles.addEventListener("change", () =>
    onChange({ colorRoles: colorRoles.checked }),
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
    row("Show timestamps", timestamps),
    row("Theme", theme),
    row("Font size", fontWrap),
    row("Emote size", emote),
    row("Compact mode", compact),
    row("Alternating rows", altRows),
    row("Color roles", colorRoles),
    row("Highlight words", keywords),
  );

  return { gearButton, popover };
}

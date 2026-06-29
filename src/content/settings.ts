// Global, persisted appearance settings for the CrossChat panel.
// Content-script side only — uses chrome.storage.local (the `storage` permission
// is declared in manifest.json). Settings are global: one set for every channel.

export type ThemeChoice = "auto" | "light" | "dark";
/** Timestamp clock: "auto" follows the browser locale; the others force it. */
export type ClockFormat = "auto" | "12h" | "24h";

export interface ChatSettings {
  showTimestamps: boolean;
  /** 12/24-hour timestamps. "auto" derives from the browser locale. */
  clock: ClockFormat;
  theme: ThemeChoice;
  /** Base font size in px for the message list. */
  fontSize: number;
  /** Emote height multiplier applied to the 28px base. */
  emoteScale: number;
  alternatingRows: boolean;
  /** Show role badges (mod/vip/sub/broadcaster) — real artwork or fallback chips. */
  showRoleBadges: boolean;
  /** Case-insensitive whole-word terms that highlight a message line. */
  highlightKeywords: string[];
}

export const DEFAULT_SETTINGS: ChatSettings = {
  showTimestamps: true,
  clock: "auto",
  theme: "auto",
  fontSize: 13,
  emoteScale: 1,
  alternatingRows: false,
  showRoleBadges: true,
  highlightKeywords: [],
};

const STORAGE_KEY = "crosschat:settings";

/** Load settings merged over defaults (forward-compatible with missing keys). */
export async function loadSettings(): Promise<ChatSettings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw = stored[STORAGE_KEY] as Partial<ChatSettings> | undefined;
    return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: ChatSettings): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  } catch {
    // best-effort; nothing to recover if storage is unavailable
  }
}

/**
 * Subscribe to settings changes from other tabs/panels. Returns an unsubscribe
 * function. Fires only when the stored settings object actually changes.
 */
export function onSettingsChanged(cb: (settings: ChatSettings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || !(STORAGE_KEY in changes)) return;
    const next = changes[STORAGE_KEY].newValue as Partial<ChatSettings> | undefined;
    if (next) cb({ ...DEFAULT_SETTINGS, ...next });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

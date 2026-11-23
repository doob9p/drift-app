/**
 * Single source of truth for Drift keyboard shortcuts shown in the Help panel.
 * Menu accelerators and tooltips should stay aligned with these chords.
 */

export type ShortcutCategory =
  | "general"
  | "shell"
  | "board"
  | "view"
  | "gestures";

export type ShortcutDef = {
  id: string;
  category: ShortcutCategory;
  /** i18n key for the action label */
  labelKey: string;
  /** Display chord on macOS (⌘ ⌥ ⇧) */
  mac: string;
  /** Display chord on Windows/Linux (Ctrl Alt Shift) */
  win: string;
};

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  "general",
  "shell",
  "board",
  "view",
  "gestures",
];

export const SHORTCUTS: ShortcutDef[] = [
  // General
  {
    id: "settings",
    category: "general",
    labelKey: "shortcuts.settings",
    mac: "⌘,",
    win: "Ctrl+,",
  },
  {
    id: "keyboard-shortcuts",
    category: "general",
    labelKey: "shortcuts.openPanel",
    mac: "⌘⇧/",
    win: "Ctrl+Shift+/",
  },
  {
    id: "toggle-nav",
    category: "general",
    labelKey: "shortcuts.toggleNav",
    mac: "⌘B",
    win: "Ctrl+B",
  },
  {
    id: "find",
    category: "general",
    labelKey: "shortcuts.find",
    mac: "⌘F",
    win: "Ctrl+F",
  },
  {
    id: "save",
    category: "general",
    labelKey: "shortcuts.save",
    mac: "⌘S",
    win: "Ctrl+S",
  },
  {
    id: "close-tab",
    category: "general",
    labelKey: "shortcuts.closeTab",
    mac: "⌘W",
    win: "Ctrl+W",
  },

  // Shell
  {
    id: "new-local",
    category: "shell",
    labelKey: "shortcuts.newLocal",
    mac: "⌘T",
    win: "Ctrl+T",
  },
  {
    id: "clear",
    category: "shell",
    labelKey: "shortcuts.clear",
    mac: "⌘K",
    win: "Ctrl+K",
  },
  {
    id: "prev-tab",
    category: "shell",
    labelKey: "shortcuts.prevTab",
    mac: "⌘⇧[",
    win: "Ctrl+Shift+[",
  },
  {
    id: "next-tab",
    category: "shell",
    labelKey: "shortcuts.nextTab",
    mac: "⌘⇧]",
    win: "Ctrl+Shift+]",
  },
  {
    id: "focus-tab",
    category: "shell",
    labelKey: "shortcuts.focusTab",
    mac: "⌘1 … ⌘9",
    win: "Ctrl+1 … Ctrl+9",
  },

  // Board
  {
    id: "arrange-cards",
    category: "board",
    labelKey: "shortcuts.arrange",
    mac: "⌥⌘A",
    win: "Ctrl+Shift+A",
  },
  {
    id: "tile-fill",
    category: "board",
    labelKey: "shortcuts.tileFill",
    mac: "⌥⌘S",
    win: "Ctrl+Shift+E",
  },
  {
    id: "tile-fit",
    category: "board",
    labelKey: "shortcuts.tileFit",
    mac: "⌥⌘F",
    win: "Ctrl+Shift+G",
  },
  {
    id: "broadcast",
    category: "board",
    labelKey: "shortcuts.broadcast",
    mac: "⌥⌘B",
    win: "Ctrl+Shift+B",
  },
  {
    id: "focus-neighbor",
    category: "board",
    labelKey: "shortcuts.focusNeighbor",
    mac: "⌥⌘←↑→↓",
    win: "Ctrl+Shift+←↑→↓",
  },

  // View
  {
    id: "zoom-reset",
    category: "view",
    labelKey: "shortcuts.zoomReset",
    mac: "⌘0",
    win: "Ctrl+0",
  },
  {
    id: "zoom-in",
    category: "view",
    labelKey: "shortcuts.zoomIn",
    mac: "⌘=",
    win: "Ctrl+=",
  },
  {
    id: "zoom-out",
    category: "view",
    labelKey: "shortcuts.zoomOut",
    mac: "⌘-",
    win: "Ctrl+-",
  },
  {
    id: "toggle-comment",
    category: "view",
    labelKey: "shortcuts.toggleComment",
    mac: "⌘/",
    win: "Ctrl+/",
  },

  // Gestures (board / themes)
  {
    id: "pan-space",
    category: "gestures",
    labelKey: "shortcuts.panSpace",
    mac: "Space + drag",
    win: "Space + drag",
  },
  {
    id: "snow-option",
    category: "gestures",
    labelKey: "shortcuts.snowOption",
    mac: "⌥ + move",
    win: "Alt + move",
  },
  {
    id: "rain-umbrella",
    category: "gestures",
    labelKey: "shortcuts.rainUmbrella",
    mac: "⌥ hold",
    win: "Alt hold",
  },
];

type PlatformSource = { platform?: string };

function readAppPlatform(): string | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { cursorTerm?: PlatformSource }).cursorTerm;
  return api?.platform ?? null;
}

export function isMacPlatform(): boolean {
  const platform = readAppPlatform();
  if (platform) return platform === "darwin";
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(
    navigator.platform || navigator.userAgent
  );
}

export function chordFor(def: ShortcutDef, mac = isMacPlatform()): string {
  return mac ? def.mac : def.win;
}

export function shortcutById(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Append the platform chord, e.g. "Arrange (⌘⌥A)" / "Arrange (Ctrl+Shift+A)". */
export function labelWithChord(label: string, shortcutId: string): string {
  const def = shortcutById(shortcutId);
  if (!def) return label;
  return `${label} (${chordFor(def)})`;
}

/** Board layout / neighbor modifier: ⌥⌘ on mac, Ctrl+Shift on Windows/Linux. */
export function isBoardChordEvent(e: {
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (isMacPlatform()) {
    return e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey;
  }
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;
}

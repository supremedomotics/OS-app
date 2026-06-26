/**
 * Aureon theming (§11.2 Themes) — the small runtime that drives Light/Dark/Auto base
 * palettes (Luxury Black / Luxury White) and accent colours (Gold / Silver) across the
 * web clients. The actual colour values live in CSS under `[data-theme]` / `[data-accent]`
 * selectors (so theming is a pure repaint with no re-render); this module just resolves
 * the choice, reflects it onto the document, persists it, and tracks the OS theme for
 * "auto". DOM/storage are injected so it's testable headlessly — and the package stays
 * DOM-lib-free (it's the shared token mirror) by typing the globals it touches locally.
 */
export type AureonMode = "dark" | "light" | "auto";
export type AureonAccent = "gold" | "silver";

export interface AureonThemeChoice {
  mode: AureonMode;
  accent: AureonAccent;
}

/** The themes offered in settings, with labels — drives the theme picker UI. */
export const AUREON_MODES: ReadonlyArray<{ key: AureonMode; label: string }> = [
  { key: "dark", label: "Luxury Black" },
  { key: "light", label: "Luxury White" },
  { key: "auto", label: "Automatic" },
];
export const AUREON_ACCENTS: ReadonlyArray<{ key: AureonAccent; label: string; swatch: string }> = [
  { key: "gold", label: "Gold", swatch: "#E3BE6A" },
  { key: "silver", label: "Silver", swatch: "#C8CDD6" },
];

// Minimal structural types so we don't pull in the DOM lib.
interface MediaQueryLike {
  matches: boolean;
  addEventListener?(type: "change", cb: () => void): void;
}
export interface MatchMediaLike {
  matchMedia(query: string): MediaQueryLike;
}
interface RootLike {
  dataset: Record<string, string>;
}
interface MiniStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
const g = globalThis as unknown as {
  document?: { documentElement: RootLike };
  localStorage?: MiniStorage;
  matchMedia?: (q: string) => MediaQueryLike;
};

const STORAGE_KEY = "aureon.theme";
const DEFAULT: AureonThemeChoice = { mode: "dark", accent: "gold" };

function prefersDark(win: MatchMediaLike | undefined): boolean {
  try {
    const mm = win?.matchMedia ?? g.matchMedia;
    return mm ? mm("(prefers-color-scheme: dark)").matches : true;
  } catch {
    return true;
  }
}

/** Resolve "auto" to a concrete base palette using the OS preference. */
export function resolveMode(mode: AureonMode, win?: MatchMediaLike): "dark" | "light" {
  if (mode === "auto") return prefersDark(win) ? "dark" : "light";
  return mode;
}

/** Reflect a theme choice onto the document root as `data-theme` + `data-accent`. */
export function applyAureonTheme(choice: AureonThemeChoice, root?: RootLike, win?: MatchMediaLike): void {
  const el = root ?? g.document?.documentElement;
  if (!el) return;
  el.dataset.theme = resolveMode(choice.mode, win);
  el.dataset.accent = choice.accent;
}

function storageOf(s?: MiniStorage): MiniStorage | undefined {
  if (s) return s;
  try {
    return g.localStorage;
  } catch {
    return undefined;
  }
}

export function loadAureonTheme(storage?: MiniStorage): AureonThemeChoice {
  const store = storageOf(storage);
  try {
    const raw = store?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<AureonThemeChoice>;
    return {
      mode: parsed.mode === "light" || parsed.mode === "auto" ? parsed.mode : "dark",
      accent: parsed.accent === "silver" ? "silver" : "gold",
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveAureonTheme(choice: AureonThemeChoice, storage?: MiniStorage): void {
  try {
    storageOf(storage)?.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    /* storage unavailable — theme simply won't persist */
  }
}

/** Load the saved choice, apply it, and start tracking OS theme changes for "auto". */
export function initAureonTheme(): AureonThemeChoice {
  const choice = loadAureonTheme();
  applyAureonTheme(choice);
  try {
    if (choice.mode === "auto") {
      g.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () =>
        applyAureonTheme(loadAureonTheme()),
      );
    }
  } catch {
    /* no matchMedia — auto falls back to dark */
  }
  return choice;
}

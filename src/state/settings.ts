import type { ParameterValue, PerformanceMode } from "../engine/types";

export type { PerformanceMode } from "../engine/types";

/**
 * Persisted gallery settings: which scene is active and the per-scene parameter
 * overrides. Stored in `localStorage` (available in the Tauri webview and any
 * browser) so choices survive restarts with zero native dependencies.
 */

const STORAGE_KEY = "aurora.settings.v1";

/** How the time/date overlay is drawn on top of the active scene. */
export type ClockMode = "off" | "time" | "datetime";

/** App-wide preferences (not per-scene): slideshow + overlays. */
export interface AuroraPrefs {
  /** Auto-advance through scenes on a timer (Aerial-style slideshow). */
  shuffle: boolean;
  /** Seconds each scene is shown before advancing in shuffle mode. */
  shuffleSeconds: number;
  /** Randomize order in shuffle mode (vs. sequential gallery order). */
  shuffleRandom: boolean;
  /** Clock overlay mode. */
  clock: ClockMode;
  /** Scene ids the user has starred; powers a "favorites only" shuffle. */
  favorites: string[];
  /** When true, shuffle only cycles through favorited scenes. */
  shuffleFavoritesOnly: boolean;
  /** GPU render-cost profile (adaptive by default). Mirrors the native saver. */
  performance: PerformanceMode;
}

export const DEFAULT_PREFS: AuroraPrefs = {
  shuffle: false,
  shuffleSeconds: 30,
  shuffleRandom: true,
  clock: "off",
  favorites: [],
  shuffleFavoritesOnly: false,
  performance: "auto",
};

export interface PersistedSettings {
  activeSceneId: string | null;
  /** sceneId → { paramId → value }. Only overridden params are stored. */
  params: Record<string, Record<string, ParameterValue>>;
  /** App-wide preferences. */
  prefs: AuroraPrefs;
}

const EMPTY: PersistedSettings = { activeSceneId: null, params: {}, prefs: { ...DEFAULT_PREFS } };

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadSettings(): PersistedSettings {
  const store = safeStorage();
  if (!store) return structuredCloneSafe(EMPTY);
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return structuredCloneSafe(EMPTY);
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return {
      activeSceneId: parsed.activeSceneId ?? null,
      params: parsed.params ?? {},
      // Merge over defaults so new prefs added in later versions get sane values.
      prefs: { ...DEFAULT_PREFS, ...(parsed.prefs ?? {}) },
    };
  } catch {
    return structuredCloneSafe(EMPTY);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Persist settings, debounced so dragging a slider doesn't thrash storage. */
export function saveSettings(settings: PersistedSettings, debounceMs = 250): void {
  const store = safeStorage();
  if (!store) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage full / unavailable — non-fatal for a screensaver */
    }
  }, debounceMs);
}

function structuredCloneSafe(v: PersistedSettings): PersistedSettings {
  return { activeSceneId: v.activeSceneId, params: { ...v.params }, prefs: { ...v.prefs } };
}

import { describe, expect, it, beforeEach } from "bun:test";
import { loadSettings, saveSettings, DEFAULT_PREFS, type PersistedSettings } from "./settings";

/**
 * Minimal in-memory localStorage so the persistence layer can be exercised in
 * the test runner (which has no DOM). Mirrors the subset settings.ts uses.
 */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
  raw() {
    return this.store;
  }
}

const STORAGE_KEY = "aurora.settings.v1";

describe("settings persistence", () => {
  let mem: MemoryStorage;

  beforeEach(() => {
    mem = new MemoryStorage();
    (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = mem;
  });

  it("returns default prefs when storage is empty", () => {
    const s = loadSettings();
    expect(s.prefs).toEqual(DEFAULT_PREFS);
    expect(s.activeSceneId).toBeNull();
    expect(s.params).toEqual({});
  });

  it("backfills missing prefs from a legacy (pre-prefs) blob", () => {
    // Simulate an old persisted payload that predates the prefs block.
    mem.setItem(STORAGE_KEY, JSON.stringify({ activeSceneId: "plasma", params: {} }));
    const s = loadSettings();
    expect(s.activeSceneId).toBe("plasma");
    expect(s.prefs).toEqual(DEFAULT_PREFS);
  });

  it("round-trips prefs through save → load", () => {
    const settings: PersistedSettings = {
      activeSceneId: "black-hole",
      params: { "black-hole": { speed: 0.8 } },
      prefs: { ...DEFAULT_PREFS, shuffle: true, shuffleSeconds: 45, favorites: ["plasma", "fireflies"] },
    };
    saveSettings(settings, 0); // no debounce in tests
    // Debounced writer uses setTimeout(0); flush the microtask/macrotask queue.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const loaded = loadSettings();
        expect(loaded.prefs.shuffle).toBe(true);
        expect(loaded.prefs.shuffleSeconds).toBe(45);
        expect(loaded.prefs.favorites).toEqual(["plasma", "fireflies"]);
        expect(loaded.params["black-hole"]?.speed).toBe(0.8);
        resolve();
      }, 5);
    });
  });
});

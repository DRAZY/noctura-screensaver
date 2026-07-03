import { useCallback, useEffect, useRef, useState } from "react";
import { SceneManager } from "./engine/SceneManager";
import { defaultsFor, type ParameterValue, type Parameter, type Scene } from "./engine/types";
import { registerAllScenes } from "./scenes";
import { watchPowerSource } from "./power/powerSource";
import { SettingsPanel } from "./ui/SettingsPanel";
import { ClockOverlay } from "./ui/ClockOverlay";
import {
  loadSettings,
  saveSettings,
  DEFAULT_PREFS,
  type AuroraPrefs,
  type PersistedSettings,
} from "./state/settings";
import "./styles.css";
import "./ui/settings.css";

/**
 * Close the host OS window so the screensaver dismisses. Tauri-only — in a
 * plain browser there is no native window, so it resolves to a console hint.
 */
async function dismissWindow(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    console.info("[aurora] exit requested (no native window outside Tauri)");
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/**
 * Root shell. Hosts the WebGL canvas driven by the {@link SceneManager} and the
 * slide-in gallery/settings panel. The canvas always renders full-screen; the
 * panel (toggled by the gear button or `S`) floats above it as a live preview.
 *
 * Keys: `S` gallery · `N`/`P` next/prev scene · `Esc` close panel, else quit.
 */
function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const settingsRef = useRef<PersistedSettings>({
    activeSceneId: null,
    params: {},
    prefs: { ...DEFAULT_PREFS },
  });

  // Refs mirror state so the once-installed keydown handler never reads stale values.
  const activeIdRef = useRef<string | null>(null);
  const panelOpenRef = useRef(false);
  const prefsRef = useRef<AuroraPrefs>({ ...DEFAULT_PREFS });

  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [parameters, setParameters] = useState<ReadonlyArray<Parameter>>([]);
  const [values, setValues] = useState<Record<string, ParameterValue>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [prefs, setPrefs] = useState<AuroraPrefs>({ ...DEFAULT_PREFS });
  const [fps, setFps] = useState(0);

  /** Effective values for a scene = its defaults overlaid with persisted overrides. */
  const effectiveValues = useCallback((scene: Scene): Record<string, ParameterValue> => {
    return { ...defaultsFor(scene), ...(settingsRef.current.params[scene.id] ?? {}) };
  }, []);

  /** Activate a scene, push its parameter values into it, and sync UI + storage. */
  const applyScene = useCallback(
    (id: string, immediate = false) => {
      const mgr = managerRef.current;
      if (!mgr) return;
      const scene = mgr.list().find((s) => s.id === id);
      if (!scene) return;

      mgr.setActive(id, { immediate });
      const v = effectiveValues(scene);
      for (const [pid, val] of Object.entries(v)) mgr.setParameter(pid, val);

      activeIdRef.current = id;
      setActiveId(id);
      setParameters(scene.parameters);
      setValues(v);
      settingsRef.current.activeSceneId = id;
      saveSettings(settingsRef.current);
    },
    [effectiveValues],
  );

  const cycleScene = useCallback(
    (dir: 1 | -1) => {
      const mgr = managerRef.current;
      if (!mgr) return;
      const list = mgr.list();
      if (list.length < 2) return;
      const idx = list.findIndex((s) => s.id === activeIdRef.current);
      const next = list[(idx + dir + list.length) % list.length];
      applyScene(next.id);
    },
    [applyScene],
  );

  /** Advance to the next scene for the slideshow — honors random + favorites-only. */
  const advanceShuffle = useCallback(() => {
    const mgr = managerRef.current;
    if (!mgr) return;
    const all = mgr.list();
    const p = prefsRef.current;
    const pool =
      p.shuffleFavoritesOnly && p.favorites.length > 0
        ? all.filter((s) => p.favorites.includes(s.id))
        : all;
    if (pool.length === 0) return;
    if (pool.length === 1) {
      applyScene(pool[0].id);
      return;
    }
    const curIdx = pool.findIndex((s) => s.id === activeIdRef.current);
    let next: Scene;
    if (p.shuffleRandom) {
      // Pick a different scene than the current one.
      let r = Math.floor(Math.random() * pool.length);
      if (r === curIdx) r = (r + 1) % pool.length;
      next = pool[r];
    } else {
      next = pool[(curIdx + 1 + pool.length) % pool.length];
    }
    applyScene(next.id);
  }, [applyScene]);

  /** Merge a prefs patch, persist it, and mirror into state + ref. */
  const onChangePrefs = useCallback((patch: Partial<AuroraPrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefs(next);
    settingsRef.current.prefs = next;
    saveSettings(settingsRef.current);
  }, []);

  const onToggleFavorite = useCallback(
    (id: string) => {
      const cur = prefsRef.current.favorites;
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      onChangePrefs({ favorites: next });
    },
    [onChangePrefs],
  );

  const onChangeParam = useCallback((pid: string, val: ParameterValue) => {
    const mgr = managerRef.current;
    const id = activeIdRef.current;
    if (!mgr || !id) return;
    mgr.setParameter(pid, val);
    setValues((prev) => ({ ...prev, [pid]: val }));
    const params = settingsRef.current.params;
    params[id] = { ...(params[id] ?? {}), [pid]: val };
    saveSettings(settingsRef.current);
  }, []);

  const onResetParams = useCallback(() => {
    const mgr = managerRef.current;
    const id = activeIdRef.current;
    if (!mgr || !id) return;
    const scene = mgr.list().find((s) => s.id === id);
    if (!scene) return;
    const def = defaultsFor(scene);
    for (const [pid, val] of Object.entries(def)) mgr.setParameter(pid, val);
    setValues(def);
    delete settingsRef.current.params[id];
    saveSettings(settingsRef.current);
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      panelOpenRef.current = !prev;
      return !prev;
    });
  }, []);

  // Engine bootstrap (once).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const mgr = new SceneManager(canvas, { onFrame: setFps });
    managerRef.current = mgr;
    registerAllScenes(mgr);
    mgr.resize(window.innerWidth, window.innerHeight);
    setScenes(mgr.list());

    const saved = loadSettings();
    settingsRef.current = saved;
    prefsRef.current = saved.prefs;
    setPrefs(saved.prefs);
    mgr.setPerformanceMode(saved.prefs.performance);
    const first = mgr.list()[0];

    // Optional deep-link overrides (handy for previews/tests): ?scene=<id>&panel=1
    const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
    const urlScene = query?.get("scene");
    const startId =
      urlScene && mgr.list().some((s) => s.id === urlScene)
        ? urlScene
        : saved.activeSceneId && mgr.list().some((s) => s.id === saved.activeSceneId)
          ? saved.activeSceneId
          : first.id;
    if (query?.get("panel") === "1") {
      panelOpenRef.current = true;
      setPanelOpen(true);
    }
    // Optional overlay preview/deep-link: ?clock=time|datetime &clockFont=…
    // &clockPos=… &clock24h=1 (live only, not persisted).
    const urlClock = query?.get("clock");
    if (urlClock === "time" || urlClock === "datetime") {
      const merged: AuroraPrefs = { ...prefsRef.current, clock: urlClock };
      const f = query?.get("clockFont");
      if (f === "light" || f === "modern" || f === "bold" || f === "mono") merged.clockFont = f;
      const pos = query?.get("clockPos");
      if (pos === "center" || pos === "top" || pos === "bottom" || pos === "bottomRight") {
        merged.clockPosition = pos;
      }
      if (query?.get("clock24h") === "1") merged.clock24h = true;
      prefsRef.current = merged;
      setPrefs(merged);
    }

    applyScene(startId, true);
    // Optional theme preview/deep-link: ?theme=<paletteId> (live only, not saved).
    const urlTheme = query?.get("theme");
    if (urlTheme) mgr.setParameter("theme", urlTheme);
    mgr.start();

    // Clamp to a low-power profile whenever the machine is on battery, releasing
    // it on AC. Fires once with the initial state, then on every transition.
    const stopPowerWatch = watchPowerSource((onBattery) => mgr.setPowerSave(onBattery));

    return () => {
      stopPowerWatch();
      mgr.dispose();
      managerRef.current = null;
    };
  }, [applyScene]);

  // Global keybinds (once).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "escape") {
        if (panelOpenRef.current) {
          panelOpenRef.current = false;
          setPanelOpen(false);
        } else {
          void dismissWindow();
        }
        return;
      }
      if (k === "s") togglePanel();
      else if (k === "n") cycleScene(1);
      else if (k === "p") cycleScene(-1);
      else if (k === " ") {
        e.preventDefault();
        onChangePrefs({ shuffle: !prefsRef.current.shuffle });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePanel, cycleScene, onChangePrefs]);

  // Apply the performance/adaptive profile to the engine when it changes.
  useEffect(() => {
    managerRef.current?.setPerformanceMode(prefs.performance);
  }, [prefs.performance]);

  // Slideshow engine: while shuffle is on, advance on the configured interval.
  useEffect(() => {
    if (!prefs.shuffle) return;
    const id = setInterval(advanceShuffle, Math.max(5, prefs.shuffleSeconds) * 1000);
    return () => clearInterval(id);
  }, [prefs.shuffle, prefs.shuffleSeconds, prefs.shuffleRandom, prefs.shuffleFavoritesOnly, advanceShuffle]);

  const activeName = scenes.find((s) => s.id === activeId)?.name ?? "";

  return (
    <>
      <canvas ref={canvasRef} />

      <button type="button" className="settings-toggle" onClick={togglePanel} aria-label="Gallery & settings">
        ⚙
      </button>

      <ClockOverlay
        mode={prefs.clock}
        font={prefs.clockFont}
        position={prefs.clockPosition}
        hour24={prefs.clock24h}
      />

      <SettingsPanel
        open={panelOpen}
        scenes={scenes}
        activeId={activeId}
        parameters={parameters}
        values={values}
        prefs={prefs}
        onSelectScene={(id) => applyScene(id)}
        onChangeParam={onChangeParam}
        onResetParams={onResetParams}
        onChangePrefs={onChangePrefs}
        onToggleFavorite={onToggleFavorite}
        onClose={togglePanel}
      />

      {import.meta.env.DEV && (
        <div className="dev-overlay">
          {activeName} · {fps} fps
        </div>
      )}
    </>
  );
}

export default App;

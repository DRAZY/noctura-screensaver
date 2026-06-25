import type { Parameter, ParameterValue, Scene } from "../engine/types";
import type { AuroraPrefs } from "../state/settings";
import { ParameterControls } from "./ParameterControls";
import { PlaybackControls } from "./PlaybackControls";
import { ScenePicker } from "./ScenePicker";

/**
 * Slide-in gallery + settings panel. The live canvas keeps rendering behind it
 * as a true preview. Houses the scene picker (top), app-wide playback/overlay
 * controls, and the active scene's auto-generated parameter controls (below).
 * Toggled by the gear button / `S`.
 */
export interface SettingsPanelProps {
  open: boolean;
  scenes: ReadonlyArray<Scene>;
  activeId: string | null;
  parameters: ReadonlyArray<Parameter>;
  values: Record<string, ParameterValue>;
  prefs: AuroraPrefs;
  onSelectScene: (id: string) => void;
  onChangeParam: (id: string, value: ParameterValue) => void;
  onResetParams: () => void;
  onChangePrefs: (patch: Partial<AuroraPrefs>) => void;
  onToggleFavorite: (id: string) => void;
  onClose: () => void;
}

/** App version, surfaced in the About card. Bump on releases. */
const APP_VERSION = "1.1.0";

/**
 * About card: credits the creator and summarizes what the app is. Kept inside
 * the settings panel (no extra modal/route) so it's one keystroke away.
 */
function AboutCard({ sceneCount }: { sceneCount: number }) {
  return (
    <div className="about-card">
      <p className="about-title">Noctura</p>
      <p className="about-version">Version {APP_VERSION}</p>
      <p className="about-desc">
        A gallery of {sceneCount} GPU-accelerated living wallpapers — aurorae, nebulae, digital rain,
        caustics, and more — each rendered in real time and fully tunable. Ships as both a macOS app
        and a native <code>.saver</code> screensaver.
      </p>
      <p className="about-credit">
        Created by <strong>Andre Hall</strong>
      </p>
      <p className="about-fine">
        Built with WebGL / Three.js &amp; Metal. Designed for displays with a capable GPU.
      </p>
    </div>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { open, scenes, activeId, parameters, values, prefs } = props;
  return (
    <aside className={open ? "settings-panel open" : "settings-panel"} aria-hidden={!open}>
      <header className="settings-header">
        <h1>Aurora</h1>
        <button type="button" className="settings-close" onClick={props.onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <section className="settings-section">
        <h2>Gallery</h2>
        <ScenePicker
          scenes={scenes}
          activeId={activeId}
          favorites={prefs.favorites}
          onSelect={props.onSelectScene}
          onToggleFavorite={props.onToggleFavorite}
        />
      </section>

      <section className="settings-section">
        <h2>Playback</h2>
        <PlaybackControls prefs={prefs} onChange={props.onChangePrefs} />
      </section>

      <section className="settings-section">
        <h2>Adjust</h2>
        <ParameterControls
          parameters={parameters}
          values={values}
          onChange={props.onChangeParam}
          onReset={props.onResetParams}
        />
      </section>

      <section className="settings-section">
        <h2>About</h2>
        <AboutCard sceneCount={scenes.length} />
      </section>

      <footer className="settings-footer">
        <span>
          <kbd>S</kbd> toggle · <kbd>N</kbd>/<kbd>P</kbd> next/prev · <kbd>Space</kbd> shuffle · <kbd>Esc</kbd> close
        </span>
      </footer>
    </aside>
  );
}

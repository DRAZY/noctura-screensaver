import type { PerformanceMode } from "../engine/types";
import type { AuroraPrefs, ClockFont, ClockMode, ClockPosition } from "../state/settings";

/**
 * App-wide playback + overlay controls: the slideshow (shuffle) engine and the
 * clock overlay. These sit above the per-scene parameter controls because they
 * affect the whole gallery, not a single scene.
 */
export interface PlaybackControlsProps {
  prefs: AuroraPrefs;
  onChange: (patch: Partial<AuroraPrefs>) => void;
}

const CLOCK_OPTIONS: ReadonlyArray<{ value: ClockMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "time", label: "Time" },
  { value: "datetime", label: "Time + Date" },
];

const CLOCK_FONT_OPTIONS: ReadonlyArray<{ value: ClockFont; label: string }> = [
  { value: "light", label: "Light" },
  { value: "modern", label: "Modern" },
  { value: "bold", label: "Bold" },
  { value: "mono", label: "Mono" },
];

const CLOCK_POSITION_OPTIONS: ReadonlyArray<{ value: ClockPosition; label: string }> = [
  { value: "center", label: "Center" },
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "bottomRight", label: "Corner" },
];

const PERFORMANCE_OPTIONS: ReadonlyArray<{ value: PerformanceMode; label: string; title: string }> = [
  { value: "auto", label: "Auto", title: "Adapt resolution & frame rate to your GPU (recommended)" },
  { value: "full", label: "Full", title: "Native resolution, 60 fps — richest, for strong GPUs" },
  { value: "balanced", label: "Balanced", title: "~44% fewer pixels, 60 fps" },
  { value: "power", label: "Saver", title: "Quarter resolution, 30 fps — lightest, for weak GPUs" },
];

export function PlaybackControls({ prefs, onChange }: PlaybackControlsProps) {
  return (
    <div className="playback-controls">
      <label className="control-row toggle-row">
        <span className="control-label">Slideshow</span>
        <input
          type="checkbox"
          checked={prefs.shuffle}
          onChange={(e) => onChange({ shuffle: e.target.checked })}
          aria-label="Slideshow auto-advance"
        />
      </label>

      {prefs.shuffle && (
        <>
          <label className="control-row">
            <span className="control-label">
              Every <strong>{prefs.shuffleSeconds}s</strong>
            </span>
            <input
              type="range"
              min={5}
              max={300}
              step={5}
              value={prefs.shuffleSeconds}
              onChange={(e) => onChange({ shuffleSeconds: Number(e.target.value) })}
            />
          </label>

          <label className="control-row toggle-row">
            <span className="control-label">Random order</span>
            <input
              type="checkbox"
              checked={prefs.shuffleRandom}
              onChange={(e) => onChange({ shuffleRandom: e.target.checked })}
            />
          </label>

          <label className="control-row toggle-row">
            <span className="control-label">Favorites only</span>
            <input
              type="checkbox"
              checked={prefs.shuffleFavoritesOnly}
              onChange={(e) => onChange({ shuffleFavoritesOnly: e.target.checked })}
            />
          </label>
        </>
      )}

      <div className="control-row segmented-row">
        <span className="control-label">Clock</span>
        <div className="segmented" role="group" aria-label="Clock overlay">
          {CLOCK_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={prefs.clock === o.value ? "seg active" : "seg"}
              onClick={() => onChange({ clock: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {prefs.clock !== "off" && (
        <>
          <div className="control-row segmented-row">
            <span className="control-label">Font</span>
            <div className="segmented" role="group" aria-label="Clock font">
              {CLOCK_FONT_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={prefs.clockFont === o.value ? "seg active" : "seg"}
                  onClick={() => onChange({ clockFont: o.value })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="control-row segmented-row">
            <span className="control-label">Position</span>
            <div className="segmented" role="group" aria-label="Clock position">
              {CLOCK_POSITION_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={prefs.clockPosition === o.value ? "seg active" : "seg"}
                  onClick={() => onChange({ clockPosition: o.value })}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <label className="control-row toggle-row">
            <span className="control-label">24-hour</span>
            <input
              type="checkbox"
              checked={prefs.clock24h}
              onChange={(e) => onChange({ clock24h: e.target.checked })}
            />
          </label>
        </>
      )}

      <div className="control-row segmented-row">
        <span className="control-label">Performance</span>
        <div className="segmented" role="group" aria-label="Performance / GPU usage">
          {PERFORMANCE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              title={o.title}
              className={prefs.performance === o.value ? "seg active" : "seg"}
              onClick={() => onChange({ performance: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

import type { Parameter, ParameterValue } from "../engine/types";

/**
 * Renders live controls for a scene's declared {@link Parameter}s — sliders for
 * `range`, color wells for `color`, segmented buttons for `select`. Fully
 * data-driven: any scene's parameters render here with no per-scene UI code.
 * Every change is applied instantly (no Apply button).
 */
export interface ParameterControlsProps {
  parameters: ReadonlyArray<Parameter>;
  values: Record<string, ParameterValue>;
  onChange: (id: string, value: ParameterValue) => void;
  onReset: () => void;
}

export function ParameterControls({ parameters, values, onChange, onReset }: ParameterControlsProps) {
  return (
    <div className="param-list">
      {parameters.map((p) => (
        <div className="param-row" key={p.id}>
          <label className="param-label" htmlFor={`param-${p.id}`}>
            {p.label}
          </label>
          <div className="param-control">{renderControl(p, values[p.id], onChange)}</div>
        </div>
      ))}
      <button type="button" className="param-reset" onClick={onReset}>
        Reset to defaults
      </button>
    </div>
  );
}

function renderControl(
  p: Parameter,
  value: ParameterValue | undefined,
  onChange: (id: string, value: ParameterValue) => void,
) {
  switch (p.kind) {
    case "range": {
      const v = typeof value === "number" ? value : p.default;
      return (
        <div className="range-wrap">
          <input
            id={`param-${p.id}`}
            type="range"
            min={p.min}
            max={p.max}
            step={p.step}
            value={v}
            onChange={(e) => onChange(p.id, Number(e.target.value))}
          />
          <span className="range-value">{formatNumber(v)}</span>
        </div>
      );
    }
    case "color": {
      const v = typeof value === "string" ? value : p.default;
      return (
        <input
          id={`param-${p.id}`}
          type="color"
          value={v}
          onChange={(e) => onChange(p.id, e.target.value)}
        />
      );
    }
    case "select": {
      const v = typeof value === "string" ? value : p.default;
      return (
        <div className="segmented" role="group">
          {p.options.map((opt) => (
            <button
              type="button"
              key={opt.value}
              className={opt.value === v ? "seg active" : "seg"}
              onClick={() => onChange(p.id, opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      );
    }
  }
}

function formatNumber(n: number): string {
  return Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(2);
}

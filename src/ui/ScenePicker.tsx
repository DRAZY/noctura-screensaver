import type { Scene } from "../engine/types";

/**
 * The gallery's scene list: every registered scene as a selectable card with
 * its name, description, a small gradient swatch, and a favorite (star) toggle.
 * Selecting one crossfades the live background immediately.
 */
export interface ScenePickerProps {
  scenes: ReadonlyArray<Scene>;
  activeId: string | null;
  favorites: ReadonlyArray<string>;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}

// A representative swatch per scene id so the cards read as a visual gallery
// without the cost of live offscreen thumbnail renders.
const SWATCH: Record<string, string> = {
  "ambient-gradient": "linear-gradient(135deg, #1a1240, #c81e8a 55%, #f5a623)",
  "aurora-ribbons": "linear-gradient(135deg, #051721, #13c285 55%, #9ef26b)",
  starfield: "linear-gradient(135deg, #02030a, #3a2f8f 60%, #cfe0ff)",
  "flowing-particles": "linear-gradient(135deg, #170230, #d91c8f 55%, #2ec2eb)",
  plasma: "linear-gradient(135deg, #170230, #d91c8f 55%, #2ec2eb)",
  "matrix-rain": "linear-gradient(135deg, #001405, #0a8f33 55%, #d9ffe0)",
  fireflies: "linear-gradient(135deg, #05080a, #6b4e0a 55%, #fad043)",
  "black-hole": "linear-gradient(135deg, #1c0503, #c73b0a 55%, #fff1c2)",
  tunnel: "linear-gradient(135deg, #02030a, #3a2f8f 55%, #8fb6ff)",
  "synthwave-grid": "linear-gradient(135deg, #170230, #ff5ea0 55%, #2ec2eb)",
  kaleidoscope: "linear-gradient(135deg, #0a0418, #7b2ff7 55%, #f76fd4)",
  caustics: "linear-gradient(135deg, #021a2b, #0b6e8c 55%, #9ff5ff)",
  "polar-clock": "linear-gradient(135deg, #030e2e, #0c5ca3 55%, #6bd2e0)",
};

export function ScenePicker({ scenes, activeId, favorites, onSelect, onToggleFavorite }: ScenePickerProps) {
  return (
    <div className="scene-grid">
      {scenes.map((s) => {
        const fav = favorites.includes(s.id);
        return (
          <div key={s.id} className={s.id === activeId ? "scene-card active" : "scene-card"}>
            <button type="button" className="scene-card-main" onClick={() => onSelect(s.id)}>
              <span
                className="scene-swatch"
                style={{ background: SWATCH[s.id] ?? "linear-gradient(135deg,#222,#666)" }}
              />
              <span className="scene-name">{s.name}</span>
              <span className="scene-desc">{s.description}</span>
            </button>
            <button
              type="button"
              className={fav ? "scene-fav active" : "scene-fav"}
              onClick={() => onToggleFavorite(s.id)}
              aria-label={fav ? `Unfavorite ${s.name}` : `Favorite ${s.name}`}
              title={fav ? "Remove from favorites" : "Add to favorites"}
            >
              {fav ? "★" : "☆"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

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
  "aurora-ribbons": "linear-gradient(135deg, #051721, #13c285 55%, #9ef26b)",
  starfield: "linear-gradient(135deg, #02030a, #3a2f8f 60%, #cfe0ff)",
  "flowing-particles": "linear-gradient(135deg, #170230, #d91c8f 55%, #2ec2eb)",
  "particle-drift": "linear-gradient(135deg, #0b0716, #8a4bd9 55%, #ffd9f2)",
  plasma: "linear-gradient(135deg, #170230, #d91c8f 55%, #2ec2eb)",
  fireflies: "linear-gradient(135deg, #05080a, #6b4e0a 55%, #fad043)",
  "black-hole": "linear-gradient(135deg, #1c0503, #c73b0a 55%, #fff1c2)",
  caustics: "linear-gradient(135deg, #021a2b, #0b6e8c 55%, #9ff5ff)",
  nebula: "linear-gradient(135deg, #0a0418, #3a6ff7 55%, #f76fd4)",
  fractalbloom: "linear-gradient(135deg, #0a0418, #c81e8a 55%, #f5a623)",
  drift: "linear-gradient(135deg, #04030a, #e01e8f 45%, #22c55e 72%, #3b7bf5)",
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

import { useEffect, useRef, useState } from "react";
import { Renderer } from "./engine/Renderer";
import { AmbientGradient } from "./scenes/AmbientGradient";
import { computeFps } from "./ui/fps";

/** Human-readable name of the active scene, surfaced in the dev overlay. */
const SCENE_NAME = "AmbientGradient";

/**
 * Root shell: a single full-viewport `<canvas>` with no UI chrome. On mount it
 * spins up the WebGL `Renderer`, installs the `AmbientGradient` scene, and runs
 * the loop; on unmount it tears everything down. A dim FPS/scene HUD renders in
 * the corner only in dev builds.
 */
function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Per-frame counter sampled by the overlay timer below. A plain closure var
    // (not state) keeps the 60Hz render loop from triggering 60 React
    // re-renders a second.
    let frameCount = 0;

    const renderer = new Renderer(canvas, {
      onFrame: () => {
        frameCount += 1;
      },
    });
    renderer.setScene(new AmbientGradient());
    renderer.start();

    // Sample FPS once per second — only worth the timer in dev.
    let fpsTimer: ReturnType<typeof setInterval> | undefined;
    if (import.meta.env.DEV) {
      let lastSample = performance.now();
      fpsTimer = setInterval(() => {
        const now = performance.now();
        const seconds = (now - lastSample) / 1000;
        lastSample = now;
        setFps(computeFps(frameCount, seconds));
        frameCount = 0;
      }, 1000);
    }

    return () => {
      if (fpsTimer !== undefined) clearInterval(fpsTimer);
      renderer.dispose();
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} />
      {import.meta.env.DEV && (
        <div className="dev-overlay">
          {SCENE_NAME} · {fps} fps
        </div>
      )}
    </>
  );
}

export default App;

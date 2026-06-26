import type { SceneManager } from "../engine/SceneManager";
import { AmbientGradient } from "./AmbientGradient";
import { AuroraRibbons } from "./AuroraRibbons";
import { BlackHole } from "./BlackHole";
import { Caustics } from "./Caustics";
import { Fireflies } from "./Fireflies";
import { FlowingParticles } from "./FlowingParticles";
import { FractalBloom } from "./FractalBloom";
import { Kaleidoscope } from "./Kaleidoscope";
import { LiquidChrome } from "./LiquidChrome";
import { MatrixRain } from "./MatrixRain";
import { Nebula } from "./Nebula";
import { Plasma } from "./Plasma";
import { PolarClock } from "./PolarClock";
import { Starfield } from "./Starfield";
import { SynthwaveGrid } from "./SynthwaveGrid";
import { Tunnel } from "./Tunnel";

/**
 * Register every scene with the manager, in gallery display order. The first
 * one registered (Aurora Drift) is the default. Add new scenes here — nothing
 * else needs to change; the picker and settings UI pick them up automatically.
 */
export function registerAllScenes(manager: SceneManager): void {
  manager.register(new AmbientGradient());
  manager.register(new AuroraRibbons());
  manager.register(new Starfield());
  manager.register(new FlowingParticles());
  manager.register(new Plasma());
  manager.register(new MatrixRain());
  manager.register(new Fireflies());
  manager.register(new BlackHole());
  manager.register(new Tunnel());
  manager.register(new SynthwaveGrid());
  manager.register(new Kaleidoscope());
  manager.register(new Caustics());
  manager.register(new PolarClock());
  // Newer scenes — appended so existing saved scene indices stay stable and the
  // native .saver / .scr dispatch order (13/14/15) matches one-to-one.
  manager.register(new LiquidChrome());
  manager.register(new Nebula());
  manager.register(new FractalBloom());
}

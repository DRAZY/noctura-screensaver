import type { SceneManager } from "../engine/SceneManager";
import { AuroraRibbons } from "./AuroraRibbons";
import { BlackHole } from "./BlackHole";
import { Caustics } from "./Caustics";
import { Drift } from "./Drift";
import { Fireflies } from "./Fireflies";
import { FlowingParticles } from "./FlowingParticles";
import { FractalBloom } from "./FractalBloom";
import { Nebula } from "./Nebula";
import { ParticleDrift } from "./ParticleDrift";
import { Plasma } from "./Plasma";
import { Starfield } from "./Starfield";

/**
 * Register every scene with the manager, in gallery display order. The first
 * one registered (Northern Lights) is the default. Add new scenes here — nothing
 * else needs to change; the picker and settings UI pick them up automatically.
 *
 * Curated 2026-07 from 18 scenes down to these 11 keepers. Scenes are looked up
 * by string id, so removed scenes simply fall back to the default; all 13 color
 * Styles remain available on every scene.
 */
export function registerAllScenes(manager: SceneManager): void {
  manager.register(new AuroraRibbons()); // Northern Lights
  manager.register(new Starfield()); // Deep Space
  manager.register(new ParticleDrift());
  manager.register(new Plasma()); // Plasma Field
  manager.register(new Fireflies());
  manager.register(new BlackHole());
  manager.register(new Caustics());
  manager.register(new Nebula()); // Nebula Drift
  manager.register(new FractalBloom());
  manager.register(new Drift()); // Flux Drift
  manager.register(new FlowingParticles()); // Particle Swarm
}

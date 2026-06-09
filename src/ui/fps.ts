/**
 * Compute frames-per-second from a frame count sampled over a wall-clock window.
 *
 * Kept pure (no timers, no DOM) so the FPS overlay's only non-trivial logic is
 * unit-testable without a render loop. Returns 0 for a non-positive window to
 * avoid divide-by-zero / Infinity leaking into the UI.
 */
export function computeFps(frames: number, elapsedSeconds: number): number {
  if (elapsedSeconds <= 0 || !Number.isFinite(elapsedSeconds)) return 0;
  return Math.round(frames / elapsedSeconds);
}

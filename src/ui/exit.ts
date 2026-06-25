/**
 * Screensaver-style "dismiss on any input" behaviour.
 *
 * Real screensavers exit the moment the user touches the machine — a key, a
 * click, the scroll wheel, or a deliberate mouse move. This module installs
 * those listeners on a DOM-event target and invokes a single `onExit` callback
 * the first time genuine input arrives.
 *
 * Kept free of any Tauri import so it is unit-testable with a fake event target;
 * the caller supplies the real `onExit` (which closes the native window).
 */

export interface ExitOnInputOptions {
  /** Invoked once, on the first qualifying input event. */
  onExit: () => void;
  /**
   * Minimum cumulative pointer travel (in pixels) before a `mousemove` counts
   * as intentional activity. Guards against the spurious synthetic move some
   * platforms emit right after a window gains focus. Defaults to 8.
   */
  moveThreshold?: number;
}

/** Minimal slice of `EventTarget` we depend on — keeps the fake in tests tiny. */
export interface ListenerTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

const DEFAULT_MOVE_THRESHOLD = 8;

/**
 * Wire up exit-on-input on `target`. Returns a cleanup function that removes
 * every listener; `onExit` fires at most once regardless.
 *
 * `keydown`, `mousedown`, and `wheel` trigger immediately. `mousemove` only
 * triggers once the pointer has travelled `moveThreshold` pixels from where it
 * was first seen, so a stray one-pixel jitter on launch won't dismiss instantly.
 */
export function installExitOnInput(
  target: ListenerTarget,
  options: ExitOnInputOptions,
): () => void {
  const threshold = options.moveThreshold ?? DEFAULT_MOVE_THRESHOLD;
  let fired = false;
  let origin: { x: number; y: number } | null = null;

  const fire = (): void => {
    if (fired) return;
    fired = true;
    cleanup();
    options.onExit();
  };

  const onKeyDown = (): void => fire();
  const onMouseDown = (): void => fire();
  const onWheel = (): void => fire();

  const onMouseMove = (event: unknown): void => {
    const e = event as { clientX?: number; clientY?: number };
    const x = e.clientX ?? 0;
    const y = e.clientY ?? 0;
    if (origin === null) {
      origin = { x, y };
      return;
    }
    const dist = Math.hypot(x - origin.x, y - origin.y);
    if (dist >= threshold) fire();
  };

  const registrations: Array<[string, (event: unknown) => void]> = [
    ["keydown", onKeyDown],
    ["mousedown", onMouseDown],
    ["wheel", onWheel],
    ["mousemove", onMouseMove],
  ];

  for (const [type, listener] of registrations) {
    target.addEventListener(type, listener);
  }

  function cleanup(): void {
    for (const [type, listener] of registrations) {
      target.removeEventListener(type, listener);
    }
  }

  return cleanup;
}

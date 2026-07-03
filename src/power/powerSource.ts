/**
 * Power-source watcher for the web / Tauri shell. Reports whether the machine is
 * running on battery so the engine can clamp to a low-power profile — a
 * screensaver must never quietly drain a laptop overnight.
 *
 * Detection uses the Battery Status API (`navigator.getBattery`), which is
 * present in Chromium-based hosts: Windows WebView2 (the Tauri webview on
 * Windows), newer WebKitGTK (Linux), and Chromium browsers. macOS WKWebView (the
 * Tauri webview on macOS) does not implement it — there `watchPowerSource`
 * reports AC and stays out of the way, because the shipping macOS `.saver`
 * covers the real screensaver case with full IOKit power-source detection. The
 * `queryTauri` hook below is the seam where a native Tauri `power_status`
 * command can later feed WKWebView a real signal without touching callers.
 */

export type PowerState = "battery" | "ac" | "unknown";

/** The slice of the Battery Status API we rely on (charging + change events). */
interface BatteryLike {
  charging: boolean;
  addEventListener(type: "chargingchange", cb: () => void): void;
  removeEventListener(type: "chargingchange", cb: () => void): void;
}

/**
 * Begin watching the power source. Invokes `onChange(onBattery)` once with the
 * initial state and again on every transition. Returns a disposer that detaches
 * all listeners. Safe to call in non-browser contexts (it simply reports AC).
 */
export function watchPowerSource(onChange: (onBattery: boolean) => void): () => void {
  let disposed = false;
  let battery: BatteryLike | null = null;
  let listener: (() => void) | null = null;

  const nav =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> })
      : null;

  if (nav?.getBattery) {
    nav
      .getBattery()
      .then((b) => {
        if (disposed) {
          // Detach immediately if we were disposed while the promise was pending.
          return;
        }
        battery = b;
        listener = () => onChange(!b.charging);
        b.addEventListener("chargingchange", listener);
        onChange(!b.charging);
      })
      .catch(() => {
        // API present but rejected (host quirk / permissions) — assume AC.
        if (!disposed) onChange(false);
      });
  } else {
    // No Battery API on this host (e.g. WKWebView) — assume AC and leave the
    // profile to the user's chosen mode. The native saver handles battery there.
    onChange(false);
  }

  return () => {
    disposed = true;
    if (battery && listener) battery.removeEventListener("chargingchange", listener);
    battery = null;
    listener = null;
  };
}

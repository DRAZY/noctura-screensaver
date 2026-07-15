/**
 * Power-source watcher for the web / Tauri shell. Reports whether the machine is
 * running on battery so the engine can clamp to a low-power profile — a
 * screensaver must never quietly drain a laptop overnight.
 *
 * Detection uses the Battery Status API (`navigator.getBattery`), which is
 * present in Chromium-based hosts: Windows WebView2 (the Tauri webview on
 * Windows), newer WebKitGTK (Linux), and Chromium browsers. macOS WKWebView (the
 * Tauri webview on macOS) does not implement it — there we poll the native
 * Tauri `power_status` command (IOKit battery + Low Power Mode, mirroring the
 * `.saver`) every {@link TAURI_POLL_MS}. Outside both hosts (plain browser
 * without the API) we report AC and stay out of the way.
 */

export type PowerState = "battery" | "ac" | "unknown";

/**
 * How often to re-ask the native side for the power source when the Battery
 * Status API is unavailable (macOS WKWebView). A screensaver reacts to an
 * unplug within this window; the call is a trivial IPC round-trip.
 */
const TAURI_POLL_MS = 30_000;

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

  let pollTimer: ReturnType<typeof setInterval> | null = null;

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
  } else if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    // No Battery API but we're inside the Tauri shell (macOS WKWebView): poll
    // the native power_status command instead. Report only real transitions so
    // callers aren't re-seeded every poll; "unknown" leaves the last state.
    let last: boolean | null = null;
    const poll = async (): Promise<void> => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const status = await invoke<PowerState>("power_status");
        if (disposed || status === "unknown") return;
        const onBattery = status === "battery";
        if (onBattery !== last) {
          last = onBattery;
          onChange(onBattery);
        }
      } catch {
        // Command missing (older shell) — behave like the old AC fallback once.
        if (!disposed && last === null) {
          last = false;
          onChange(false);
        }
      }
    };
    void poll();
    pollTimer = setInterval(() => void poll(), TAURI_POLL_MS);
  } else {
    // No Battery API and not in Tauri (plain browser) — assume AC and leave
    // the profile to the user's chosen mode. The native savers handle battery.
    onChange(false);
  }

  return () => {
    disposed = true;
    if (pollTimer !== null) clearInterval(pollTimer);
    if (battery && listener) battery.removeEventListener("chargingchange", listener);
    battery = null;
    listener = null;
  };
}

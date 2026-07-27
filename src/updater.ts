/**
 * Self-update check for the desktop app (Tauri shell only; no-op in a plain
 * browser). Runs once shortly after startup: if a newer release is published
 * on GitHub (latest.json updater manifest), asks the user, then downloads,
 * installs, and relaunches. This is the anti-orphan story for the app — users
 * update in place instead of accumulating old copies.
 */
export function startUpdateCheck(): void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  // Delay so the gallery paints first; updates are never worth jank at launch.
  window.setTimeout(() => {
    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const { ask, message } = await import("@tauri-apps/plugin-dialog");
        const { relaunch } = await import("@tauri-apps/plugin-process").catch(() => ({ relaunch: null as null | (() => Promise<void>) }));
        const update = await check();
        if (!update) return;
        const yes = await ask(
          `Noctura ${update.version} is available (you have ${update.currentVersion}).\n\nDownload and install now?`,
          { title: "Update available", kind: "info", okLabel: "Update", cancelLabel: "Later" },
        );
        if (!yes) return;
        await update.downloadAndInstall();
        if (relaunch) {
          await relaunch();
        } else {
          await message("Update installed — it will apply the next time you open Noctura.", { title: "Noctura" });
        }
      } catch {
        // Network down / no manifest yet — never bother the user about it.
      }
    })();
  }, 4000);
}

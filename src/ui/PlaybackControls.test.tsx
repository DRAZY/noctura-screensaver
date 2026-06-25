import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_PREFS } from "../state/settings";
import { PlaybackControls } from "./PlaybackControls";

/**
 * The Performance control is the web half of feature parity with the native
 * saver. These render the control to static markup (no browser needed) and
 * assert the four modes are present and the active one is reflected.
 */
describe("PlaybackControls — Performance", () => {
  it("renders all four performance modes", () => {
    const html = renderToStaticMarkup(
      <PlaybackControls prefs={{ ...DEFAULT_PREFS }} onChange={() => {}} />,
    );
    expect(html).toContain("Performance");
    for (const label of ["Auto", "Full", "Balanced", "Saver"]) {
      expect(html).toContain(`>${label}</button>`);
    }
  });

  it("marks the selected performance mode active", () => {
    const html = renderToStaticMarkup(
      <PlaybackControls prefs={{ ...DEFAULT_PREFS, performance: "balanced" }} onChange={() => {}} />,
    );
    // The active button carries the "seg active" class; Balanced should be it.
    expect(html).toMatch(/class="seg active"[^>]*>Balanced<\/button>/);
    expect(html).toMatch(/class="seg"[^>]*>Auto<\/button>/);
  });

  it("defaults to Auto", () => {
    expect(DEFAULT_PREFS.performance).toBe("auto");
    const html = renderToStaticMarkup(
      <PlaybackControls prefs={{ ...DEFAULT_PREFS }} onChange={() => {}} />,
    );
    expect(html).toMatch(/class="seg active"[^>]*>Auto<\/button>/);
  });
});

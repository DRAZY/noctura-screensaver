/**
 * DMG background generator: 660×420 @2x (1320×840 px) — deep-space gradient,
 * a faint Flux blade wash along the bottom, "Noctura" wordmark and a subtle
 * arrow from app position to the Applications folder position (Tauri dmg
 * config places icons at y≈220, app x≈180, Applications x≈480).
 *
 * Usage: bun scripts/make-dmg-bg.ts <outPng>
 */
import puppeteer from "puppeteer-core";

const [outPng] = process.argv.slice(2);
if (!outPng) {
  console.error("usage: bun scripts/make-dmg-bg.ts <outPng>");
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=metal", "--hide-scrollbars", "--window-size=1400,1000"],
  defaultViewport: { width: 1320, height: 840, deviceScaleFactor: 1 },
});
try {
  // Grab a live Flux frame for the bottom wash.
  const scene = await browser.newPage();
  await scene.setViewport({ width: 1320, height: 400 });
  await scene.goto("http://localhost:5180/?scene=drift", { waitUntil: "networkidle2", timeout: 30000 });
  // Hide the fps overlay + settings gear so the wash is pure scene.
  await scene.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const h = el as HTMLElement;
      if (h.tagName !== "CANVAS" && h.querySelector && !h.querySelector("canvas")) h.style.visibility = "hidden";
    }
  });
  await new Promise((r) => setTimeout(r, 12000));
  const fluxB64 = (await scene.screenshot({ encoding: "base64" })) as string;

  const page = await browser.newPage();
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="1320" height="840"></canvas></body></html>`);
  await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const c = document.getElementById("c") as HTMLCanvasElement;
    const x = c.getContext("2d")!;
    const W = 1320, H = 840;

    // Deep-space vertical gradient.
    const bg = x.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0a0918");
    bg.addColorStop(0.65, "#05040c");
    bg.addColorStop(1, "#03020a");
    x.fillStyle = bg;
    x.fillRect(0, 0, W, H);

    // Flux wash along the bottom, faded in.
    x.save();
    x.globalAlpha = 0.75;
    const fade = x.createLinearGradient(0, H - 460, 0, H);
    x.drawImage(img, 0, H - 400, W, 400);
    // fade its top edge into the background
    fade.addColorStop(0, "rgba(5,4,12,1)");
    fade.addColorStop(0.45, "rgba(5,4,12,0.15)");
    fade.addColorStop(1, "rgba(5,4,12,0)");
    x.globalAlpha = 1;
    x.fillStyle = fade;
    x.fillRect(0, H - 460, W, 460);
    x.restore();

    // Wordmark.
    x.fillStyle = "rgba(255,255,255,0.92)";
    x.font = "600 64px -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif";
    x.textAlign = "center";
    x.fillText("Noctura", W / 2, 130);
    x.fillStyle = "rgba(255,255,255,0.45)";
    x.font = "400 26px -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif";
    x.fillText("Drag Noctura into Applications to install", W / 2, 180);

    // Arrow between icon positions (app at 180,290 → Applications at 480,290 in
    // 660×420 logical points ⇒ ×2 for @2x canvas).
    const y = 290 * 2 - 10;
    const x1 = 180 * 2 + 90, x2 = 480 * 2 - 90;
    x.strokeStyle = "rgba(255,255,255,0.5)";
    x.lineWidth = 6;
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(x1, y);
    x.lineTo(x2 - 26, y);
    x.stroke();
    x.beginPath();
    x.moveTo(x2, y);
    x.lineTo(x2 - 34, y - 20);
    x.lineTo(x2 - 34, y + 20);
    x.closePath();
    x.fillStyle = "rgba(255,255,255,0.5)";
    x.fill();
  }, fluxB64);
  const el = await page.$("#c");
  await el!.screenshot({ path: outPng });
  console.log(`wrote ${outPng}`);
} finally {
  await browser.close();
}

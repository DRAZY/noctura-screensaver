/**
 * Icon builder: captures a square Flux Drift frame from the running dev server,
 * then composes the 1024px app-icon master in an HTML canvas — macOS-style
 * squircle mask, deep-space backdrop, subtle rim light — and exports PNG with
 * transparency. Chrome is the compositor (no ImageMagick/PIL needed).
 *
 * Usage: bun scripts/make-icon.ts <outPng> [warmupMs]
 */
import puppeteer from "puppeteer-core";

const [outPng, warmupMsStr] = process.argv.slice(2);
if (!outPng) {
  console.error("usage: bun scripts/make-icon.ts <outPng> [warmupMs]");
  process.exit(1);
}
const warmupMs = Number(warmupMsStr ?? 16000);
const SIZE = 1200; // capture viewport (square)

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=metal", "--hide-scrollbars", `--window-size=${SIZE},${SIZE}`],
  defaultViewport: { width: SIZE, height: SIZE },
});
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5180/?scene=drift", { waitUntil: "networkidle2", timeout: 30000 });
  // Hide the fps overlay + settings gear so the capture is pure scene.
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const h = el as HTMLElement;
      if (h.tagName !== "CANVAS" && h.querySelector && !h.querySelector("canvas")) h.style.visibility = "hidden";
    }
  });
  await new Promise((r) => setTimeout(r, warmupMs));
  const sceneB64 = (await page.screenshot({ encoding: "base64" })) as string;

  // Compose the icon on a fresh page (image passed via evaluate, not inline HTML).
  const compose = await browser.newPage();
  await compose.setViewport({ width: 1024, height: 1024 });
  await compose.setContent(`<!DOCTYPE html><html><body style="margin:0;background:transparent"><canvas id="c" width="1024" height="1024"></canvas></body></html>`);
  await compose.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = "data:image/png;base64," + b64;
    });
    const c = document.getElementById("c") as HTMLCanvasElement;
    const x = c.getContext("2d")!;
    const S = 1024;
    // macOS Big Sur+ icon grid: squircle occupies ~824/1024 centered.
    const R = 412;
    const cx = S / 2, cy = S / 2;
    const n = 5; // superellipse exponent (Apple squircle)
    const path = new Path2D();
    const steps = 720;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 2 * Math.PI;
      const ct = Math.cos(t), st = Math.sin(t);
      const px = cx + R * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n);
      const py = cy + R * Math.sign(st) * Math.pow(Math.abs(st), 2 / n);
      if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
    }
    path.closePath();

    // Soft drop shadow behind the squircle.
    x.save();
    x.shadowColor = "rgba(0,0,0,0.35)";
    x.shadowBlur = 28;
    x.shadowOffsetY = 14;
    x.fillStyle = "#05040c";
    x.fill(path);
    x.restore();

    // Clip and draw the scene, slightly zoomed for punch.
    x.save();
    x.clip(path);
    const zoom = 1.12;
    const dw = S * zoom, dh = S * zoom;
    x.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
    // Deep vignette so edges recede like a night sky.
    const vg = x.createRadialGradient(cx, cy, R * 0.45, cx, cy, R * 1.25);
    vg.addColorStop(0, "rgba(5,4,12,0)");
    vg.addColorStop(1, "rgba(5,4,12,0.55)");
    x.fillStyle = vg;
    x.fillRect(0, 0, S, S);
    // Top rim light.
    const rim = x.createLinearGradient(0, cy - R, 0, cy);
    rim.addColorStop(0, "rgba(255,255,255,0.16)");
    rim.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = rim;
    x.fillRect(0, 0, S, S);
    x.restore();

    // Hairline edge stroke to separate from light backgrounds.
    x.save();
    x.strokeStyle = "rgba(255,255,255,0.10)";
    x.lineWidth = 3;
    x.stroke(path);
    x.restore();
  }, sceneB64);
  const el = await compose.$("#c");
  await el!.screenshot({ path: outPng, omitBackground: true });
  console.log(`wrote ${outPng}`);
} finally {
  await browser.close();
}

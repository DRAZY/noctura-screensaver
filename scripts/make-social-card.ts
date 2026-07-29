/**
 * GitHub social preview card (1280×640): full-bleed live Flux frame, dark
 * vignette, icon + wordmark + tagline. Upload manually at
 * Settings → General → Social preview (no API exists for it).
 *
 * Usage: bun scripts/make-social-card.ts <outPng>
 */
import puppeteer from "puppeteer-core";
import { readFileSync } from "fs";

const [outPng] = process.argv.slice(2);
if (!outPng) {
  console.error("usage: bun scripts/make-social-card.ts <outPng>");
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=metal", "--hide-scrollbars", "--window-size=1400,800"],
  defaultViewport: { width: 1280, height: 640 },
});
try {
  const scene = await browser.newPage();
  await scene.setViewport({ width: 1280, height: 640 });
  await scene.goto("http://localhost:5180/?scene=drift", { waitUntil: "networkidle2", timeout: 30000 });
  await scene.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const h = el as HTMLElement;
      if (h.tagName !== "CANVAS" && h.querySelector && !h.querySelector("canvas")) h.style.visibility = "hidden";
    }
  });
  await new Promise((r) => setTimeout(r, 15000));
  const fluxB64 = (await scene.screenshot({ encoding: "base64" })) as string;
  const iconB64 = readFileSync("assets/icon-master-1024.png").toString("base64");

  const page = await browser.newPage();
  await page.setContent(`<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="1280" height="640"></canvas></body></html>`);
  await page.evaluate(async ({ flux, icon }) => {
    const load = (b64: string) => new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "data:image/png;base64," + b64;
    });
    const [fluxImg, iconImg] = await Promise.all([load(flux), load(icon)]);
    const c = document.getElementById("c") as HTMLCanvasElement;
    const x = c.getContext("2d")!;
    const W = 1280, H = 640;
    x.drawImage(fluxImg, 0, 0, W, H);
    // Darken for text legibility: bottom-weighted gradient.
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(3,2,10,0.25)");
    g.addColorStop(0.55, "rgba(3,2,10,0.45)");
    g.addColorStop(1, "rgba(3,2,10,0.78)");
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    // Icon + wordmark centered.
    const isz = 148;
    x.drawImage(iconImg, W / 2 - isz / 2, 158, isz, isz);
    x.fillStyle = "rgba(255,255,255,0.96)";
    x.font = "700 84px -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif";
    x.textAlign = "center";
    x.fillText("Noctura", W / 2, 420);
    x.fillStyle = "rgba(255,255,255,0.72)";
    x.font = "400 34px -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif";
    x.fillText("Living GPU art for your idle screen — macOS & Windows", W / 2, 478);
  }, { flux: fluxB64, icon: iconB64 });
  const el = await page.$("#c");
  await el!.screenshot({ path: outPng });
  console.log(`wrote ${outPng}`);
} finally {
  await browser.close();
}

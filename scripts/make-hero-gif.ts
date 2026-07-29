/**
 * Animated hero for the README: captures live Flux Drift frames on a real
 * clock (puppeteer) and encodes a looping GIF in pure JS (pngjs + gifenc) —
 * no ffmpeg/gifski needed on this machine.
 *
 * Usage: bun scripts/make-hero-gif.ts <outGif> [frames] [frameMs] [outWidth]
 */
import puppeteer from "puppeteer-core";
import { PNG } from "pngjs";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { writeFileSync } from "fs";

const [outGif, framesStr, frameMsStr, outWStr] = process.argv.slice(2);
if (!outGif) {
  console.error("usage: bun scripts/make-hero-gif.ts <outGif> [frames] [frameMs] [outWidth]");
  process.exit(1);
}
const FRAMES = Number(framesStr ?? 48);
const FRAME_MS = Number(frameMsStr ?? 125); // capture + playback cadence (8 fps)
const OUT_W = Number(outWStr ?? 840);
const CAP_W = 1280, CAP_H = 720;

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=metal", "--hide-scrollbars", `--window-size=${CAP_W},${CAP_H}`],
  defaultViewport: { width: CAP_W, height: CAP_H },
});
try {
  const page = await browser.newPage();
  await page.goto("http://localhost:5180/?scene=drift", { waitUntil: "networkidle2", timeout: 30000 });
  // Hide overlay chrome (fps label, settings gear) — pure scene only.
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const h = el as HTMLElement;
      if (h.tagName !== "CANVAS" && h.querySelector && !h.querySelector("canvas")) h.style.visibility = "hidden";
    }
  });
  await new Promise((r) => setTimeout(r, 15000)); // let the fluid develop

  const raws: Buffer[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const t0 = Date.now();
    raws.push((await page.screenshot()) as Buffer);
    const spent = Date.now() - t0;
    if (spent < FRAME_MS) await new Promise((r) => setTimeout(r, FRAME_MS - spent));
  }
  console.log(`captured ${raws.length} frames`);

  // Decode, downscale (box filter), and encode.
  const OUT_H = Math.round((OUT_W / CAP_W) * CAP_H);
  const gif = GIFEncoder();
  for (let f = 0; f < raws.length; f++) {
    const png = PNG.sync.read(Buffer.from(raws[f]));
    const src = png.data;
    const dst = new Uint8ClampedArray(OUT_W * OUT_H * 4);
    const sx = png.width / OUT_W, sy = png.height / OUT_H;
    for (let y = 0; y < OUT_H; y++) {
      for (let x = 0; x < OUT_W; x++) {
        // 2x2 box sample for cheap AA.
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const px = Math.min(png.width - 1, Math.floor(x * sx + dx * sx * 0.5));
            const py = Math.min(png.height - 1, Math.floor(y * sy + dy * sy * 0.5));
            const o = (py * png.width + px) * 4;
            r += src[o]; g += src[o + 1]; b += src[o + 2];
          }
        }
        const o = (y * OUT_W + x) * 4;
        dst[o] = r >> 2; dst[o + 1] = g >> 2; dst[o + 2] = b >> 2; dst[o + 3] = 255;
      }
    }
    const palette = quantize(dst, 256);
    const index = applyPalette(dst, palette);
    gif.writeFrame(index, OUT_W, OUT_H, { palette, delay: FRAME_MS });
    if (f % 10 === 0) console.log(`encoded ${f + 1}/${raws.length}`);
  }
  gif.finish();
  writeFileSync(outGif, Buffer.from(gif.bytes()));
  console.log(`wrote ${outGif} (${OUT_W}x${OUT_H}, ${raws.length} frames @ ${1000 / FRAME_MS} fps)`);
} finally {
  await browser.close();
}

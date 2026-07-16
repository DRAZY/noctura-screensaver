/**
 * Real-time capture harness for Flux Drift verification. Unlike Chrome's
 * --virtual-time-budget (which fast-forwards rAF and starves a real-time
 * simulation of frames), this runs the page on a real clock, waits for the sim
 * to develop, then captures one or more frames at controlled wall-clock gaps —
 * suitable for both look and motion (decorrelation) measurement.
 *
 * Usage: bun scripts/capture-drift.ts <url> <outPrefix> <warmupMs> [gapMs xN]
 *   bun scripts/capture-drift.ts "http://localhost:5180/?scene=drift" /tmp/drift 8000 100 400 2000
 */
import puppeteer from "puppeteer-core";

const [url, outPrefix, warmupMsStr, ...gapStrs] = process.argv.slice(2);
if (!url || !outPrefix) {
  console.error("usage: bun scripts/capture-drift.ts <url> <outPrefix> <warmupMs> [gapMs ...]");
  process.exit(1);
}
const warmupMs = Number(warmupMsStr ?? 8000);
const gaps = gapStrs.length ? gapStrs.map(Number) : [];

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=metal", "--hide-scrollbars", "--window-size=1440,900"],
  defaultViewport: { width: 1440, height: 900 },
});
try {
  const page = await browser.newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (/error|DRIFT|THREE/i.test(text)) console.error("[console]", text);
  });
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, warmupMs));
  await page.screenshot({ path: `${outPrefix}_0.png` });
  console.log(`wrote ${outPrefix}_0.png`);
  let i = 1;
  for (const gap of gaps) {
    await new Promise((r) => setTimeout(r, gap));
    await page.screenshot({ path: `${outPrefix}_${i}.png` });
    console.log(`wrote ${outPrefix}_${i}.png (+${gap}ms)`);
    i += 1;
  }
} finally {
  await browser.close();
}

/**
 * Generates the Tauri updater manifest (latest.json) for a GitHub release.
 * Run after `bun run tauri build --target universal-apple-darwin` with the
 * signing key env set; upload the output next to the release assets.
 *
 *   TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/noctura.key \
 *     bun run tauri build --target universal-apple-darwin
 *   bun scripts/make-latest-json.ts <version> <outPath>
 *   gh release upload v<version> <outPath> Noctura.app.tar.gz ...
 *
 * The universal .app.tar.gz serves both darwin architectures.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const [version, outPath] = process.argv.slice(2);
if (!version || !outPath) {
  console.error("usage: bun scripts/make-latest-json.ts <version> <outPath>");
  process.exit(1);
}

const bundleDir = "src-tauri/target/universal-apple-darwin/release/bundle/macos";
const tarball = `${bundleDir}/Noctura.app.tar.gz`;
const sigFile = `${tarball}.sig`;
if (!existsSync(tarball) || !existsSync(sigFile)) {
  console.error(`missing updater artifacts under ${bundleDir} — build with createUpdaterArtifacts + signing key first`);
  process.exit(1);
}
const signature = readFileSync(sigFile, "utf8").trim();
const url = `https://github.com/DRAZY/noctura-screensaver/releases/download/v${version}/Noctura.app.tar.gz`;

const manifest = {
  version,
  notes: `Noctura ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { signature, url },
    "darwin-x86_64": { signature, url },
  },
};
writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`wrote ${outPath} for v${version}`);

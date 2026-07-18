/**
 * Build the extension for Chrome and Firefox.
 *
 * Bundles each entry point into a flat, self-contained IIFE script
 * (MV3 content scripts and the Firefox background page cannot use ES
 * modules), then copies static assets and the per-browser manifest.
 *
 * Usage: bun run build.js
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT = import.meta.dir;
const DIST = join(ROOT, "dist");

const ENTRIES = [
  "src/background.js",
  "src/popup/popup.js",
  "src/options/options.js",
  "src/content/autofill.js",
  "src/content/inbox-bridge.js",
];

const STATIC_FILES = [
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
  ["src/options/options.html", "options.html"],
  ["src/options/options.css", "options.css"],
];

const TARGETS = {
  chrome: "src/manifest.chrome.json",
  firefox: "src/manifest.firefox.json",
};

async function buildTarget(target, manifestPath) {
  const outdir = join(DIST, target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  for (const entry of ENTRIES) {
    const result = await Bun.build({
      entrypoints: [join(ROOT, entry)],
      outdir,
      target: "browser",
      format: "iife",
      minify: false,
      naming: "[name].[ext]",
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`Bundling ${entry} failed`);
    }
  }

  for (const [from, to] of STATIC_FILES) {
    await cp(join(ROOT, from), join(outdir, to));
  }
  await cp(join(ROOT, "icons"), join(outdir, "icons"), { recursive: true });
  await cp(join(ROOT, manifestPath), join(outdir, "manifest.json"));
  console.log(`Built ${target} -> ${outdir}`);
}

for (const [target, manifestPath] of Object.entries(TARGETS)) {
  await buildTarget(target, manifestPath);
}
console.log("Done. Load dist/chrome (chrome://extensions, Developer mode, " +
  "Load unpacked) or dist/firefox (about:debugging, Load Temporary Add-on).");

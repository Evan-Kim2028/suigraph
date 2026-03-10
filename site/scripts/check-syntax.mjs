#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const htmlPath = resolve(SITE_ROOT, "index.html");
const externalJsPaths = [
  resolve(SITE_ROOT, "assets/app.js"),
  resolve(SITE_ROOT, "assets/app-extra.js"),
];
const html = readFileSync(htmlPath, "utf8");

const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter(Boolean);
const externalScripts = externalJsPaths.filter((path) => existsSync(path)).map((path) => readFileSync(path, "utf8"));
const scripts = [...inlineScripts, ...externalScripts];

if (!scripts.length) {
  console.error("check-syntax: no built script sources found");
  process.exit(1);
}

for (let i = 0; i < scripts.length; i++) {
  try {
    // Parse-only check for runtime syntax regressions.
    new Function(scripts[i]);
  } catch (err) {
    console.error(`check-syntax: script block ${i + 1} failed: ${err.message}`);
    process.exit(1);
  }
}

console.log(`check-syntax: ${scripts.length} built script source(s) parsed successfully`);

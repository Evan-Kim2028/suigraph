#!/usr/bin/env node

/**
 * check-bundle-size — fails if any built artifact exceeds its size budget.
 *
 * Prevents accidental inclusion of large dependencies, duplicated code,
 * or unminified output from reaching production.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");
const ASSETS = join(DIST, "assets");

// Size budgets in bytes.  Set ~20-30% above current sizes so normal
// feature growth doesn't trip the check, but a 2× blowup does.
const BUDGETS = {
  "app.js":       550_000,   // boot bundle (currently ~408K)
  "app-extra.js": 300_000,   // extra routes  (currently ~218K)
  "styles.css":    60_000,   // stylesheet    (currently ~37K)
};
const TOTAL_BUDGET = 900_000; // all dist/ files combined (currently ~669K)

let failed = false;

// Per-file checks
for (const [file, budget] of Object.entries(BUDGETS)) {
  const path = join(ASSETS, file);
  let size;
  try {
    size = statSync(path).size;
  } catch {
    console.log(`  ${file}: MISSING (expected in dist/assets/)`);
    failed = true;
    continue;
  }
  const pct = ((size / budget) * 100).toFixed(0);
  const ok = size <= budget;
  const sizeK = (size / 1024).toFixed(1);
  const budgetK = (budget / 1024).toFixed(0);
  console.log(`  ${file}: ${sizeK}KB / ${budgetK}KB (${pct}%) ${ok ? "\u2713" : "\u2717 OVER BUDGET"}`);
  if (!ok) failed = true;
}

// Total check
let total = 0;
try {
  total += statSync(join(DIST, "index.html")).size;
} catch { /* ok */ }
try {
  for (const f of readdirSync(ASSETS)) {
    total += statSync(join(ASSETS, f)).size;
  }
} catch { /* ok */ }

const totalK = (total / 1024).toFixed(1);
const budgetK = (TOTAL_BUDGET / 1024).toFixed(0);
const totalOk = total <= TOTAL_BUDGET;
console.log(`  TOTAL: ${totalK}KB / ${budgetK}KB ${totalOk ? "\u2713" : "\u2717 OVER BUDGET"}`);
if (!totalOk) failed = true;

if (failed) {
  console.log("check-bundle-size: FAILED — one or more artifacts exceed their size budget.");
  console.log("If this is expected growth, update BUDGETS in scripts/check-bundle-size.mjs.");
  process.exit(1);
} else {
  console.log("check-bundle-size: ok");
}

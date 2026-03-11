#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAppBundleSources } from "./lib/app-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");

const ALLOWED_BOOT_TO_EXTRA_CALLS = new Set([
  "renderCongestion",
  "renderDefiDex",
  "renderDefiFlows",
  "renderDefiLst",
  "renderDefiOverview",
  "renderDefiRates",
  "renderDefiStablecoins",
  "renderDocs",
  "renderEvents",
  "renderGraphQLPlayground",
  "renderPackages",
  "renderProtocolConfig",
  "renderSimulator",
  "renderTransfers",
  "renderValidators",
]);

const REQUIRED_BOOT_SYMBOLS = [
  "fetchCheckpointDetailShell",
  "fetchObjectShell",
  "fetchTxShell",
  "normalizeSuiAddress",
  "renderCheckpointDetail",
  "renderDashboard",
  "renderTransactions",
  "renderTxDetail",
];

function collectFunctionDeclarations(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    names.add(match[1]);
  }
  return names;
}

function collectFunctionCalls(source) {
  const names = new Set();
  for (const match of source.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    names.add(match[1]);
  }
  return names;
}

function fail(message, details = []) {
  console.error(`check-bundle-boundaries: ${message}`);
  for (const row of details) console.error(`- ${row}`);
  process.exit(1);
}

const bundles = readAppBundleSources(SITE_ROOT);
if (!bundles.extraSource) {
  console.log("check-bundle-boundaries: single bundle mode");
  process.exit(0);
}

const bootDecls = collectFunctionDeclarations(bundles.bootSource);
const extraDecls = collectFunctionDeclarations(bundles.extraSource);
const bootCalls = collectFunctionCalls(bundles.bootSource);

const missingBootSymbols = REQUIRED_BOOT_SYMBOLS.filter((name) => !bootDecls.has(name));
if (missingBootSymbols.length) {
  fail("required boot symbols are missing from the boot bundle", missingBootSymbols);
}

const unexpectedBootToExtra = [...bootCalls]
  .filter((name) => extraDecls.has(name))
  .filter((name) => !ALLOWED_BOOT_TO_EXTRA_CALLS.has(name))
  .sort();

if (unexpectedBootToExtra.length) {
  fail(
    "boot bundle calls functions that are only declared in the extra bundle",
    unexpectedBootToExtra.map((name) => `${name} (bootFiles=${bundles.bootFiles.join(", ")})`)
  );
}

const staleAllowEntries = [...ALLOWED_BOOT_TO_EXTRA_CALLS]
  .filter((name) => !extraDecls.has(name))
  .sort();

if (staleAllowEntries.length) {
  fail("allowlisted boot-to-extra calls are no longer declared in extra source", staleAllowEntries);
}

console.log(
  `check-bundle-boundaries: ok (bootFunctions=${bootDecls.size}, extraFunctions=${extraDecls.size}, allowedBootToExtra=${ALLOWED_BOOT_TO_EXTRA_CALLS.size})`
);

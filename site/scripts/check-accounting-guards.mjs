#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAppSource } from "./lib/app-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const js = readAppSource(SITE_ROOT).source;
const FUNCTION_START_RE = /^(?:async\s+function|function)\s+([A-Za-z0-9_]+)\s*\(/gm;

const functions = [];
for (const match of js.matchAll(FUNCTION_START_RE)) {
  functions.push({ name: match[1], index: match.index ?? 0 });
}

function extractFunctionSource(name) {
  const idx = functions.findIndex((row) => row.name === name);
  if (idx < 0) throw new Error(`Missing function ${name}`);
  const start = functions[idx].index;
  const end = idx + 1 < functions.length ? functions[idx + 1].index : js.length;
  return js.slice(start, end);
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

const issues = [];

const exactPricingFunctions = [
  "resolveWalletBalancePriceInfo",
  "buildDefiFlowFromTxs",
  "fetchRecentStablecoinFlowsSample",
  "fetchSuilendPositions",
  "fetchNaviPositions",
  "fetchAlphaPositions",
  "fetchScallopPositions",
  "fetchCetusPositions",
  "fetchTurbosPositions",
  "fetchBluefinSpotPositions",
  "renderTransfers",
];

for (const name of exactPricingFunctions) {
  const source = extractFunctionSource(name);
  if (!hasAny(source, [/getDefiUsdPrice\(/, /priceAmountUsd\(/])) {
    issues.push(`${name}: missing exact-price helper usage`);
  }
  if (/defiPrices(?:\[|\.)/.test(source)) {
    issues.push(`${name}: direct defiPrices access is disallowed here`);
  }
}

const aftermathSource = extractFunctionSource("fetchAftermathPerpsPositions");
if (!/economicAccounts\s*=\s*accounts\.filter\(/.test(aftermathSource)) {
  issues.push("fetchAftermathPerpsPositions: missing economic account filtering");
}
if (!/fetchAftermathPositionStates\(economicAccounts,\s*marketRows\)/.test(aftermathSource)) {
  issues.push("fetchAftermathPerpsPositions: positions must be derived from economic accounts only");
}
if (!/allAccountIds\s*=\s*new Set\(economicAccounts\.map/.test(aftermathSource)) {
  issues.push("fetchAftermathPerpsPositions: order enrichment must use economic accounts only");
}

if (!/function buildAddressDefiAdapters\(/.test(js)) {
  issues.push("missing buildAddressDefiAdapters helper");
}
if (!/function resolveAddressDefiAdapterResult\(/.test(js)) {
  issues.push("missing resolveAddressDefiAdapterResult helper");
}
if (!/function collectDefiAccountingWarnings\(/.test(js)) {
  issues.push("missing collectDefiAccountingWarnings helper");
}
if (!/loadAddressDefiAdapters\(addrNorm(?:\s*,[^)]*)?\)/.test(js)) {
  issues.push("loadDefi must fetch protocol data through loadAddressDefiAdapters");
}
const aftermathAccountingSource = extractFunctionSource("validateAftermathPerpsAccounting");
if (!/idleCollateral/.test(aftermathAccountingSource) || !/allocatedCollateral/.test(aftermathAccountingSource) || !/collateral/.test(aftermathAccountingSource)) {
  issues.push("validateAftermathPerpsAccounting: missing collateral split invariant");
}

if (issues.length) {
  console.error("check-accounting-guards: failed");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(`check-accounting-guards: ok (${exactPricingFunctions.length} function guards)`);

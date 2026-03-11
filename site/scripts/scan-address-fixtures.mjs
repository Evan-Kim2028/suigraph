#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS, withStaticSitePage } from "./lib/browser-smoke.mjs";
import {
  collectAddressDefiIssues,
  collectAddressDefiSnapshot,
  normalizeRouteAddress,
  toggleAddressWalletFilterAndMeasure,
} from "./lib/address-defi-smoke.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const DIST_ROOT = resolve(SITE_ROOT, "dist");
const DEFAULT_MANIFEST_PATH = resolve(SITE_ROOT, "fixtures/address-fixtures.json");
const DEFAULT_SITE_PORT_BASE = 4180;
const DEFAULT_CDP_PORT_BASE = 9230;

function parseArgs(argv) {
  const opts = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    chromeBin: process.env.CHROME_BIN || "google-chrome",
    sitePortBase: DEFAULT_SITE_PORT_BASE,
    cdpPortBase: DEFAULT_CDP_PORT_BASE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    tiers: [],
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--manifest") {
      opts.manifestPath = resolve(process.cwd(), String(argv[i + 1] || "").trim());
      i += 1;
    } else if (arg === "--chrome") {
      opts.chromeBin = String(argv[i + 1] || "").trim() || opts.chromeBin;
      i += 1;
    } else if (arg === "--site-port-base") {
      opts.sitePortBase = Math.max(1, Number(argv[i + 1] || opts.sitePortBase));
      i += 1;
    } else if (arg === "--cdp-port-base") {
      opts.cdpPortBase = Math.max(1, Number(argv[i + 1] || opts.cdpPortBase));
      i += 1;
    } else if (arg === "--timeout-ms") {
      opts.timeoutMs = Math.max(1000, Number(argv[i + 1] || opts.timeoutMs));
      i += 1;
    } else if (arg === "--tier") {
      const tier = String(argv[i + 1] || "").trim().toLowerCase();
      if (tier) opts.tiers.push(tier);
      i += 1;
    } else if (arg === "--json") {
      opts.json = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log([
    "Usage: node scripts/scan-address-fixtures.mjs [options]",
    "",
    "Scans the address fixture manifest and reports which fixtures are active vs stale.",
    "Required fixtures fail the process if their checks do not pass; candidate fixtures are informational.",
    "",
    "Options:",
    `  --manifest <path>          Fixture manifest path (default: ${DEFAULT_MANIFEST_PATH})`,
    "  --chrome <path>            Chrome/Chromium binary to launch",
    `  --site-port-base <port>    Base local static server port (default: ${DEFAULT_SITE_PORT_BASE})`,
    `  --cdp-port-base <port>     Base Chrome DevTools port (default: ${DEFAULT_CDP_PORT_BASE})`,
    `  --timeout-ms <ms>          Per-fixture timeout budget (default: ${DEFAULT_TIMEOUT_MS})`,
    "  --tier <name>              Restrict scan to matching fixture tier; may be repeated",
    "  --json                     Emit JSON instead of human-readable output",
    "  -h, --help                 Show help",
  ].join("\n"));
}

function loadManifest(manifestPath) {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fixtures = Array.isArray(raw?.fixtures) ? raw.fixtures : [];
  if (!fixtures.length) {
    throw new Error(`Fixture manifest has no fixtures: ${manifestPath}`);
  }
  return fixtures;
}

function summarizeFixtureStatus(result) {
  if (result.issues.length === 0) return "active";
  if (result.snapshot?.hasNoPositions) return "stale";
  if (!result.snapshot?.hasWalletSection && !(result.snapshot?.stats || []).length) return "stale";
  return "partial";
}

async function scanFixture(fixture, index, opts) {
  const address = normalizeRouteAddress(fixture?.address);
  if (!address) {
    return {
      id: fixture?.id || `fixture_${index + 1}`,
      tier: fixture?.tier || "candidate",
      lifecycle: fixture?.lifecycle || "unknown",
      ownership: fixture?.ownership || "unknown",
      address: fixture?.address || "",
      source: fixture?.source || "",
      notes: fixture?.notes || "",
      protocols: Array.isArray(fixture?.protocols) ? fixture.protocols : [],
      snapshot: null,
      hiddenByFilter: 0,
      issues: ["Invalid fixture address"],
      status: "invalid",
    };
  }

  const sitePort = opts.sitePortBase + index;
  const cdpPort = opts.cdpPortBase + index;
  const targetUrl = `http://127.0.0.1:${sitePort}/#/address/${address}`;
  let snapshot = null;
  let hiddenByFilter = 0;
  let issues = [];
  try {
    snapshot = await withStaticSitePage({
      distRoot: DIST_ROOT,
      chromeBin: opts.chromeBin,
      sitePort,
      cdpPort,
      timeoutMs: opts.timeoutMs,
      targetUrl,
      fallbackContains: "/#/address/",
      profilePrefix: "suigraph-fixture-",
    }, async ({ client }) => {
      const nextSnapshot = await collectAddressDefiSnapshot(client, opts.timeoutMs);
      if (fixture?.check?.expectFilterHides) {
        hiddenByFilter = await toggleAddressWalletFilterAndMeasure(client, Math.max(5000, Math.floor(opts.timeoutMs / 2)));
      }
      return nextSnapshot;
    });
    issues = collectAddressDefiIssues(snapshot, fixture?.check || {});
  } catch (err) {
    issues = [err?.message || String(err)];
  }

  const result = {
    id: fixture?.id || `fixture_${index + 1}`,
    tier: fixture?.tier || "candidate",
    lifecycle: fixture?.lifecycle || "unknown",
    ownership: fixture?.ownership || "unknown",
    address,
    source: fixture?.source || "",
    notes: fixture?.notes || "",
    protocols: Array.isArray(fixture?.protocols) ? fixture.protocols : [],
    snapshot,
    hiddenByFilter,
    issues,
  };
  result.status = summarizeFixtureStatus(result);
  return result;
}

function printHuman(results) {
  const required = results.filter((result) => result.tier === "required");
  const failedRequired = required.filter((result) => result.issues.length > 0);
  console.log(`address-fixtures: required ${required.length - failedRequired.length}/${required.length} active`);
  for (const result of results) {
    const stats = (result.snapshot?.stats || []).join(", ") || "none";
    const issueText = result.issues.length ? result.issues.join(" | ") : "ok";
    const suffix = result.hiddenByFilter > 0 ? ` | filter hides ${result.hiddenByFilter}` : "";
    console.log(`- [${result.tier}] ${result.id}: ${result.status} | ${result.address} | stats: ${stats}${suffix} | ${issueText}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  printHelp();
  process.exit(0);
}

const fixtures = loadManifest(opts.manifestPath).filter((fixture) => {
  if (!opts.tiers.length) return true;
  const tier = String(fixture?.tier || "candidate").trim().toLowerCase();
  return opts.tiers.includes(tier);
});
if (!fixtures.length) {
  throw new Error(`No fixtures matched tier filter: ${opts.tiers.join(", ")}`);
}
const results = [];
for (let i = 0; i < fixtures.length; i += 1) {
  results.push(await scanFixture(fixtures[i], i, opts));
}

const failedRequired = results.filter((result) => result.tier === "required" && result.issues.length > 0);
if (opts.json) {
  console.log(JSON.stringify({
    scannedAt: new Date().toISOString(),
    manifestPath: opts.manifestPath,
    results,
    failedRequired: failedRequired.map((result) => result.id),
  }, null, 2));
} else {
  printHuman(results);
}

if (failedRequired.length) process.exitCode = 1;

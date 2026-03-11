#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS, waitForCondition, withStaticSitePage } from "./lib/browser-smoke.mjs";
import {
  collectAddressDefiIssues,
  collectAddressDefiSnapshot,
} from "./lib/address-defi-smoke.mjs";
import {
  collectPerfIssues,
  waitForBodyTexts,
  waitForPerfSettled,
} from "./lib/page-perf-smoke.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const DIST_ROOT = resolve(SITE_ROOT, "dist");
const FIXTURES_PATH = resolve(SITE_ROOT, "fixtures/address-fixtures.json");
const DEFAULT_SITE_PORT = 4173;
const DEFAULT_CDP_PORT_BASE = 9222;
const DEFAULT_SETTLE_MS = 1250;

function parseArgs(argv) {
  const options = {
    chromeBin: process.env.CHROME_BIN || "google-chrome",
    sitePort: DEFAULT_SITE_PORT,
    cdpPortBase: DEFAULT_CDP_PORT_BASE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    settleMs: DEFAULT_SETTLE_MS,
    strictRender: false,
    routeIds: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--chrome") {
      options.chromeBin = String(argv[i + 1] || "").trim() || options.chromeBin;
      i += 1;
    } else if (arg === "--site-port") {
      options.sitePort = Math.max(1, Number(argv[i + 1] || options.sitePort));
      i += 1;
    } else if (arg === "--cdp-port-base") {
      options.cdpPortBase = Math.max(1, Number(argv[i + 1] || options.cdpPortBase));
      i += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Math.max(1000, Number(argv[i + 1] || options.timeoutMs));
      i += 1;
    } else if (arg === "--settle-ms") {
      options.settleMs = Math.max(250, Number(argv[i + 1] || options.settleMs));
      i += 1;
    } else if (arg === "--strict-render") {
      options.strictRender = true;
    } else if (arg === "--route") {
      const value = String(argv[i + 1] || "").trim();
      if (value) options.routeIds.push(value);
      i += 1;
    }
  }
  return options;
}

function printHelp() {
  console.log([
    "Usage: node scripts/check-route-perf.mjs [options]",
    "",
    "Runs browser-backed local route checks and fails when perf badge GraphQL budgets regress.",
    "",
    "Options:",
    "  --chrome <path>            Chrome/Chromium binary to launch",
    `  --site-port <port>         Local static server port (default: ${DEFAULT_SITE_PORT})`,
    `  --cdp-port-base <port>     Base Chrome DevTools port (default: ${DEFAULT_CDP_PORT_BASE})`,
    `  --timeout-ms <ms>          End-to-end timeout budget (default: ${DEFAULT_TIMEOUT_MS})`,
    `  --settle-ms <ms>           Perf stabilization window (default: ${DEFAULT_SETTLE_MS})`,
    "  --route <id>               Limit checks to a route id (repeatable: address, defi-overview)",
    "  --strict-render            Fail on render-budget warnings as well as GraphQL-budget warnings",
    "  -h, --help                 Show help",
  ].join("\n"));
}

function loadFixtures() {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
}

function getFixtureAddress(fixtures, id) {
  const fixture = (fixtures.fixtures || []).find((entry) => entry.id === id);
  if (!fixture?.address) {
    throw new Error(`Missing fixture address for ${id}`);
  }
  return fixture.address;
}

function routeSpecs(fixtures) {
  const broadAddress = getFixtureAddress(fixtures, "broad_integration_smoke");
  return [
    {
      id: "address",
      targetUrl: (sitePort) => `http://127.0.0.1:${sitePort}/#/address/${broadAddress}`,
      fallbackContains: "/#/address/",
      async load(client, timeoutMs) {
        const snapshot = await collectAddressDefiSnapshot(client, timeoutMs);
        const issues = collectAddressDefiIssues(snapshot, {
          requiredTexts: ["Wallet Holdings", "Protocol-supported only", "Aftermath Perpetuals"],
          requireWalletSection: true,
          requireProtocolFilter: true,
          requireCoinLinks: true,
          requireStats: true,
          allowAccountingWarnings: false,
        });
        return { snapshot, issues };
      },
    },
    {
      id: "defi-overview",
      targetUrl: (sitePort) => `http://127.0.0.1:${sitePort}/#/defi-overview`,
      fallbackContains: "/#/defi-overview",
      async load(client, timeoutMs) {
        await waitForBodyTexts(client, ["DeFi Overview", "Top Protocol Activity"], timeoutMs, "DeFi overview content");
        await waitForCondition(
          client,
          "(() => { const text = document.body?.innerText || ''; return !text.includes('Error loading page:'); })()",
          timeoutMs,
          "DeFi overview error-free shell"
        );
        return { snapshot: null, issues: [] };
      },
    },
  ];
}

async function runRouteCheck(route, opts, index) {
  const sitePort = opts.sitePort + index;
  const cdpPort = opts.cdpPortBase + index;
  const targetUrl = route.targetUrl(sitePort);
  return withStaticSitePage({
    distRoot: DIST_ROOT,
    chromeBin: opts.chromeBin,
    sitePort,
    cdpPort,
    timeoutMs: opts.timeoutMs,
    targetUrl,
    fallbackContains: route.fallbackContains,
    profilePrefix: `suigraph-perf-${route.id}-`,
  }, async ({ client }) => {
    const loaded = await route.load(client, opts.timeoutMs);
    const perf = await waitForPerfSettled(client, opts.timeoutMs, opts.settleMs);
    const perfIssues = collectPerfIssues(perf, { strictRender: opts.strictRender });
    return {
      routeId: route.id,
      perf,
      issues: [...(loaded.issues || []), ...perfIssues],
    };
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const fixtures = loadFixtures();
  const allRoutes = routeSpecs(fixtures);
  const allowedIds = new Set(allRoutes.map((route) => route.id));
  const requestedIds = opts.routeIds.length ? opts.routeIds : [...allowedIds];
  const unknown = requestedIds.filter((id) => !allowedIds.has(id));
  if (unknown.length) {
    console.error(`Unknown route id(s): ${unknown.join(", ")}`);
    process.exit(1);
  }

  const routes = allRoutes.filter((route) => requestedIds.includes(route.id));
  const failures = [];

  for (const [index, route] of routes.entries()) {
    try {
      const result = await runRouteCheck(route, opts, index);
      if (result.issues.length) {
        throw new Error(result.issues.join(" | "));
      }
      const render = result.perf.rows.Render?.value || "—";
      const gqlCalls = result.perf.rows["GQL calls"]?.value || "—";
      const gqlBudget = result.perf.rows["GQL calls"]?.sub || "";
      const topQuery = result.perf.topQuery || "—";
      console.log(`route-perf: ok (${route.id})`);
      console.log(`perf: ${render} • gql ${gqlCalls}${gqlBudget ? ` (${gqlBudget})` : ""} • top ${topQuery}`);
    } catch (err) {
      const message = err?.message || String(err);
      failures.push({ routeId: route.id, message });
      console.error(`route-perf: failed (${route.id})`);
      console.error(message);
    }
  }

  if (failures.length) {
    process.exitCode = 1;
  }
}

await main();

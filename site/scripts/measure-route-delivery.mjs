#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TIMEOUT_MS,
  connectCdp,
  evaluate,
  waitForCondition,
  waitForPageTarget,
  withStaticSitePage,
} from "./lib/browser-smoke.mjs";
import { collectAddressDefiSnapshot } from "./lib/address-defi-smoke.mjs";
import { waitForBodyTexts, waitForPerfSettled } from "./lib/page-perf-smoke.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const DIST_ROOT = resolve(SITE_ROOT, "dist");
const FIXTURES_PATH = resolve(SITE_ROOT, "fixtures/address-fixtures.json");
const DEFAULT_SITE_PORT = 4173;
const DEFAULT_CDP_PORT = 9222;
const DEFAULT_WALRUS_ORIGIN = "https://suigraph-explorer.wal.app";
const DEFAULT_OBJECT_ID = "0x2";
const DEFAULT_COIN_TYPE = "0x2::sui::SUI";

function parseArgs(argv) {
  const opts = {
    routeId: "address",
    live: false,
    chromeBin: process.env.CHROME_BIN || "google-chrome",
    sitePort: DEFAULT_SITE_PORT,
    cdpPort: DEFAULT_CDP_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    walrusOrigin: DEFAULT_WALRUS_ORIGIN,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--route") {
      opts.routeId = String(argv[i + 1] || "").trim() || opts.routeId;
      i += 1;
    } else if (arg === "--live") {
      opts.live = true;
    } else if (arg === "--chrome") {
      opts.chromeBin = String(argv[i + 1] || "").trim() || opts.chromeBin;
      i += 1;
    } else if (arg === "--site-port") {
      opts.sitePort = Math.max(1, Number(argv[i + 1] || opts.sitePort));
      i += 1;
    } else if (arg === "--cdp-port") {
      opts.cdpPort = Math.max(1, Number(argv[i + 1] || opts.cdpPort));
      i += 1;
    } else if (arg === "--timeout-ms") {
      opts.timeoutMs = Math.max(1000, Number(argv[i + 1] || opts.timeoutMs));
      i += 1;
    } else if (arg === "--walrus-origin") {
      opts.walrusOrigin = String(argv[i + 1] || "").trim() || opts.walrusOrigin;
      i += 1;
    }
  }
  return opts;
}

function printHelp() {
  console.log([
    "Usage: node scripts/measure-route-delivery.mjs [options]",
    "",
    "Measures route render/perf badge timings and asset delivery for either the local dist build or the live Walrus site.",
    "",
    "Options:",
    "  --route <id>             Route preset: address, object, coin",
    "  --live                   Target the live Walrus site instead of local dist",
    "  --chrome <path>          Chrome/Chromium binary to launch",
    `  --site-port <port>       Local static server port (default: ${DEFAULT_SITE_PORT})`,
    `  --cdp-port <port>        Chrome DevTools port (default: ${DEFAULT_CDP_PORT})`,
    `  --timeout-ms <ms>        End-to-end timeout budget (default: ${DEFAULT_TIMEOUT_MS})`,
    `  --walrus-origin <url>    Live site origin (default: ${DEFAULT_WALRUS_ORIGIN})`,
    "  -h, --help               Show help",
  ].join("\n"));
}

function loadFixtures() {
  return JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
}

function getFixtureAddress(fixtures, id) {
  const fixture = (fixtures.fixtures || []).find((entry) => entry.id === id);
  if (!fixture?.address) throw new Error(`Missing fixture ${id}`);
  return fixture.address;
}

function buildRoutePresets(fixtures) {
  const address = getFixtureAddress(fixtures, "broad_integration_smoke");
  return {
    address: {
      hashPath: `#/address/${address}`,
      async load(client, timeoutMs) {
        await collectAddressDefiSnapshot(client, timeoutMs);
      },
    },
    object: {
      hashPath: `#/object/${DEFAULT_OBJECT_ID}`,
      async load(client, timeoutMs) {
        await waitForBodyTexts(client, ["Object ID", "Modules"], timeoutMs, "object detail");
        await waitForNoErrorShell(client, timeoutMs);
      },
    },
    coin: {
      hashPath: `#/coin?type=${encodeURIComponent(DEFAULT_COIN_TYPE)}&scan=0&supply=1`,
      async load(client, timeoutMs) {
        await waitForBodyTexts(client, ["Coin Search", "Coin Overview"], timeoutMs, "coin search");
        await waitForNoErrorShell(client, timeoutMs);
      },
    },
  };
}

async function waitForNoErrorShell(client, timeoutMs) {
  await waitForCondition(
    client,
    "(() => { const text = document.body?.innerText || ''; return !text.includes('Error loading page:'); })()",
    timeoutMs,
    "error-free route shell"
  );
}

async function captureRouteMetrics(client) {
  const perf = await waitForPerfSettled(client, DEFAULT_TIMEOUT_MS, 1250);
  const metrics = await evaluate(client, `(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource')
      .map((r) => ({
        name: r.name,
        initiatorType: r.initiatorType,
        duration: Math.round(r.duration),
        transferSize: Number(r.transferSize || 0),
        encodedBodySize: Number(r.encodedBodySize || 0),
        startTime: Math.round(r.startTime),
        responseEnd: Math.round(r.responseEnd),
      }))
      .sort((a, b) => b.duration - a.duration);
    return {
      nav: nav ? {
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        load: Math.round(nav.loadEventEnd),
        responseEnd: Math.round(nav.responseEnd),
      } : null,
      resources,
      href: location.href,
    };
  })()`);
  return {
    perf,
    nav: metrics.nav,
    href: metrics.href,
    resources: metrics.resources.filter((row) =>
      row.name.includes("/assets/")
      || row.name.includes("graphql.mainnet.sui.io")
      || row.name.endsWith("/favicon.ico")
    ),
  };
}

async function withLivePage({ chromeBin, cdpPort, timeoutMs, targetUrl, fallbackContains }, run) {
  const profileDir = await fs.mkdtemp(join(tmpdir(), "suigraph-live-route-"));
  let chrome = null;
  let client = null;
  try {
    chrome = spawn(chromeBin, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      targetUrl,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const target = await waitForPageTarget(cdpPort, targetUrl, timeoutMs, fallbackContains);
    client = await connectCdp(target.webSocketDebuggerUrl, timeoutMs);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await waitForCondition(client, "document.readyState === 'complete'", timeoutMs, "document ready");
    return await run({ client, target });
  } finally {
    await client?.close().catch(() => {});
    try { chrome?.kill("SIGTERM"); } catch (_) {}
    await new Promise((resolvePromise) => chrome ? chrome.once("exit", () => resolvePromise()) : resolvePromise());
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function measureRoute(opts, preset) {
  const targetUrl = opts.live
    ? `${opts.walrusOrigin.replace(/\/+$/u, "")}/${preset.hashPath}`
    : `http://127.0.0.1:${opts.sitePort}/${preset.hashPath}`;
  const fallbackContains = preset.hashPath.split("?")[0];
  if (opts.live) {
    return withLivePage({
      chromeBin: opts.chromeBin,
      cdpPort: opts.cdpPort,
      timeoutMs: opts.timeoutMs,
      targetUrl,
      fallbackContains,
    }, async ({ client }) => {
      await preset.load(client, opts.timeoutMs);
      return captureRouteMetrics(client);
    });
  }
  return withStaticSitePage({
    distRoot: DIST_ROOT,
    chromeBin: opts.chromeBin,
    sitePort: opts.sitePort,
    cdpPort: opts.cdpPort,
    timeoutMs: opts.timeoutMs,
    targetUrl,
    fallbackContains,
    profilePrefix: `suigraph-route-${opts.routeId}-`,
  }, async ({ client }) => {
    await preset.load(client, opts.timeoutMs);
    return captureRouteMetrics(client);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const fixtures = loadFixtures();
  const presets = buildRoutePresets(fixtures);
  const preset = presets[opts.routeId];
  if (!preset) {
    console.error(`Unknown route preset: ${opts.routeId}`);
    process.exit(1);
  }

  const result = await measureRoute(opts, preset);
  console.log(JSON.stringify({
    route: opts.routeId,
    mode: opts.live ? "live" : "local",
    href: result.href,
    perf: result.perf,
    nav: result.nav,
    resources: result.resources,
  }, null, 2));
}

await main();

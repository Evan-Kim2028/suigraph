#!/usr/bin/env node

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
const DEFAULT_ADDRESS = "0x1eb7c57e3f2bd0fc6cb9dcffd143ea957e4d98f805c358733f76dee0667fe0b1";
const DEFAULT_EXPECT_TEXT = ["Wallet Holdings", "Protocol-supported only"];
const DEFAULT_SITE_PORT = 4173;
const DEFAULT_CDP_PORT = 9222;

function parseArgs(argv) {
  const opts = {
    address: DEFAULT_ADDRESS,
    expectText: [...DEFAULT_EXPECT_TEXT],
    expectFilterHides: false,
    chromeBin: process.env.CHROME_BIN || "google-chrome",
    sitePort: DEFAULT_SITE_PORT,
    cdpPort: DEFAULT_CDP_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--address") {
      opts.address = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--expect-text") {
      const value = String(argv[i + 1] || "").trim();
      if (value) opts.expectText.push(value);
      i += 1;
    } else if (arg === "--expect-filter-hides") {
      opts.expectFilterHides = true;
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
    }
  }
  return opts;
}

function printHelp() {
  console.log([
    "Usage: node scripts/smoke-address-defi.mjs [options]",
    "",
    "Options:",
    `  --address <addr>            Address route to inspect (default: ${DEFAULT_ADDRESS})`,
    "  --expect-text <text>        Require rendered page text to include this string (repeatable)",
    "  --expect-filter-hides       Toggle the wallet protocol filter and require a hiding summary",
    "  --chrome <path>             Chrome/Chromium binary to launch",
    `  --site-port <port>          Local static server port (default: ${DEFAULT_SITE_PORT})`,
    `  --cdp-port <port>           Chrome DevTools port (default: ${DEFAULT_CDP_PORT})`,
    `  --timeout-ms <ms>           End-to-end timeout budget (default: ${DEFAULT_TIMEOUT_MS})`,
    "  -h, --help                  Show help",
  ].join("\n"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const address = normalizeRouteAddress(opts.address);
  if (!address) {
    console.error(`Invalid address: ${opts.address}`);
    process.exit(1);
  }
  const targetUrl = `http://127.0.0.1:${opts.sitePort}/#/address/${address}`;
  let lastSnapshot = null;
  let hiddenByFilter = 0;
  try {
    const snapshot = await withStaticSitePage({
      distRoot: DIST_ROOT,
      chromeBin: opts.chromeBin,
      sitePort: opts.sitePort,
      cdpPort: opts.cdpPort,
      timeoutMs: opts.timeoutMs,
      targetUrl,
      fallbackContains: "/#/address/",
    }, async ({ client }) => {
      const nextSnapshot = await collectAddressDefiSnapshot(client, opts.timeoutMs);
      if (opts.expectFilterHides) {
        hiddenByFilter = await toggleAddressWalletFilterAndMeasure(client, Math.max(5000, Math.floor(opts.timeoutMs / 2)));
      }
      return nextSnapshot;
    });
    lastSnapshot = snapshot;

    const issues = collectAddressDefiIssues(snapshot, {
      requiredTexts: opts.expectText,
      requireWalletSection: true,
      requireProtocolFilter: true,
      requireCoinLinks: true,
      requireStats: true,
      allowAccountingWarnings: false,
    });
    if (issues.length) throw new Error(issues.join(" | "));

    const statSummary = Array.isArray(snapshot?.stats) ? snapshot.stats.join(", ") : "";
    console.log(`smoke-address-defi: ok (${address})`);
    console.log(`stats: ${statSummary}`);
    console.log(`wallet coin links: ${snapshot.walletLinkCount}`);
    if (hiddenByFilter > 0) console.log(`wallet filter hides: ${hiddenByFilter}`);
  } catch (err) {
    console.error(`smoke-address-defi: failed (${address})`);
    console.error(err?.message || String(err));
    if (lastSnapshot) {
      console.error(`stats: ${(lastSnapshot.stats || []).join(", ") || "none"}`);
      console.error(`body excerpt: ${String(lastSnapshot.bodyText || "").slice(0, 400).replace(/\s+/g, " ")}`);
    }
    process.exitCode = 1;
  }
}

await main();

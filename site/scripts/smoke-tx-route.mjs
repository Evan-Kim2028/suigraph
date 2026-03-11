#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TIMEOUT_MS, evaluate, waitForCondition, withStaticSitePage } from "./lib/browser-smoke.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const DIST_ROOT = resolve(SITE_ROOT, "dist");
const DEFAULT_DIGEST = "FKUcbXh5xviJLqfM5UXeh5DDvX61FrRyaLc6pJV1gq96";
const DEFAULT_EXPECT_TEXT = ["Execution Overview", "Balance Flow Matrix", "Event Outcomes"];
const DEFAULT_SITE_PORT = 4174;
const DEFAULT_CDP_PORT = 9223;

function parseArgs(argv) {
  const opts = {
    digest: DEFAULT_DIGEST,
    expectText: [...DEFAULT_EXPECT_TEXT],
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
    } else if (arg === "--digest") {
      opts.digest = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (arg === "--expect-text") {
      const value = String(argv[i + 1] || "").trim();
      if (value) opts.expectText.push(value);
      i += 1;
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
    "Usage: node scripts/smoke-tx-route.mjs [options]",
    "",
    "Options:",
    `  --digest <digest>           Transaction digest to inspect (default: ${DEFAULT_DIGEST})`,
    "  --expect-text <text>        Require rendered page text to include this string (repeatable)",
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

  if (!opts.digest) {
    console.error("Missing tx digest");
    process.exit(1);
  }
  const targetUrl = `http://127.0.0.1:${opts.sitePort}/#/tx/${encodeURIComponent(opts.digest)}`;
  let lastSnapshot = null;
  try {
    const snapshot = await withStaticSitePage({
      distRoot: DIST_ROOT,
      chromeBin: opts.chromeBin,
      sitePort: opts.sitePort,
      cdpPort: opts.cdpPort,
      timeoutMs: opts.timeoutMs,
      targetUrl,
      fallbackContains: "/#/tx/",
      profilePrefix: "suigraph-smoke-tx-",
    }, async ({ client }) => {
      await waitForCondition(
        client,
        "(() => { const text = document.body.innerText || ''; return text.includes('Execution Overview') || text.includes('Error loading page:'); })()",
        opts.timeoutMs,
        "tx detail content"
      );
      return evaluate(client, `(() => {
        const bodyText = document.body.innerText || "";
        const headers = Array.from(document.querySelectorAll('.card-header')).map((el) => el.textContent.trim()).filter(Boolean);
        return {
          bodyText,
          hasError: bodyText.includes("Error loading page:"),
          headers,
        };
      })()`);
    });
    lastSnapshot = snapshot;

    if (snapshot?.hasError) throw new Error("Tx route rendered an error shell");
    for (const text of opts.expectText) {
      if (text && !String(snapshot?.bodyText || "").includes(text)) {
        throw new Error(`Expected rendered text missing: ${text}`);
      }
    }

    console.log(`smoke-tx-route: ok (${opts.digest})`);
    console.log(`headers: ${(snapshot?.headers || []).join(", ")}`);
  } catch (err) {
    console.error(`smoke-tx-route: failed (${opts.digest})`);
    console.error(err?.message || String(err));
    if (lastSnapshot) {
      console.error(`headers: ${(lastSnapshot.headers || []).join(", ") || "none"}`);
      console.error(`body excerpt: ${String(lastSnapshot.bodyText || "").slice(0, 400).replace(/\s+/g, " ")}`);
    }
    process.exitCode = 1;
  }
}

await main();

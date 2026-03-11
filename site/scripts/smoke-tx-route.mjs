#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const DIST_ROOT = resolve(SITE_ROOT, "dist");
const DEFAULT_DIGEST = "FKUcbXh5xviJLqfM5UXeh5DDvX61FrRyaLc6pJV1gq96";
const DEFAULT_EXPECT_TEXT = ["Execution Overview", "Balance Flow Matrix", "Event Outcomes"];
const DEFAULT_SITE_PORT = 4174;
const DEFAULT_CDP_PORT = 9223;
const DEFAULT_TIMEOUT_MS = 45000;

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

function mimeTypeFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

async function startStaticServer(root, port) {
  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const relPath = decodeURIComponent(reqUrl.pathname || "/");
      const safePath = relPath === "/" ? "/index.html" : relPath;
      const filePath = normalize(join(root, safePath));
      if (!filePath.startsWith(root)) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      const bytes = await fs.readFile(filePath);
      res.setHeader("Content-Type", mimeTypeFor(filePath));
      res.setHeader("Cache-Control", "no-cache");
      res.end(bytes);
    } catch (_) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
  return server;
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(150);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForPageTarget(cdpPort, targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const targets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`, Math.max(500, timeoutMs));
    lastTargets = Array.isArray(targets) ? targets : [];
    const exact = lastTargets.find((target) =>
      target?.type === "page" && String(target?.url || "") === targetUrl && target?.webSocketDebuggerUrl);
    if (exact) return exact;
    const fallback = lastTargets.find((target) =>
      target?.type === "page"
      && String(target?.url || "").includes("/#/tx/")
      && target?.webSocketDebuggerUrl);
    if (fallback) return fallback;
    await delay(150);
  }
  throw new Error(`Timed out waiting for page target. Last targets: ${lastTargets.map((t) => t?.url || "?").join(", ")}`);
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data || "")); } catch (_) { return; }
      if (!msg || typeof msg.id !== "number") return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || "CDP error"));
      else pending.resolve(msg.result || {});
    });
    ws.addEventListener("close", () => {
      for (const [, pending] of this.pending.entries()) pending.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    try { this.ws.close(); } catch (_) {}
  }
}

async function connectCdp(wsUrl, timeoutMs) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("Timed out connecting to Chrome DevTools")), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      rejectPromise(new Error(event?.message || "Failed to connect to Chrome DevTools"));
    }, { once: true });
  });
  return new CdpClient(ws);
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  }
  return result?.result?.value;
}

async function waitForCondition(client, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await evaluate(client, expression);
    if (lastValue) return lastValue;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function killChild(proc) {
  if (!proc || proc.killed) return;
  try { proc.kill("SIGTERM"); } catch (_) {}
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
  if (!existsSync(DIST_ROOT)) {
    console.error(`Missing dist output: ${DIST_ROOT}`);
    process.exit(1);
  }

  const targetUrl = `http://127.0.0.1:${opts.sitePort}/#/tx/${encodeURIComponent(opts.digest)}`;
  const profileDir = await fs.mkdtemp(join(tmpdir(), "suigraph-smoke-tx-"));
  let server = null;
  let chrome = null;
  let client = null;
  let lastSnapshot = null;
  try {
    server = await startStaticServer(DIST_ROOT, opts.sitePort);
    chrome = spawn(opts.chromeBin, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${opts.cdpPort}`,
      `--user-data-dir=${profileDir}`,
      targetUrl,
    ], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let chromeStderr = "";
    chrome.stderr.on("data", (chunk) => {
      chromeStderr += String(chunk || "");
      if (chromeStderr.length > 4000) chromeStderr = chromeStderr.slice(-4000);
    });

    const target = await waitForPageTarget(opts.cdpPort, targetUrl, opts.timeoutMs);
    client = await connectCdp(target.webSocketDebuggerUrl, opts.timeoutMs);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await waitForCondition(client, "document.readyState === 'complete'", opts.timeoutMs, "document ready");
    await waitForCondition(
      client,
      "(() => { const text = document.body.innerText || ''; return text.includes('Execution Overview') || text.includes('Error loading page:'); })()",
      opts.timeoutMs,
      "tx detail content"
    );

    const snapshot = await evaluate(client, `(() => {
      const bodyText = document.body.innerText || "";
      const headers = Array.from(document.querySelectorAll('.card-header')).map((el) => el.textContent.trim()).filter(Boolean);
      return {
        bodyText,
        hasError: bodyText.includes("Error loading page:"),
        headers,
      };
    })()`);
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
  } finally {
    await client?.close().catch(() => {});
    killChild(chrome);
    await new Promise((resolvePromise) => chrome ? chrome.once("exit", () => resolvePromise()) : resolvePromise());
    await new Promise((resolvePromise, rejectPromise) => server ? server.close((err) => err ? rejectPromise(err) : resolvePromise()) : resolvePromise());
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

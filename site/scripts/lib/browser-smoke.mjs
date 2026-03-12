import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_TIMEOUT_MS = 45000;

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

export async function waitForPageTarget(cdpPort, targetUrl, timeoutMs, fallbackContains = "") {
  const deadline = Date.now() + timeoutMs;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const targets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`, Math.max(500, timeoutMs));
    lastTargets = Array.isArray(targets) ? targets : [];
    const exact = lastTargets.find((target) =>
      target?.type === "page" && String(target?.url || "") === targetUrl && target?.webSocketDebuggerUrl);
    if (exact) return exact;
    if (fallbackContains) {
      const fallback = lastTargets.find((target) =>
        target?.type === "page"
        && String(target?.url || "").includes(fallbackContains)
        && target?.webSocketDebuggerUrl);
      if (fallback) return fallback;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for page target. Last targets: ${lastTargets.map((target) => target?.url || "?").join(", ")}`);
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

export async function connectCdp(wsUrl, timeoutMs) {
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

export async function evaluate(client, expression) {
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

export async function waitForCondition(client, expression, timeoutMs, label) {
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

async function waitForChildExit(proc, timeoutMs = 2000) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return;
  const waitOnce = () => new Promise((resolvePromise) => {
    const onExit = () => {
      cleanup();
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(false);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      proc.off("close", onExit);
    };
    proc.once("exit", onExit);
    proc.once("close", onExit);
  });

  const exited = await waitOnce();
  if (exited || proc.exitCode != null || proc.signalCode != null) return;
  try { proc.kill("SIGKILL"); } catch (_) {}
  await waitOnce();
}

export async function withStaticSitePage({
  distRoot,
  chromeBin,
  sitePort,
  cdpPort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  targetUrl,
  fallbackContains = "",
  profilePrefix = "suigraph-smoke-",
}, run) {
  if (!existsSync(distRoot)) {
    throw new Error(`Missing dist output: ${distRoot}`);
  }

  const profileDir = await fs.mkdtemp(join(tmpdir(), profilePrefix));
  let server = null;
  let chrome = null;
  let client = null;
  let chromeStderr = "";
  try {
    server = await startStaticServer(distRoot, sitePort);
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

    chrome.stderr.on("data", (chunk) => {
      chromeStderr += String(chunk || "");
      if (chromeStderr.length > 4000) chromeStderr = chromeStderr.slice(-4000);
    });

    const target = await waitForPageTarget(cdpPort, targetUrl, timeoutMs, fallbackContains);
    client = await connectCdp(target.webSocketDebuggerUrl, timeoutMs);
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await waitForCondition(client, "document.readyState === 'complete'", timeoutMs, "document ready");

    return await run({ client, chromeStderr, target });
  } finally {
    await client?.close().catch(() => {});
    killChild(chrome);
    await waitForChildExit(chrome);
    await new Promise((resolvePromise, rejectPromise) => server ? server.close((err) => err ? rejectPromise(err) : resolvePromise()) : resolvePromise());
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

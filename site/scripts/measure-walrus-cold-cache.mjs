#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";
import { buildTargetUrl, getRoutePresets, measureRoute } from "./measure-route-delivery.mjs";

const DEFAULT_SAMPLE_COUNT = 3;
const DEFAULT_CDP_PORT_BASE = 9222;
const DEFAULT_DELAY_MS = 750;
const DEFAULT_TIMEOUT_MS = 45000;
const DEFAULT_WALRUS_ORIGIN = "https://suigraph-explorer.wal.app/";

function parseArgs(argv) {
  const opts = {
    routeIds: [],
    sampleCount: DEFAULT_SAMPLE_COUNT,
    chromeBin: process.env.CHROME_BIN || "google-chrome",
    cdpPortBase: DEFAULT_CDP_PORT_BASE,
    delayMs: DEFAULT_DELAY_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    walrusOrigin: DEFAULT_WALRUS_ORIGIN,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--route") {
      const value = String(argv[i + 1] || "").trim();
      if (value) opts.routeIds.push(value);
      i += 1;
    } else if (arg === "--samples") {
      opts.sampleCount = Math.max(1, Number(argv[i + 1] || opts.sampleCount));
      i += 1;
    } else if (arg === "--chrome") {
      opts.chromeBin = String(argv[i + 1] || "").trim() || opts.chromeBin;
      i += 1;
    } else if (arg === "--cdp-port-base") {
      opts.cdpPortBase = Math.max(1, Number(argv[i + 1] || opts.cdpPortBase));
      i += 1;
    } else if (arg === "--delay-ms") {
      opts.delayMs = Math.max(0, Number(argv[i + 1] || opts.delayMs));
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
    "Usage: node scripts/measure-walrus-cold-cache.mjs [options]",
    "",
    "Runs repeated live Walrus route measurements with fresh browser profiles and cache-busted entry URLs.",
    "",
    "Options:",
    "  --route <id>             Route preset to include (repeatable: address, object, coin)",
    `  --samples <n>            Samples per route (default: ${DEFAULT_SAMPLE_COUNT})`,
    "  --chrome <path>          Chrome/Chromium binary to launch",
    `  --cdp-port-base <port>   Base Chrome DevTools port (default: ${DEFAULT_CDP_PORT_BASE})`,
    `  --delay-ms <ms>          Delay between samples (default: ${DEFAULT_DELAY_MS})`,
    `  --timeout-ms <ms>        End-to-end timeout per sample (default: ${DEFAULT_TIMEOUT_MS})`,
    `  --walrus-origin <url>    Live site base URL (default: ${DEFAULT_WALRUS_ORIGIN})`,
    "  -h, --help               Show help",
  ].join("\n"));
}

function toMetricNumber(value) {
  const match = String(value || "").match(/-?\d+(?:\.\d+)?/u);
  return match ? Number(match[0]) : null;
}

function classifyResource(name) {
  if (name.includes("/assets/app.js")) return "app.js";
  if (name.includes("/assets/app-extra.js")) return "app-extra.js";
  if (name.includes("/assets/styles.css")) return "styles.css";
  if (name.includes("graphql.mainnet.sui.io")) return "graphql";
  return null;
}

function summarizeSeries(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 ? nums[mid] : Math.round((nums[mid - 1] + nums[mid]) / 2);
  const total = nums.reduce((sum, value) => sum + value, 0);
  return {
    count: nums.length,
    min: nums[0],
    median,
    max: nums[nums.length - 1],
    avg: Math.round(total / nums.length),
  };
}

function buildProbeOrigin(baseOrigin, routeId, sampleIndex) {
  const url = new URL(baseOrigin);
  if (!url.pathname) url.pathname = "/";
  url.hash = "";
  url.searchParams.set("_cold", `${Date.now()}-${routeId}-${sampleIndex}`);
  return url.toString();
}

function collectResourceStats(samples, label) {
  const values = [];
  for (const sample of samples) {
    const durations = sample.resourceDurations[label] || [];
    values.push(...durations);
  }
  return summarizeSeries(values);
}

function summarizeRoute(routeId, samples) {
  const successfulSamples = samples.filter((sample) => !sample.error);
  const renderMs = summarizeSeries(successfulSamples.map((sample) => sample.renderMs));
  const gqlCalls = summarizeSeries(successfulSamples.map((sample) => sample.gqlCalls));
  const navResponseEndMs = summarizeSeries(successfulSamples.map((sample) => sample.nav?.responseEnd ?? null));
  const navDomContentLoadedMs = summarizeSeries(successfulSamples.map((sample) => sample.nav?.domContentLoaded ?? null));
  const navLoadMs = summarizeSeries(successfulSamples.map((sample) => sample.nav?.load ?? null));
  const resourceStats = Object.fromEntries(
    ["app.js", "styles.css", "app-extra.js", "graphql"]
      .map((label) => [label, collectResourceStats(successfulSamples, label)])
      .filter(([, stats]) => stats)
  );
  const appExtraSamples = successfulSamples.filter((sample) => (sample.resourceDurations["app-extra.js"] || []).length > 0).length;
  const failures = samples
    .filter((sample) => sample.error)
    .map((sample) => ({
      sampleIndex: sample.sampleIndex,
      sampleNumber: sample.sampleNumber,
      error: sample.error,
    }));

  return {
    routeId,
    samples: samples.length,
    successes: successfulSamples.length,
    failures,
    renderMs,
    gqlCalls,
    navResponseEndMs,
    navDomContentLoadedMs,
    navLoadMs,
    resourceStats,
    appExtraSamples,
  };
}

async function runSample({ routeId, sampleIndex, sampleNumber, preset, opts, cdpPort }) {
  const walrusOrigin = buildProbeOrigin(opts.walrusOrigin, routeId, sampleNumber);
  const targetUrl = buildTargetUrl(walrusOrigin, preset.hashPath);
  try {
    const result = await measureRoute({
      routeId,
      live: true,
      chromeBin: opts.chromeBin,
      cdpPort,
      timeoutMs: opts.timeoutMs,
      walrusOrigin,
    }, preset);

    const resourceDurations = Object.create(null);
    for (const resource of result.resources || []) {
      const label = classifyResource(resource.name);
      if (!label) continue;
      if (!resourceDurations[label]) resourceDurations[label] = [];
      resourceDurations[label].push(resource.duration);
    }

    const sample = {
      sampleIndex,
      sampleNumber,
      targetUrl,
      href: result.href,
      renderMs: toMetricNumber(result.perf?.render),
      gqlCalls: toMetricNumber(result.perf?.gqlCalls),
      nav: result.nav,
      resourceDurations,
      resources: result.resources,
      error: null,
    };

    const renderLabel = sample.renderMs == null ? "n/a" : `${sample.renderMs}ms`;
    const navLoadLabel = sample.nav?.load == null ? "n/a" : `${sample.nav.load}ms`;
    const extraLabel = (sample.resourceDurations["app-extra.js"] || []).length ? "yes" : "no";
    console.error(`cold-cache: ${routeId} sample ${sampleNumber}/${opts.sampleCount} render=${renderLabel} navLoad=${navLoadLabel} extra=${extraLabel}`);
    return sample;
  } catch (err) {
    const message = err?.message || String(err);
    console.error(`cold-cache: ${routeId} sample ${sampleNumber}/${opts.sampleCount} failed=${message}`);
    return {
      sampleIndex,
      sampleNumber,
      targetUrl,
      href: null,
      renderMs: null,
      gqlCalls: null,
      nav: null,
      resourceDurations: Object.create(null),
      resources: [],
      error: message,
    };
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const presets = getRoutePresets();
  const availableIds = Object.keys(presets);
  const routeIds = opts.routeIds.length ? opts.routeIds : availableIds;
  const unknownIds = routeIds.filter((routeId) => !presets[routeId]);
  if (unknownIds.length) {
    console.error(`Unknown route preset(s): ${unknownIds.join(", ")}`);
    process.exit(1);
  }

  const samplesByRoute = Object.create(null);
  let sampleCursor = 0;

  for (const routeId of routeIds) {
    const preset = presets[routeId];
    const samples = [];
    for (let sampleNumber = 1; sampleNumber <= opts.sampleCount; sampleNumber += 1) {
      const sample = await runSample({
        routeId,
        sampleIndex: sampleCursor,
        sampleNumber,
        preset,
        opts,
        cdpPort: opts.cdpPortBase + sampleCursor,
      });
      samples.push(sample);
      sampleCursor += 1;
      if (sampleNumber < opts.sampleCount && opts.delayMs) {
        await delay(opts.delayMs);
      }
    }
    samplesByRoute[routeId] = samples;
  }

  const summary = Object.fromEntries(
    Object.entries(samplesByRoute).map(([routeId, samples]) => [routeId, summarizeRoute(routeId, samples)])
  );

  console.log(JSON.stringify({
    walrusOrigin: opts.walrusOrigin,
    sampleCount: opts.sampleCount,
    summary,
    routes: samplesByRoute,
  }, null, 2));
}

await main();

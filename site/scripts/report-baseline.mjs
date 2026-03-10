#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAppSource } from "./lib/app-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const TEMPLATE_PATH = resolve(SITE_ROOT, "src/index.template.html");
const CSS_PATH = resolve(SITE_ROOT, "src/styles.css");
const LEGACY_PATH = resolve(SITE_ROOT, "src/index.html");
const OUT_PATH = resolve(SITE_ROOT, "docs/baseline.md");
let html;
let sourceLabel;
try {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const css = readFileSync(CSS_PATH, "utf8");
  const appSource = readAppSource(SITE_ROOT);
  const js = appSource.source;
  html = template
    .replace("{{APP_STYLE_TAG}}", () => `<style>${css}</style>`)
    .replace("{{APP_EXTRA_META}}", () => "")
    .replace("{{APP_SCRIPT_TAG}}", () => `<script>${js}</script>`);
  sourceLabel = appSource.sourceDescriptor;
} catch (_) {
  html = readFileSync(LEGACY_PATH, "utf8");
  sourceLabel = "src/index.html";
}

function count(pattern) {
  const matches = html.match(pattern);
  return matches ? matches.length : 0;
}

const lines = html.split("\n").length;
const bytes = Buffer.byteLength(html, "utf8");

const baseline = {
  generatedAt: new Date().toISOString(),
  source: sourceLabel,
  lines,
  bytes,
  inlineStyleAttrs: count(/style="/g),
  windowHandlers: count(/window\.[A-Za-z0-9_]+\s*=\s*/g),
  gqlCallsAwaited: count(/await\s+gql\(/g),
  gqlCallsTotal: count(/\bgql\(/g),
  routeCases: count(/case\s+"[^"]+"/g),
};

const md = [
  "# Baseline Metrics",
  "",
  `Generated: \`${baseline.generatedAt}\``,
  "",
  "| Metric | Value |",
  "|---|---:|",
  `| Source file | \`${baseline.source}\` |`,
  `| Lines | ${baseline.lines} |`,
  `| Bytes | ${baseline.bytes} |`,
  `| Inline style attributes | ${baseline.inlineStyleAttrs} |`,
  `| \`window.*\` handler assignments | ${baseline.windowHandlers} |`,
  `| \`await gql(...)\` call sites | ${baseline.gqlCallsAwaited} |`,
  `| Total \`gql(...)\` call sites | ${baseline.gqlCallsTotal} |`,
  `| Router \`case\` labels | ${baseline.routeCases} |`,
  "",
  "Notes:",
  "- These are static code metrics for maintainability tracking.",
  "- Runtime query counts/latency are measured by the in-app perf badge.",
  "",
].join("\n");

writeFileSync(OUT_PATH, md, "utf8");
console.log(`report-baseline: wrote ${OUT_PATH}`);

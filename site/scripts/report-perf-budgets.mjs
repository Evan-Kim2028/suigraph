#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const JS_PATH = resolve(SITE_ROOT, "src/app.js");
const OUT_PATH = resolve(SITE_ROOT, "docs/perf-budgets.md");

const src = readFileSync(JS_PATH, "utf8");

const routePages = new Set([...src.matchAll(/return\s+\{\s*page:\s*"([^"]+)"/g)].map((m) => String(m[1])));
const defaultGql = Number(src.match(/const DEFAULT_PAGE_GQL_BUDGET = (\d+);/)?.[1] || 0);
const defaultRender = Number(src.match(/const PERF_WARN_RENDER_MS = (\d+);/)?.[1] || 0);
const budgetBlock = src.match(/const PAGE_PERF_BUDGETS = Object\.freeze\(\{([\s\S]*?)\}\);/)?.[1] || "";

const budgets = new Map();
for (const m of budgetBlock.matchAll(/(?:^|\n)\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))\s*:\s*\{\s*gqlCalls:\s*(\d+),\s*renderMs:\s*(\d+)\s*\}/g)) {
  const page = m[1] || m[2];
  budgets.set(page, {
    gqlCalls: Number(m[3]),
    renderMs: Number(m[4]),
  });
}

const pages = [...routePages].sort((a, b) => a.localeCompare(b));
const rows = pages.map((page) => {
  const b = budgets.get(page);
  return {
    page,
    gqlCalls: b ? b.gqlCalls : defaultGql,
    renderMs: b ? b.renderMs : defaultRender,
    declared: Boolean(b),
  };
});

const missing = rows.filter((r) => !r.declared).map((r) => r.page);

const md = [
  "# Perf Budgets",
  "",
  `Generated: \`${new Date().toISOString()}\``,
  "",
  "| Page | GQL call budget | Render budget (ms) | Budget source |",
  "|---|---:|---:|---|",
  ...rows.map((r) => `| \`${r.page}\` | ${r.gqlCalls} | ${r.renderMs} | ${r.declared ? "declared" : "default"} |`),
  "",
  `- Default GQL call budget: ${defaultGql}`,
  `- Default render budget: ${defaultRender}ms`,
  `- Route pages discovered: ${routePages.size}`,
  `- Explicit budget entries: ${budgets.size}`,
  `- Missing explicit entries: ${missing.length}`,
  "",
  missing.length ? `Missing pages: ${missing.map((p) => `\`${p}\``).join(", ")}` : "Missing pages: none",
  "",
].join("\n");

writeFileSync(OUT_PATH, md, "utf8");
console.log(`report-perf-budgets: wrote ${OUT_PATH}`);

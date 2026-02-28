#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const JS_PATH = resolve(SITE_ROOT, "src/app.js");
const OUT_PATH = resolve(SITE_ROOT, "docs/graphql-surface.md");

const src = readFileSync(JS_PATH, "utf8");
const totalCalls = (src.match(/\bgql\s*\(/g) || []).length;
const awaitedCalls = (src.match(/await\s+gql\s*\(/g) || []).length;
const staticCalls = [...src.matchAll(/\bgql\s*\(\s*`([\s\S]*?)`\s*(?:,|\))/g)];
const dynamicCalls = Math.max(0, totalCalls - staticCalls.length);

const opCounts = new Map();
for (const m of staticCalls) {
  const q = String(m[1] || "");
  const normalized = q.replace(/\s+/g, " ").trim();
  const preview = normalized.slice(0, 96) || "(empty)";
  const sigHash = createHash("sha1").update(normalized).digest("hex").slice(0, 10);
  const op = q.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
  const key = op ? `${op[1]} ${op[2]}` : `anonymous:${sigHash}`;
  const prev = opCounts.get(key);
  if (prev) {
    prev.count += 1;
  } else {
    opCounts.set(key, {
      count: 1,
      preview,
    });
  }
}

const ops = [...opCounts.entries()].sort((a, b) => {
  if (b[1].count !== a[1].count) return b[1].count - a[1].count;
  return a[0].localeCompare(b[0]);
});

const md = [
  "# GraphQL Surface",
  "",
  `Generated: \`${new Date().toISOString()}\``,
  "",
  "| Metric | Value |",
  "|---|---:|",
  `| Total \`gql(...)\` call sites | ${totalCalls} |`,
  `| Awaited \`gql(...)\` call sites | ${awaitedCalls} |`,
  `| Static template-literal query call sites | ${staticCalls.length} |`,
  `| Dynamic/non-literal query call sites | ${dynamicCalls} |`,
  `| Unique static query signatures | ${ops.length} |`,
  "",
  "## Operations",
  "",
  "| Signature | Static call sites | Preview |",
  "|---|---:|---|",
  ...(ops.length
    ? ops.map(([name, meta]) => `| \`${name}\` | ${meta.count} | \`${meta.preview.replace(/`/g, "\\`")}\` |`)
    : ["| _None detected_ | 0 | _n/a_ |"]),
  "",
  "Notes:",
  "- This is a static source scan of `src/app.js`.",
  "- Runtime call count/latency remains available in the in-app perf badge.",
  "",
].join("\n");

writeFileSync(OUT_PATH, md, "utf8");
console.log(`report-gql-surface: wrote ${OUT_PATH}`);

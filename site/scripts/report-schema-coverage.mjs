#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAppSource } from "./lib/app-source.mjs";
import { collectStaticGqlQueries } from "./lib/gql-static-analysis.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const SCHEMA_PATH = resolve(SITE_ROOT, "docs/schema-root-fields.json");
const OUT_PATH = resolve(SITE_ROOT, "docs/schema-coverage.md");
const CHECK_MODE = process.argv.includes("--check");

function removeInterpolations(input) {
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "$" && input[i + 1] === "{") {
      i += 2;
      let depth = 1;
      while (i < input.length && depth > 0) {
        if (input[i] === "{") depth += 1;
        else if (input[i] === "}") depth -= 1;
        i += 1;
      }
      out += " ";
      continue;
    }
    out += input[i];
    i += 1;
  }
  return out;
}

function skipQuoted(s, i) {
  const quote = s[i];
  i += 1;
  let esc = false;
  while (i < s.length) {
    const ch = s[i];
    if (esc) {
      esc = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      i += 1;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return i;
}

function skipParens(s, i) {
  let depth = 1;
  i += 1;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (ch === "'" || ch === "\"") {
      i = skipQuoted(s, i);
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  return i;
}

function extractRootFields(queryText) {
  const stripped = removeInterpolations(String(queryText || "")).replace(/#[^\n]*/g, " ");
  const start = stripped.indexOf("{");
  if (start < 0) return [];
  const fields = [];
  let i = start + 1;
  let depth = 1;
  while (i < stripped.length && depth > 0) {
    const ch = stripped[i];
    if (ch === "'" || ch === "\"") {
      i = skipQuoted(stripped, i);
      continue;
    }
    if (ch === "(" && depth === 1) {
      i = skipParens(stripped, i);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth !== 1 || /\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (stripped.startsWith("...", i)) {
      i += 3;
      while (i < stripped.length && /[A-Za-z0-9_]/.test(stripped[i])) i += 1;
      continue;
    }
    if (ch === "@") {
      i += 1;
      while (i < stripped.length && /[A-Za-z0-9_]/.test(stripped[i])) i += 1;
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < stripped.length && /[A-Za-z0-9_]/.test(stripped[j])) j += 1;
    let token = stripped.slice(i, j);
    let k = j;
    while (k < stripped.length && /\s/.test(stripped[k])) k += 1;
    if (stripped[k] === ":") {
      k += 1;
      while (k < stripped.length && /\s/.test(stripped[k])) k += 1;
      if (/[A-Za-z_]/.test(stripped[k])) {
        let l = k + 1;
        while (l < stripped.length && /[A-Za-z0-9_]/.test(stripped[l])) l += 1;
        token = stripped.slice(k, l);
        j = l;
      }
    }
    fields.push(token);
    i = j;
  }
  return fields;
}

const appSource = readAppSource(SITE_ROOT);
const src = appSource.source;
const snapshotRaw = readFileSync(SCHEMA_PATH, "utf8");
const snapshot = JSON.parse(snapshotRaw);

const allCalls = [...src.matchAll(/\bgql\s*\(/g)];
const staticQueries = collectStaticGqlQueries(src);
const dynamicCalls = Math.max(0, allCalls.length - staticQueries.length);

const counts = new Map();
for (const query of staticQueries) {
  const roots = extractRootFields(query);
  for (const r of roots) counts.set(r, (counts.get(r) || 0) + 1);
}

const queryFields = new Set(snapshot.queryFields || []);
const mutationFields = new Set(snapshot.mutationFields || []);
const subscriptionFields = new Set(snapshot.subscriptionFields || []);
const usedFields = [...counts.keys()].sort((a, b) => a.localeCompare(b));
const usedQuery = usedFields.filter((f) => queryFields.has(f));
const usedMutation = usedFields.filter((f) => mutationFields.has(f));
const usedSubscription = usedFields.filter((f) => subscriptionFields.has(f));
const unknownUsed = usedFields.filter((f) => !queryFields.has(f) && !mutationFields.has(f) && !subscriptionFields.has(f));
const unusedQuery = [...queryFields].filter((f) => !usedQuery.includes(f)).sort((a, b) => a.localeCompare(b));

const queryCoveragePct = queryFields.size ? ((usedQuery.length / queryFields.size) * 100) : 0;

const usedQueryRows = usedQuery
  .map((name) => ({ name, count: counts.get(name) || 0 }))
  .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

const md = [
  "# Schema Coverage",
  "",
  `Generated from snapshot: \`${snapshot.generatedAt || "unknown"}\``,
  "",
  "## Snapshot",
  "",
  `- Endpoint: \`${snapshot.endpoint || "unknown"}\``,
  `- Snapshot generated: \`${snapshot.generatedAt || "unknown"}\``,
  "",
  "| Metric | Value |",
  "|---|---:|",
  `| Total gql call sites | ${allCalls.length} |`,
  `| Static template query call sites | ${staticQueries.length} |`,
  `| Dynamic/non-literal call sites | ${dynamicCalls} |`,
  `| Query root fields in schema snapshot | ${queryFields.size} |`,
  `| Query root fields used (static scan) | ${usedQuery.length} |`,
  `| Query root coverage | ${queryCoveragePct.toFixed(1)}% |`,
  `| Mutation root fields used | ${usedMutation.length} |`,
  `| Subscription root fields used | ${usedSubscription.length} |`,
  `| Unknown root tokens in static scan | ${unknownUsed.length} |`,
  "",
  "## Used Query Roots",
  "",
  "| Root field | Static call sites |",
  "|---|---:|",
  ...(usedQueryRows.length
    ? usedQueryRows.map((r) => `| \`${r.name}\` | ${r.count} |`)
    : ["| _None detected_ | 0 |"]),
  "",
  "## Unused Query Roots",
  "",
  unusedQuery.length ? unusedQuery.map((f) => `- \`${f}\``).join("\n") : "- _None_",
  "",
  "## Notes",
  "",
  `- Coverage is based on static template-literal query scans in \`${appSource.jsSourceLabel}\`.`,
  "- Dynamic query construction can undercount true runtime root-field usage.",
  "- Refresh schema snapshot with `npm run schema:refresh` when upstream schema changes.",
  "",
].join("\n");

if (CHECK_MODE) {
  const current = readFileSync(OUT_PATH, "utf8");
  if (current !== md) {
    console.error("report-schema-coverage: drift detected. run `npm run schema:coverage`");
    process.exit(1);
  }
  console.log("report-schema-coverage: up to date");
} else {
  writeFileSync(OUT_PATH, md, "utf8");
  console.log(`report-schema-coverage: wrote ${OUT_PATH}`);
}

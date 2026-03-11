#!/usr/bin/env node

import { readFileSync } from "node:fs";

const reportPath = process.argv[2] || "";
if (!reportPath) {
  console.error("Usage: node scripts/render-fixture-scan-summary.mjs <report.json>");
  process.exit(1);
}

let report = null;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (_) {
  console.log("## Fixture Scan\n\nNo fixture scan report was produced.");
  process.exit(0);
}

const results = Array.isArray(report?.results) ? report.results : [];
const required = results.filter((result) => result?.tier === "required");
const failedRequired = required.filter((result) => Array.isArray(result?.issues) && result.issues.length > 0);
const counts = { active: 0, partial: 0, stale: 0, invalid: 0 };
for (const result of results) {
  const key = String(result?.status || "").trim();
  if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
}

const lines = [
  "## Fixture Scan",
  "",
  `- scanned at: ${report?.scannedAt || "unknown"}`,
  `- required active: ${required.length - failedRequired.length}/${required.length}`,
  `- statuses: active ${counts.active}, partial ${counts.partial}, stale ${counts.stale}, invalid ${counts.invalid}`,
  `- failed required: ${failedRequired.length ? failedRequired.map((result) => `\`${result.id}\``).join(", ") : "none"}`,
  "",
  "| Tier | Fixture | Status | Ownership | Protocols | Issues |",
  "| --- | --- | --- | --- | --- | --- |",
];

for (const result of results) {
  const issues = Array.isArray(result?.issues) && result.issues.length
    ? result.issues.join("; ").replace(/\|/g, "/")
    : "ok";
  const protocols = Array.isArray(result?.protocols) && result.protocols.length
    ? result.protocols.join(", ")
    : "none";
  lines.push(`| ${result?.tier || ""} | \`${result?.id || ""}\` | ${result?.status || ""} | ${result?.ownership || "unknown"} | ${protocols} | ${issues} |`);
}

console.log(lines.join("\n"));

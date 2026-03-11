#!/usr/bin/env node

import { readFileSync } from "node:fs";

const ISSUE_TITLE = "Fixture Drift Failure";

function parseArgs(argv) {
  const opts = {
    mode: "",
    repo: "",
    reportPath: "",
    summaryPath: "",
    runUrl: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--mode") { opts.mode = String(argv[i + 1] || "").trim(); i += 1; }
    else if (arg === "--repo") { opts.repo = String(argv[i + 1] || "").trim(); i += 1; }
    else if (arg === "--report") { opts.reportPath = String(argv[i + 1] || "").trim(); i += 1; }
    else if (arg === "--summary") { opts.summaryPath = String(argv[i + 1] || "").trim(); i += 1; }
    else if (arg === "--run-url") { opts.runUrl = String(argv[i + 1] || "").trim(); i += 1; }
  }
  return opts;
}

function printHelp() {
  console.log([
    "Usage: node scripts/sync-fixture-drift-issue.mjs --mode <open|close> --repo <owner/repo> --report <path> --summary <path> --run-url <url>",
    "",
    "Opens, updates, or closes the auto-managed fixture drift issue.",
  ].join("\n"));
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (_) {
    return "";
  }
}

async function githubRequest(repo, token, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "suigraph-fixture-drift",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

function buildFailureBody(report, summary, runUrl) {
  const failedRequired = Array.isArray(report?.results)
    ? report.results.filter((result) => result?.tier === "required" && Array.isArray(result?.issues) && result.issues.length > 0)
    : [];
  const lines = [
    "This issue is managed automatically by the scheduled `Fixture Drift` workflow.",
    "",
    `Latest failed run: ${runUrl}`,
    `Scanned at: ${report?.scannedAt || "unknown"}`,
    "",
  ];
  if (failedRequired.length) {
    lines.push("Failed required fixtures:");
    for (const result of failedRequired) {
      lines.push(`- \`${result.id}\` (${result.address || "unknown address"}): ${(result.issues || []).join("; ")}`);
    }
    lines.push("");
  }
  if (summary.trim()) {
    lines.push("<details><summary>Latest report</summary>");
    lines.push("");
    lines.push(summary.trim());
    lines.push("");
    lines.push("</details>");
  }
  return lines.join("\n");
}

async function findOpenIssue(repo, token) {
  const issues = await githubRequest(repo, token, "/issues?state=open&per_page=100");
  return (issues || []).find((issue) => issue?.title === ISSUE_TITLE && !issue?.pull_request) || null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (!opts.mode || !opts.repo || !opts.reportPath || !opts.summaryPath || !opts.runUrl) {
    printHelp();
    process.exit(1);
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!token) throw new Error("Missing GITHUB_TOKEN or GH_TOKEN");

  const report = JSON.parse(readText(opts.reportPath) || "{}");
  const summary = readText(opts.summaryPath);
  const openIssue = await findOpenIssue(opts.repo, token);

  if (opts.mode === "open") {
    const body = buildFailureBody(report, summary, opts.runUrl);
    if (openIssue) {
      await githubRequest(opts.repo, token, `/issues/${openIssue.number}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      await githubRequest(opts.repo, token, `/issues/${openIssue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `Scheduled fixture drift failure reproduced: ${opts.runUrl}` }),
      });
      console.log(`updated issue #${openIssue.number}`);
      return;
    }
    const created = await githubRequest(opts.repo, token, "/issues", {
      method: "POST",
      body: JSON.stringify({ title: ISSUE_TITLE, body }),
    });
    console.log(`opened issue #${created.number}`);
    return;
  }

  if (opts.mode === "close") {
    if (!openIssue) {
      console.log("no open fixture drift issue");
      return;
    }
    await githubRequest(opts.repo, token, `/issues/${openIssue.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `Scheduled fixture drift scan recovered: ${opts.runUrl}` }),
    });
    await githubRequest(opts.repo, token, `/issues/${openIssue.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    console.log(`closed issue #${openIssue.number}`);
    return;
  }

  throw new Error(`Unsupported mode: ${opts.mode}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});

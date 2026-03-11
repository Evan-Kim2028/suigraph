#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const DEFAULT_CONTEXT = process.env.WALRUS_CONTEXT || "mainnet";
const DEFAULT_EPOCHS = process.env.WALRUS_EPOCHS || "10";
const DEFAULT_SITE_BUILDER_BIN = process.env.SITE_BUILDER_BIN || "site-builder";
const DEPLOY_GUARD_PATHS = [
  "site/src",
  "site/ws-resources.json",
  "site/scripts/build-single-file.mjs",
  "site/scripts/lib/app-source.mjs",
];

function fail(message, details = []) {
  console.error(`deploy-walrus-site: ${message}`);
  for (const detail of details) console.error(`- ${detail}`);
  process.exit(1);
}

function run(bin, args, cwd = SITE_ROOT) {
  const result = spawnSync(bin, args, {
    cwd,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`failed to run ${bin}: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function capture(bin, args, cwd = SITE_ROOT) {
  try {
    return execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    fail(`failed to run ${bin}: ${err.message}`);
  }
}

function getRepoRoot() {
  return capture("git", ["rev-parse", "--show-toplevel"]);
}

function getDirtyDeployInputs(repoRoot) {
  const output = capture("git", [
    "-C",
    repoRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...DEPLOY_GUARD_PATHS,
  ]);
  return output ? output.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function parseArgs(argv) {
  const options = {
    context: DEFAULT_CONTEXT,
    epochs: DEFAULT_EPOCHS,
    siteBuilderBin: DEFAULT_SITE_BUILDER_BIN,
    help: false,
    extraArgs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--context") {
      options.context = String(argv[i + 1] || "").trim() || options.context;
      i += 1;
    } else if (arg === "--epochs") {
      options.epochs = String(argv[i + 1] || "").trim() || options.epochs;
      i += 1;
    } else if (arg === "--site-builder-bin") {
      options.siteBuilderBin = String(argv[i + 1] || "").trim() || options.siteBuilderBin;
      i += 1;
    } else {
      options.extraArgs.push(arg);
    }
  }
  return options;
}

function printHelp() {
  console.log([
    "Usage: node scripts/deploy-walrus-site.mjs [options] [extra site-builder args]",
    "",
    "Guards deployment by refusing dirty deploy inputs and requiring a green local validate run.",
    "",
    "Options:",
    `  --context <name>           Walrus context (default: ${DEFAULT_CONTEXT})`,
    `  --epochs <count>           Site epochs to buy (default: ${DEFAULT_EPOCHS})`,
    `  --site-builder-bin <bin>  site-builder binary to execute (default: ${DEFAULT_SITE_BUILDER_BIN})`,
    "  -h, --help                Show help",
    "",
    "Guarded inputs:",
    ...DEPLOY_GUARD_PATHS.map((path) => `  - ${path}`),
  ].join("\n"));
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const repoRoot = getRepoRoot();
const dirtyDeployInputs = getDirtyDeployInputs(repoRoot);
if (dirtyDeployInputs.length) {
  fail(
    "refusing deploy because deploy inputs are dirty",
    [
      ...dirtyDeployInputs,
      "commit or stash the listed deploy input changes before running deploy:walrus",
    ]
  );
}

run("npm", ["run", "build"]);
run("npm", ["run", "validate"]);
run("npm", ["run", "check:route-perf"]);

const dirtyAfterValidate = getDirtyDeployInputs(repoRoot);
if (dirtyAfterValidate.length) {
  fail(
    "deploy inputs changed during build or validation",
    dirtyAfterValidate
  );
}

run(options.siteBuilderBin, [
  `--context=${options.context}`,
  "deploy",
  "./dist",
  "--epochs",
  String(options.epochs),
  "--ws-resources",
  "./ws-resources.json",
  ...options.extraArgs,
]);

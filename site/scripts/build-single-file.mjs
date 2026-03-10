#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAppSource } from "./lib/app-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const LEGACY_SRC_PATH = resolve(SITE_ROOT, "src/index.html");
const TEMPLATE_PATH = resolve(SITE_ROOT, "src/index.template.html");
const CSS_PATH = resolve(SITE_ROOT, "src/styles.css");
const WS_RESOURCES_SRC = resolve(SITE_ROOT, "ws-resources.json");
const WS_RESOURCES_OUT = resolve(SITE_ROOT, "dist/ws-resources.json");
const PRIMARY_OUT = resolve(SITE_ROOT, "index.html");
const DIST_OUT = resolve(SITE_ROOT, "dist/index.html");
const MANIFEST_OUT = resolve(SITE_ROOT, "dist/build-manifest.json");
const checkOnly = process.argv.includes("--check");

function fail(msg) {
  console.error(`build-single-file: ${msg}`);
  process.exit(1);
}

function readUtf8(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(`failed to read ${path}: ${err.message}`);
  }
}

function buildSource() {
  if (!existsSync(TEMPLATE_PATH)) {
    return {
      mode: "legacy-html",
      sourcePath: "src/index.html",
      source: readUtf8(LEGACY_SRC_PATH),
    };
  }

  const template = readUtf8(TEMPLATE_PATH);
  const css = readUtf8(CSS_PATH);
  const appSource = readAppSource(SITE_ROOT);

  if (!template.includes("{{INLINE_CSS}}") || !template.includes("{{INLINE_JS}}")) {
    fail("src/index.template.html must include {{INLINE_CSS}} and {{INLINE_JS}} placeholders");
  }

  return {
    mode: "templated-inline",
    sourcePath: appSource.sourceDescriptor,
    source: template.replace("{{INLINE_CSS}}", () => css).replace("{{INLINE_JS}}", () => appSource.source),
  };
}

const built = buildSource();
const source = built.source;
if (!source.trim().startsWith("<!DOCTYPE html>") && !source.trim().startsWith("<!doctype html>")) {
  fail("generated html must begin with <!DOCTYPE html>");
}

const normalized = source.replace(/\r\n/g, "\n");
const hash = createHash("sha256").update(normalized).digest("hex");
const lines = normalized.split("\n").length;
const bytes = Buffer.byteLength(source, "utf8");

if (checkOnly) {
  const expected = source;
  const targets = [PRIMARY_OUT, DIST_OUT];
  const missing = targets.filter((path) => !existsSync(path));
  if (missing.length) {
    fail(`missing output files: ${missing.join(", ")}. run npm run build`);
  }
  const mismatched = targets.filter((path) => readUtf8(path) !== expected);
  if (mismatched.length) {
    fail(`output drift detected in: ${mismatched.join(", ")}. run npm run build`);
  }
  console.log(`build-single-file: outputs match ${built.sourcePath}`);
  process.exit(0);
}

mkdirSync(resolve(SITE_ROOT, "dist"), { recursive: true });
writeFileSync(PRIMARY_OUT, source, "utf8");
writeFileSync(DIST_OUT, source, "utf8");
writeFileSync(
  MANIFEST_OUT,
  JSON.stringify(
    {
      source: built.sourcePath,
      buildMode: built.mode,
      sourceDescriptor: built.sourcePath,
      outputs: ["index.html", "dist/index.html"],
      hashSha256: hash,
      lines,
      bytes,
      builtAt: new Date().toISOString(),
    },
    null,
    2
  ) + "\n",
  "utf8"
);

if (existsSync(WS_RESOURCES_SRC)) {
  copyFileSync(WS_RESOURCES_SRC, WS_RESOURCES_OUT);
}

console.log(`build-single-file: wrote index.html and dist/index.html`);
console.log(`build-single-file: sha256 ${hash}`);

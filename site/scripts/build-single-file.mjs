#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { minify } from "terser";
import { readAppBundleSources } from "./lib/app-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const LEGACY_SRC_PATH = resolve(SITE_ROOT, "src/index.html");
const TEMPLATE_PATH = resolve(SITE_ROOT, "src/index.template.html");
const CSS_PATH = resolve(SITE_ROOT, "src/styles.css");
const WS_RESOURCES_SRC = resolve(SITE_ROOT, "ws-resources.json");
const WS_RESOURCES_OUT = resolve(SITE_ROOT, "dist/ws-resources.json");
const PRIMARY_OUT = resolve(SITE_ROOT, "index.html");
const DIST_OUT = resolve(SITE_ROOT, "dist/index.html");
const ROOT_ASSETS_DIR = resolve(SITE_ROOT, "assets");
const DIST_ASSETS_DIR = resolve(SITE_ROOT, "dist/assets");
const ROOT_CSS_OUT = resolve(ROOT_ASSETS_DIR, "styles.css");
const ROOT_JS_OUT = resolve(ROOT_ASSETS_DIR, "app.js");
const ROOT_EXTRA_JS_OUT = resolve(ROOT_ASSETS_DIR, "app-extra.js");
const DIST_CSS_OUT = resolve(DIST_ASSETS_DIR, "styles.css");
const DIST_JS_OUT = resolve(DIST_ASSETS_DIR, "app.js");
const DIST_EXTRA_JS_OUT = resolve(DIST_ASSETS_DIR, "app-extra.js");
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

function sha256Hex(source) {
  return createHash("sha256").update(String(source).replace(/\r\n/g, "\n")).digest("hex");
}

async function minifyInlineAsset(source, loader, label) {
  try {
    const result = await transform(source, {
      loader,
      minify: true,
      legalComments: "none",
      target: loader === "js" ? "es2020" : undefined,
    });
    return result.code.trim();
  } catch (err) {
    fail(`failed to minify ${label}: ${err.message}`);
  }
}

async function minifyInlineScript(source, label, useTopLevel = true) {
  try {
    const result = await minify(source, {
      ecma: 2020,
      toplevel: useTopLevel,
      compress: {
        ecma: 2020,
        passes: 3,
      },
      mangle: {
        toplevel: useTopLevel,
      },
      format: {
        comments: false,
      },
    });
    return String(result.code || "").trim();
  } catch (err) {
    fail(`failed to minify ${label}: ${err.message}`);
  }
}

function renderTemplate(template, styleTag, extraMetaTag, scriptTag) {
  if (!template.includes("{{APP_STYLE_TAG}}") || !template.includes("{{APP_EXTRA_META}}") || !template.includes("{{APP_SCRIPT_TAG}}")) {
    fail("src/index.template.html must include {{APP_STYLE_TAG}}, {{APP_EXTRA_META}}, and {{APP_SCRIPT_TAG}} placeholders");
  }
  return template
    .replace("{{APP_STYLE_TAG}}", () => styleTag)
    .replace("{{APP_EXTRA_META}}", () => extraMetaTag)
    .replace("{{APP_SCRIPT_TAG}}", () => scriptTag);
}

async function buildSource() {
  if (!existsSync(TEMPLATE_PATH)) {
    return {
      mode: "legacy-html",
      sourcePath: "src/index.html",
      html: readUtf8(LEGACY_SRC_PATH),
      assets: [],
    };
  }

  const template = readUtf8(TEMPLATE_PATH);
  const css = await minifyInlineAsset(readUtf8(CSS_PATH), "css", "src/styles.css");
  const bundles = readAppBundleSources(SITE_ROOT);
  const js = await minifyInlineScript(bundles.bootSource, "src/app/*.js (boot)", false);
  const extraJs = bundles.extraSource
    ? await minifyInlineScript(`window.__SUIGRAPH_EXTRA_LOADED__=!0;\n${bundles.extraSource}`, "src/app/*.js (extra)", false)
    : "";
  const cssHash = sha256Hex(css);
  const jsHash = sha256Hex(js);
  const extraJsHash = sha256Hex(extraJs);
  const cssVersion = cssHash.slice(0, 12);
  const jsVersion = jsHash.slice(0, 12);
  const extraJsVersion = extraJsHash.slice(0, 12);
  const styleHref = `./assets/styles.css?v=${cssVersion}`;
  const scriptSrc = `./assets/app.js?v=${jsVersion}`;
  const extraScriptSrc = `./assets/app-extra.js?v=${extraJsVersion}`;

  return {
    mode: "templated-external-assets",
    sourcePath: bundles.sourceDescriptor,
    html: renderTemplate(
      template,
      `<link rel="stylesheet" href="${styleHref}">`,
      `<meta name="suigraph-extra-src" content="${extraScriptSrc}">`,
      `<script src="${scriptSrc}" defer></script>`
    ),
    assets: [
      { path: "assets/styles.css", rootOut: ROOT_CSS_OUT, distOut: DIST_CSS_OUT, source: css, bytes: Buffer.byteLength(css, "utf8"), hashSha256: cssHash, version: cssVersion },
      { path: "assets/app.js", rootOut: ROOT_JS_OUT, distOut: DIST_JS_OUT, source: js, bytes: Buffer.byteLength(js, "utf8"), hashSha256: jsHash, version: jsVersion },
      ...(extraJs
        ? [{ path: "assets/app-extra.js", rootOut: ROOT_EXTRA_JS_OUT, distOut: DIST_EXTRA_JS_OUT, source: extraJs, bytes: Buffer.byteLength(extraJs, "utf8"), hashSha256: extraJsHash, version: extraJsVersion }]
        : []),
    ],
  };
}

const built = await buildSource();
const html = built.html;
if (!html.trim().startsWith("<!DOCTYPE html>") && !html.trim().startsWith("<!doctype html>")) {
  fail("generated html must begin with <!DOCTYPE html>");
}

const normalizedHtml = html.replace(/\r\n/g, "\n");
const htmlHash = sha256Hex(html);
const htmlLines = normalizedHtml.split("\n").length;
const htmlBytes = Buffer.byteLength(html, "utf8");
const totalBytes = htmlBytes + built.assets.reduce((sum, asset) => sum + asset.bytes, 0);

if (checkOnly) {
  const expectedTargets = [
    { path: PRIMARY_OUT, source: html },
    { path: DIST_OUT, source: html },
    ...built.assets.flatMap((asset) => [
      { path: asset.rootOut, source: asset.source },
      { path: asset.distOut, source: asset.source },
    ]),
  ];
  if (existsSync(WS_RESOURCES_SRC)) {
    expectedTargets.push({ path: WS_RESOURCES_OUT, source: readUtf8(WS_RESOURCES_SRC) });
  }
  const missing = expectedTargets.map((target) => target.path).filter((path) => !existsSync(path));
  if (missing.length) {
    fail(`missing output files: ${missing.join(", ")}. run npm run build`);
  }
  const mismatched = expectedTargets.filter((target) => readUtf8(target.path) !== target.source).map((target) => target.path);
  if (mismatched.length) {
    fail(`output drift detected in: ${mismatched.join(", ")}. run npm run build`);
  }
  console.log(`build-site: outputs match ${built.sourcePath}`);
  process.exit(0);
}

mkdirSync(resolve(SITE_ROOT, "dist"), { recursive: true });
mkdirSync(ROOT_ASSETS_DIR, { recursive: true });
mkdirSync(DIST_ASSETS_DIR, { recursive: true });
writeFileSync(PRIMARY_OUT, html, "utf8");
writeFileSync(DIST_OUT, html, "utf8");
for (const asset of built.assets) {
  writeFileSync(asset.rootOut, asset.source, "utf8");
  writeFileSync(asset.distOut, asset.source, "utf8");
}
writeFileSync(
  MANIFEST_OUT,
  JSON.stringify(
    {
      source: built.sourcePath,
      buildMode: built.mode,
      sourceDescriptor: built.sourcePath,
      outputs: [
        "index.html",
        "dist/index.html",
        ...built.assets.flatMap((asset) => [asset.path, `dist/${asset.path}`]),
      ],
      htmlHashSha256: htmlHash,
      htmlLines,
      htmlBytes,
      totalBytes,
      assets: built.assets.map((asset) => ({
        path: asset.path,
        bytes: asset.bytes,
        hashSha256: asset.hashSha256,
        version: asset.version,
      })),
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

console.log(`build-site: wrote index.html, assets/, dist/index.html, and dist/assets/`);
console.log(`build-site: html sha256 ${htmlHash}`);

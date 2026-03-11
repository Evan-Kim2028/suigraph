import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

function readUtf8(path) {
  return readFileSync(path, "utf8");
}

function collectJsParts(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsParts(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function joinSources(paths) {
  return `${paths.map((path) => readUtf8(path).replace(/\s+$/u, "")).join("\n\n")}\n`;
}

const PAGE_EXTRA_SPLIT_MARKER = "// ── Coin Search";
const PAGE_INIT_MARKER = "// ── Init";
const CRITICAL_BOOT_FILES = new Set(["35-defi-adapters.js"]);

export function readAppSource(siteRoot) {
  const appPartsDir = resolve(siteRoot, "src/app");
  const legacyAppPath = resolve(siteRoot, "src/app.js");

  if (existsSync(appPartsDir)) {
    const partPaths = collectJsParts(appPartsDir);
    if (!partPaths.length) {
      throw new Error("src/app exists but contains no .js source parts");
    }
    const relParts = partPaths.map((path) => relative(siteRoot, path).replace(/\\/g, "/"));
    return {
      source: joinSources(partPaths),
      jsSourceLabel: "src/app/*.js",
      jsSourceFiles: relParts,
      sourceDescriptor: `src/index.template.html + src/styles.css + src/app/*.js`,
    };
  }

  if (!existsSync(legacyAppPath)) {
    throw new Error("missing src/app.js");
  }

  return {
    source: readUtf8(legacyAppPath),
    jsSourceLabel: "src/app.js",
    jsSourceFiles: ["src/app.js"],
    sourceDescriptor: "src/index.template.html + src/styles.css + src/app.js",
  };
}

export function readAppBundleSources(siteRoot) {
  const appPartsDir = resolve(siteRoot, "src/app");
  const pagesPath = resolve(appPartsDir, "30-pages.js");

  if (!existsSync(pagesPath)) {
    const app = readAppSource(siteRoot);
    return {
      sourceDescriptor: app.sourceDescriptor,
      bootSource: app.source,
      bootFiles: app.jsSourceFiles,
      extraSource: "",
      extraFiles: [],
    };
  }

  const partPaths = collectJsParts(appPartsDir);
  const pageIndex = partPaths.indexOf(pagesPath);
  if (pageIndex === -1) {
    throw new Error("src/app/30-pages.js is missing from the ordered app source list");
  }
  const pagesSource = readUtf8(pagesPath);
  const splitIdx = pagesSource.indexOf(PAGE_EXTRA_SPLIT_MARKER);
  const initIdx = pagesSource.indexOf(PAGE_INIT_MARKER);
  if (splitIdx === -1 || initIdx === -1 || initIdx <= splitIdx) {
    throw new Error("src/app/30-pages.js does not contain the expected bundle split markers");
  }

  const corePagesSource = pagesSource.slice(0, splitIdx).replace(/\s+$/u, "");
  const extraPagesSource = pagesSource.slice(splitIdx, initIdx).replace(/\s+$/u, "");
  const initSource = pagesSource.slice(initIdx).replace(/^\s*/u, "").replace(/\s+$/u, "");
  const relPages = relative(siteRoot, pagesPath).replace(/\\/g, "/");
  const bootChunks = [];
  const bootFiles = [];
  const extraChunks = [];
  const extraFiles = [];
  for (const path of partPaths) {
    if (path === pagesPath) {
      bootChunks.push(corePagesSource, initSource);
      bootFiles.push(`${relPages}#boot`, `${relPages}#init`);
      extraChunks.push(extraPagesSource);
      extraFiles.push(`${relPages}#extra`);
      continue;
    }
    const source = readUtf8(path).replace(/\s+$/u, "");
    const relPath = relative(siteRoot, path).replace(/\\/g, "/");
    if (CRITICAL_BOOT_FILES.has(basename(path))) {
      bootChunks.push(source);
      bootFiles.push(relPath);
      continue;
    }
    if (partPaths.indexOf(path) > pageIndex) {
      extraChunks.push(source);
      extraFiles.push(relPath);
    } else {
      bootChunks.push(source);
      bootFiles.push(relPath);
    }
  }

  return {
    sourceDescriptor: "src/index.template.html + src/styles.css + src/app/*.js",
    bootSource: `${bootChunks.filter(Boolean).join("\n\n")}\n`,
    bootFiles,
    extraSource: `${extraChunks.filter(Boolean).join("\n\n")}\n`,
    extraFiles,
  };
}

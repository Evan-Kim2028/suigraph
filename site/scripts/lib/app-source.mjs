import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

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

const PAGE_EXTRA_SPLIT_MARKER = "// ── DeepBook Margin Constants";
const PAGE_INIT_MARKER = "// ── Init";

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
  const corePath = resolve(appPartsDir, "10-core.js");
  const navPath = resolve(appPartsDir, "20-navigation.js");
  const pagesPath = resolve(appPartsDir, "30-pages.js");

  if (!existsSync(corePath) || !existsSync(navPath) || !existsSync(pagesPath)) {
    const app = readAppSource(siteRoot);
    return {
      sourceDescriptor: app.sourceDescriptor,
      bootSource: app.source,
      bootFiles: app.jsSourceFiles,
      extraSource: "",
      extraFiles: [],
    };
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
  const relCore = relative(siteRoot, corePath).replace(/\\/g, "/");
  const relNav = relative(siteRoot, navPath).replace(/\\/g, "/");
  const relPages = relative(siteRoot, pagesPath).replace(/\\/g, "/");

  return {
    sourceDescriptor: "src/index.template.html + src/styles.css + src/app/*.js",
    bootSource: `${readUtf8(corePath).replace(/\s+$/u, "")}\n\n${readUtf8(navPath).replace(/\s+$/u, "")}\n\n${corePagesSource}\n\n${initSource}\n`,
    bootFiles: [relCore, relNav, `${relPages}#boot`],
    extraSource: `${extraPagesSource}\n`,
    extraFiles: [`${relPages}#extra`],
  };
}

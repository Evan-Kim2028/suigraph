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
      source: `${partPaths.map((path) => readUtf8(path).replace(/\s+$/u, "")).join("\n\n")}\n`,
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

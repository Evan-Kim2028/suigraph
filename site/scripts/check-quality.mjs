#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const TEMPLATE_PATH = resolve(SITE_ROOT, "src/index.template.html");
const CSS_PATH = resolve(SITE_ROOT, "src/styles.css");
const JS_PATH = resolve(SITE_ROOT, "src/app.js");

const template = readFileSync(TEMPLATE_PATH, "utf8");
const css = readFileSync(CSS_PATH, "utf8");
const js = readFileSync(JS_PATH, "utf8");
const rendered = template.replace("{{INLINE_CSS}}", () => css).replace("{{INLINE_JS}}", () => js);

const MAX_INLINE_STYLE_ATTRS = 500;
const MAX_PREVIEW = 5;

const INLINE_EVENT_ATTR_RE =
  /\s(?:onabort|onautocomplete|onautocompleteerror|onblur|oncancel|oncanplay|oncanplaythrough|onchange|onclick|onclose|oncontextmenu|oncuechange|ondblclick|ondrag|ondragend|ondragenter|ondragexit|ondragleave|ondragover|ondragstart|ondrop|ondurationchange|onemptied|onended|onerror|onfocus|oninput|oninvalid|onkeydown|onkeypress|onkeyup|onload|onloadeddata|onloadedmetadata|onloadstart|onmousedown|onmouseenter|onmouseleave|onmousemove|onmouseout|onmouseover|onmouseup|onmousewheel|onpaste|onpause|onplay|onplaying|onprogress|onratechange|onreset|onresize|onscroll|onsearch|onseeked|onseeking|onselect|onshow|onsubmit|onsuspend|ontimeupdate|ontoggle|ontouchcancel|ontouchend|ontouchmove|ontouchstart|onvolumechange|onwaiting|onwheel)\s*=\s*["'][^"']*["']/gi;
const DUPLICATE_CLASS_ATTR_RE = /<[^>]*\bclass="[^"]*"[^>]*\bclass="/g;
const WINDOW_HANDLER_RE = /window\.[A-Za-z0-9_]+\s*=\s*/g;
const ROUTE_PAGE_RE = /return\s+\{\s*page:\s*"([^"]+)"/g;
const BUDGET_BLOCK_RE = /const PAGE_PERF_BUDGETS = Object\.freeze\(\{([\s\S]*?)\}\);/;

function countMatches(content, pattern) {
  const m = content.match(pattern);
  return m ? m.length : 0;
}

function idxToLine(content, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function collectIssue(content, pattern, fileLabel, issueLabel) {
  const matches = [...content.matchAll(pattern)];
  if (!matches.length) return null;
  const examples = matches.slice(0, MAX_PREVIEW).map((m) => {
    const line = idxToLine(content, m.index ?? 0);
    const sample = String(m[0] || "").replace(/\s+/g, " ").trim().slice(0, 160);
    return `${fileLabel}:${line} ${sample}`;
  });
  return {
    label: issueLabel,
    count: matches.length,
    examples,
  };
}

const issues = [];

const templateInlineHandlers = collectIssue(
  template,
  INLINE_EVENT_ATTR_RE,
  "src/index.template.html",
  "Inline event handler attributes are not allowed in template source"
);
if (templateInlineHandlers) issues.push(templateInlineHandlers);

const jsInlineHandlers = collectIssue(
  js,
  INLINE_EVENT_ATTR_RE,
  "src/app.js",
  "Inline event handler attributes are not allowed in app source"
);
if (jsInlineHandlers) issues.push(jsInlineHandlers);

const duplicateClass = collectIssue(
  js,
  DUPLICATE_CLASS_ATTR_RE,
  "src/app.js",
  "Duplicate class attributes detected in HTML snippets"
);
if (duplicateClass) issues.push(duplicateClass);

const windowHandlers = countMatches(js, WINDOW_HANDLER_RE);
if (windowHandlers > 0) {
  issues.push({
    label: "window.* handler assignments are disallowed",
    count: windowHandlers,
    examples: [],
  });
}

const inlineStyles = countMatches(rendered, /style="/g);
if (inlineStyles > MAX_INLINE_STYLE_ATTRS) {
  issues.push({
    label: `Inline style attributes exceed budget (${MAX_INLINE_STYLE_ATTRS})`,
    count: inlineStyles,
    examples: [],
  });
}

const routePages = new Set([...js.matchAll(ROUTE_PAGE_RE)].map((m) => String(m[1])));
const budgetBlock = js.match(BUDGET_BLOCK_RE);
let budgetPages = new Set();
if (!budgetBlock) {
  issues.push({
    label: "Missing PAGE_PERF_BUDGETS declaration",
    count: 1,
    examples: [],
  });
} else {
  budgetPages = new Set(
    [...budgetBlock[1].matchAll(/(?:^|\n)\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))\s*:\s*\{\s*gqlCalls\s*:/g)]
      .map((m) => m[1] || m[2])
      .filter(Boolean)
  );
  const missingBudgetPages = [...routePages].filter((p) => !budgetPages.has(p));
  if (missingBudgetPages.length) {
    issues.push({
      label: "Route pages missing PAGE_PERF_BUDGETS entries",
      count: missingBudgetPages.length,
      examples: missingBudgetPages.slice(0, MAX_PREVIEW).map((p) => `route page "${p}"`),
    });
  }
}

if (issues.length) {
  console.error("check-quality: failed");
  for (const issue of issues) {
    console.error(`- ${issue.label}: ${issue.count}`);
    for (const ex of issue.examples) {
      console.error(`  - ${ex}`);
    }
  }
  process.exit(1);
}

console.log(
  `check-quality: ok (inlineStyles=${inlineStyles}, windowHandlers=${windowHandlers}, inlineEvents=0, duplicateClass=0, routePages=${routePages.size}, budgetPages=${budgetPages.size})`
);

// ── Nav Dropdown Toggle ─────────────────────────────────────────────────
function toggleDropdown(el) {
  const wasOpen = el.classList.contains("open");
  closeDropdowns();
  if (!wasOpen) {
    el.classList.add("open");
    el.querySelector(".nav-trigger")?.setAttribute("aria-expanded", "true");
  }
}
function closeDropdowns() {
  document.querySelectorAll(".nav-dropdown.open").forEach(d => {
    d.classList.remove("open");
    d.querySelector(".nav-trigger")?.setAttribute("aria-expanded", "false");
  });
}
function closeMobileNav() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  topbar.classList.remove("nav-open");
  document.querySelector(".nav-hamburger")?.setAttribute("aria-expanded", "false");
}
function flashCopyBtn(el) {
  const orig = el.innerHTML;
  el.innerHTML = "✓";
  el.classList.add("copied");
  setTimeout(() => {
    if (el.isConnected) { el.innerHTML = orig; el.classList.remove("copied"); }
  }, 1200);
}
document.addEventListener("click", (e) => {
  const actionEl = e.target?.closest?.("[data-action]");
  if (actionEl) {
    const action = actionEl.getAttribute("data-action");
    if (action === "nav-toggle-dropdown") {
      e.preventDefault();
      e.stopPropagation();
      const menu = actionEl.closest(".nav-dropdown");
      if (menu) toggleDropdown(menu);
      return;
    } else if (action === "nav-close-dropdowns") {
      closeDropdowns();
      closeMobileNav();
    } else if (action === "nav-toggle-mobile") {
      e.stopPropagation();
      const topbar = document.querySelector(".topbar");
      if (!topbar) return;
      const isOpen = topbar.classList.toggle("nav-open");
      actionEl.setAttribute("aria-expanded", String(isOpen));
      return;
    } else if (action === "toggle-theme") {
      toggleTheme();
      return;
    } else if (action === "toggle-view-mode") {
      toggleViewMode();
      return;
    } else if (action === "copy-text") {
      const text = actionEl.getAttribute("data-copy-text") || "";
      navigator.clipboard.writeText(text).then(() => flashCopyBtn(actionEl)).catch(() => {});
    } else if (action === "copy-link") {
      navigator.clipboard.writeText(window.location.href).then(() => flashCopyBtn(actionEl)).catch(() => {});
    } else if (action === "copy-text-flash") {
      const text = actionEl.getAttribute("data-copy-text") || "";
      navigator.clipboard.writeText(text).then(() => {
        const original = actionEl.textContent;
        actionEl.textContent = "Copied!";
        setTimeout(() => {
          if (actionEl.isConnected) actionEl.textContent = original || "Copy";
        }, 1200);
      }).catch(() => {});
    } else if (action === "jtree-toggle") {
      const targetId = actionEl.getAttribute("data-target-id") || "";
      const content = targetId ? document.getElementById(targetId) : null;
      if (content) {
        actionEl.classList.toggle("open");
        content.classList.toggle("jtree-hidden");
        actionEl.nextElementSibling?.classList.toggle("jtree-hidden");
        content.nextElementSibling?.classList.toggle("jtree-hidden");
      }
    } else if (action === "set-view-mode-advanced") {
      setViewMode("advanced", true);
    }
  }
  if (!e.target.closest(".nav-dropdown")) closeDropdowns();
  if (!e.target.closest(".topbar")) closeMobileNav();
});
document.addEventListener("touchend", (e) => {
  if (!e.target.closest(".nav-dropdown")) closeDropdowns();
  if (!e.target.closest(".topbar")) closeMobileNav();
});
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!img || img.tagName !== "IMG") return;
  if (img.getAttribute("data-hide-on-error") !== "1") return;
  img.style.display = "none";
}, true);

// ── View Mode (Simple / Advanced) ─────────────────────────────────────
const VIEW_MODE_KEY = "sui_explorer_view_mode";
let uiViewMode = "simple";

function normalizeViewMode(v) {
  return v === "advanced" ? "advanced" : "simple";
}

function applyViewModeButton() {
  const btn = document.getElementById("view-mode-toggle");
  if (!btn) return;
  const isAdv = uiViewMode === "advanced";
  btn.textContent = isAdv ? "Advanced" : "Simple";
  btn.setAttribute("aria-pressed", isAdv ? "true" : "false");
  btn.title = isAdv ? "Switch to Simple view" : "Switch to Advanced view";
}

function loadViewMode() {
  try {
    uiViewMode = normalizeViewMode(localStorage.getItem(VIEW_MODE_KEY) || "simple");
  } catch (e) {
    uiViewMode = "simple";
  }
  applyViewModeButton();
}

function setViewMode(mode, rerender = true) {
  const next = normalizeViewMode(mode);
  uiViewMode = next;
  try { localStorage.setItem(VIEW_MODE_KEY, next); } catch (e) { /* ignore */ }
  applyViewModeButton();
  if (rerender) routeTo(getRoute());
}

function toggleViewMode() {
  setViewMode(uiViewMode === "advanced" ? "simple" : "advanced", true);
}

// ── Theme (Midnight / Dawn / Mint) ────────────────────────────────────
const THEME_KEY = "sui_explorer_theme";
const UI_THEMES = [
  { id: "midnight", label: "Midnight" },
  { id: "dawn", label: "Dawn" },
  { id: "mint", label: "Mint" },
];
let uiTheme = "midnight";

function normalizeTheme(v) {
  const id = String(v || "").toLowerCase();
  return UI_THEMES.some(t => t.id === id) ? id : "midnight";
}

function applyTheme() {
  const root = document.documentElement;
  if (uiTheme === "midnight") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", uiTheme);
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const cur = UI_THEMES.find(t => t.id === uiTheme) || UI_THEMES[0];
  btn.textContent = cur.label;
  btn.title = "Switch visual theme";
}

function loadTheme() {
  try {
    uiTheme = normalizeTheme(localStorage.getItem(THEME_KEY) || "midnight");
  } catch (e) {
    uiTheme = "midnight";
  }
  applyTheme();
}

function setTheme(themeId, rerender = false) {
  uiTheme = normalizeTheme(themeId);
  try { localStorage.setItem(THEME_KEY, uiTheme); } catch (e) { /* ignore */ }
  applyTheme();
  if (rerender) routeTo(getRoute());
}

function toggleTheme() {
  const idx = UI_THEMES.findIndex(t => t.id === uiTheme);
  const next = UI_THEMES[(idx + 1) % UI_THEMES.length];
  setTheme(next.id, false);
}

// ── Persisted Timed Cache ───────────────────────────────────────────────
function readPersistedTimedCacheRecord(storageKey, ttlMs) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const row = JSON.parse(raw);
    const ts = Number(row?.ts || 0);
    if (!ts || (Date.now() - ts) > ttlMs) {
      localStorage.removeItem(storageKey);
      return null;
    }
    return { data: row?.data ?? null, ts };
  } catch (e) {
    return null;
  }
}

function initPersistedTimedCacheState(storageKey, ttlMs) {
  const row = readPersistedTimedCacheRecord(storageKey, ttlMs);
  return {
    data: row?.data ?? null,
    ts: row?.ts ?? 0,
    inFlight: null,
  };
}

function writePersistedTimedCacheRecord(storageKey, data, maxChars = 180000) {
  try {
    const payload = JSON.stringify({ ts: Date.now(), data });
    if (payload.length > maxChars) return;
    localStorage.setItem(storageKey, payload);
  } catch (e) { /* ignore */ }
}

function hydratePersistedTimedCacheState(cacheState, storageKey, ttlMs) {
  if (!cacheState || cacheState.data || cacheState.inFlight) return cacheState;
  const row = readPersistedTimedCacheRecord(storageKey, ttlMs);
  if (!row) return cacheState;
  cacheState.data = row.data ?? null;
  cacheState.ts = row.ts ?? 0;
  return cacheState;
}

function persistedWindowCacheKey(prefix, windowKey, version = "v1") {
  return `${prefix}_${normalizeDefiWindowKey(windowKey)}_${version}`;
}

function persistedEntityCacheKey(prefix, id, version = "v1") {
  const normalized = normalizeSuiAddress(id) || String(id || "").trim().toLowerCase();
  return `${prefix}_${normalized}_${version}`;
}

function persistedScalarCacheKey(prefix, id, version = "v1") {
  return `${prefix}_${String(id ?? "").trim().toLowerCase()}_${version}`;
}

// ── Lightweight Page Perf ──────────────────────────────────────────────
const PERF_WARN_RENDER_MS = 1800;
const DEFAULT_PAGE_GQL_BUDGET = 12;
const PAGE_PERF_BUDGETS = Object.freeze({
  home: { gqlCalls: 12, renderMs: 1800 },
  checkpoints: { gqlCalls: 4, renderMs: 1200 },
  checkpoint: { gqlCalls: 4, renderMs: 1400 },
  txs: { gqlCalls: 4, renderMs: 1200 },
  tx: { gqlCalls: 9, renderMs: 2000 },
  address: { gqlCalls: 95, renderMs: 4000 },
  object: { gqlCalls: 14, renderMs: 2000 },
  graphql: { gqlCalls: 2, renderMs: 1000 },
  epoch: { gqlCalls: 4, renderMs: 1200 },
  transfers: { gqlCalls: 5, renderMs: 1400 },
  congestion: { gqlCalls: 12, renderMs: 1900 },
  validators: { gqlCalls: 3, renderMs: 1200 },
  events: { gqlCalls: 4, renderMs: 1500 },
  coin: { gqlCalls: 20, renderMs: 2600 },
  "defi-overview": { gqlCalls: 33, renderMs: 2500 },
  "defi-rates": { gqlCalls: 20, renderMs: 2500 },
  "defi-dex": { gqlCalls: 20, renderMs: 2500 },
  "defi-stablecoins": { gqlCalls: 20, renderMs: 2500 },
  "defi-lst": { gqlCalls: 20, renderMs: 2500 },
  "defi-flows": { gqlCalls: 18, renderMs: 2200 },
  "defi-perps": { gqlCalls: 12, renderMs: 2000 },
  protocol: { gqlCalls: 2, renderMs: 1200 },
  packages: { gqlCalls: 14, renderMs: 2200 },
  simulate: { gqlCalls: 3, renderMs: 1300 },
  docs: { gqlCalls: 1, renderMs: 900 },
});
let pagePerf = null;
let perfBadgeUpdateHandle = 0;

function schedulePerfBadgeUpdate() {
  if (perfBadgeUpdateHandle) return;
  const flush = () => {
    perfBadgeUpdateHandle = 0;
    applyPerfBadge();
  };
  if (typeof requestAnimationFrame === "function") {
    perfBadgeUpdateHandle = requestAnimationFrame(flush);
    return;
  }
  perfBadgeUpdateHandle = setTimeout(flush, 0);
}

function startPagePerf(page) {
  const budget = PAGE_PERF_BUDGETS[page] || {};
  pagePerf = {
    page,
    startedAt: performance.now(),
    budgetGqlCalls: Number.isFinite(budget.gqlCalls) ? budget.gqlCalls : DEFAULT_PAGE_GQL_BUDGET,
    budgetRenderMs: Number.isFinite(budget.renderMs) ? budget.renderMs : PERF_WARN_RENDER_MS,
    gqlCalls: 0,
    gqlMs: 0,
    reqBytes: 0,
    resBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
    dedupedGql: 0,
    retriedGql: 0,
    firstGqlAtMs: null,
    lastGqlAtMs: null,
    detailRows: Object.create(null),
    queryStats: Object.create(null),
    status: "loading",
  };
  applyPerfBadge();
}

function notePerfCache(hit) {
  if (!pagePerf) return;
  if (hit) pagePerf.cacheHits++;
  else pagePerf.cacheMisses++;
  schedulePerfBadgeUpdate();
}

function notePerfGql(elapsedMs, reqBytes, resBytes, queryKey = "", ok = true) {
  if (!pagePerf) return;
  pagePerf.gqlCalls++;
  pagePerf.gqlMs += Number(elapsedMs) || 0;
  pagePerf.reqBytes += Number(reqBytes) || 0;
  pagePerf.resBytes += Number(resBytes) || 0;
  const atMs = Math.round(performance.now() - pagePerf.startedAt);
  if (!Number.isFinite(pagePerf.firstGqlAtMs)) pagePerf.firstGqlAtMs = atMs;
  pagePerf.lastGqlAtMs = atMs;
  const qk = String(queryKey || "").trim();
  if (!qk) {
    schedulePerfBadgeUpdate();
    return;
  }
  if (!pagePerf.queryStats[qk]) {
    pagePerf.queryStats[qk] = { calls: 0, errors: 0, ms: 0, samples: [] };
  }
  const row = pagePerf.queryStats[qk];
  row.calls += 1;
  row.ms += Number(elapsedMs) || 0;
  if (!ok) row.errors += 1;
  row.samples.push(Number(elapsedMs) || 0);
  if (row.samples.length > 120) row.samples.shift();
  schedulePerfBadgeUpdate();
}

function notePerfGqlDeduped() {
  if (!pagePerf) return;
  pagePerf.dedupedGql += 1;
  schedulePerfBadgeUpdate();
}

function notePerfGqlRetry() {
  if (!pagePerf) return;
  pagePerf.retriedGql += 1;
  schedulePerfBadgeUpdate();
}

function setPagePerfDetailRow(key, row) {
  if (!pagePerf) return;
  const id = String(key || "").trim();
  if (!id) return;
  if (!row) {
    delete pagePerf.detailRows[id];
    applyPerfBadge();
    return;
  }
  pagePerf.detailRows[id] = {
    label: String(row.label || id),
    value: String(row.value || ""),
    sub: String(row.sub || ""),
    warn: !!row.warn,
  };
  applyPerfBadge();
}

function getPerfAssetRows() {
  const entries = performance.getEntriesByType("resource");
  if (!entries?.length) return [];
  const rows = [];
  const pick = (needle) => entries.find((entry) => String(entry?.name || "").includes(needle));
  const push = (label, needle) => {
    const entry = pick(needle);
    if (!entry) return;
    const bytes = Math.max(Number(entry.transferSize || 0), Number(entry.encodedBodySize || 0));
    rows.push({
      label,
      value: `${Math.round(entry.duration)}ms`,
      sub: bytes > 0 ? `${fmtNumber(bytes)} bytes` : "",
    });
  };
  push("Asset app.js", "/assets/app.js");
  push("Asset extra.js", "/assets/app-extra.js");
  push("Asset styles", "/assets/styles.css");
  return rows;
}

function getPerfNavigationRows() {
  const nav = performance.getEntriesByType("navigation")?.[0];
  if (!nav) return [];
  const rows = [];
  const push = (label, value) => {
    if (!(Number.isFinite(value) && value > 0)) return;
    rows.push({ label, value: `${Math.round(value)}ms` });
  };
  push("Nav resp", nav.responseEnd);
  push("Nav DCL", nav.domContentLoadedEventEnd);
  push("Nav load", nav.loadEventEnd);
  return rows;
}

function topPageQueryPerf(queryStats) {
  const rows = Object.entries(queryStats || {});
  if (!rows.length) return null;
  let best = null;
  for (const [key, stat] of rows) {
    const samples = (stat?.samples || []).filter(Number.isFinite);
    const p95 = samples.length ? quantile(samples, 0.95) : 0;
    const totalMs = Number(stat?.ms || 0);
    const score = Math.max(Number.isFinite(p95) ? p95 : 0, totalMs / Math.max(1, Number(stat?.calls || 1)));
    if (!best || score > best.score) {
      best = {
        key,
        calls: Number(stat?.calls || 0),
        errors: Number(stat?.errors || 0),
        totalMs,
        p95: Number.isFinite(p95) ? p95 : 0,
        score,
      };
    }
  }
  return best;
}

function finishPagePerf(status = "ok") {
  if (!pagePerf) return;
  pagePerf.status = status;
  pagePerf.renderMs = Math.round(performance.now() - pagePerf.startedAt);
  applyPerfBadge();
}

function applyPerfBadge() {
  const el = document.getElementById("perf-badge");
  if (!el) return;
  if (!pagePerf) {
    el.textContent = "Idle";
    el.style.color = "var(--text-dim)";
    el.style.borderColor = "var(--border)";
    el._perfRows = null;
    initPerfTooltip(el);
    return;
  }
  const render = pagePerf.renderMs != null ? pagePerf.renderMs : Math.round(performance.now() - pagePerf.startedAt);
  const budgetGqlCalls = Number(pagePerf.budgetGqlCalls || 0);
  const budgetRenderMs = Number(pagePerf.budgetRenderMs || PERF_WARN_RENDER_MS);
  const txt = `${String(pagePerf.page || "page").replace(/^defi-/, "defi:")} ${render}ms • gql ${pagePerf.gqlCalls}/${budgetGqlCalls} • cache ${pagePerf.cacheHits}/${pagePerf.cacheMisses}`;
  el.textContent = txt;
  const warn = pagePerf.status === "error"
    || render > budgetRenderMs
    || (budgetGqlCalls > 0 && pagePerf.gqlCalls > budgetGqlCalls);
  el.style.color = warn ? "var(--yellow)" : "var(--text-dim)";
  el.style.borderColor = warn ? "var(--yellow)" : "var(--border)";
  const topQuery = topPageQueryPerf(pagePerf.queryStats);
  const lastGqlTail = Number.isFinite(pagePerf.lastGqlAtMs)
    ? Math.max(0, pagePerf.lastGqlAtMs - render)
    : NaN;
  const detailRows = Object.values(pagePerf.detailRows || {});
  el._perfRows = [
    { label: "Page",       value: pagePerf.page || "unknown" },
    { label: "Status",     value: pagePerf.status, warn: pagePerf.status === "error" },
    { label: "Render",     value: `${render}ms`, sub: `budget ${budgetRenderMs}ms`, warn: render > budgetRenderMs },
    { label: "GQL calls",  value: String(pagePerf.gqlCalls), sub: `budget ${budgetGqlCalls}`, warn: budgetGqlCalls > 0 && pagePerf.gqlCalls > budgetGqlCalls },
    { label: "GQL time",   value: `${Math.round(pagePerf.gqlMs)}ms` },
    ...(Number.isFinite(pagePerf.lastGqlAtMs) ? [{
      label: "Last GQL",
      value: `${pagePerf.lastGqlAtMs}ms`,
      sub: lastGqlTail > 0 ? `+${lastGqlTail}ms after render` : "within render window",
      warn: lastGqlTail > 1500,
    }] : []),
    { label: "Req bytes",  value: fmtNumber(Math.round(pagePerf.reqBytes)) },
    { label: "Res bytes",  value: fmtNumber(Math.round(pagePerf.resBytes)) },
    { label: "GQL dedupe", value: String(pagePerf.dedupedGql || 0) },
    { label: "GQL retries", value: String(pagePerf.retriedGql || 0) },
    ...(topQuery ? [{
      label: "Top Query",
      value: topQuery.key,
      sub: `${Math.round(topQuery.totalMs)}ms total · p95 ${Math.round(topQuery.p95)}ms · calls ${topQuery.calls}${topQuery.errors ? ` · err ${topQuery.errors}` : ""}`,
    }] : []),
    { label: "Cache",      value: `${pagePerf.cacheHits} hits / ${pagePerf.cacheMisses} misses` },
    ...getPerfNavigationRows(),
    ...getPerfAssetRows(),
    ...detailRows,
  ];
  initPerfTooltip(el);
}

function initPerfTooltip(el) {
  if (el._perfTooltipInit) return;
  el._perfTooltipInit = true;
  const tip = document.getElementById("perf-tooltip");
  if (!tip) return;
  el.addEventListener("mouseenter", () => {
    const rows = el._perfRows;
    if (!rows) return;
    tip.innerHTML = rows.map(r =>
      `<div class="pt-row"><span class="pt-label">${r.label}</span><span class="pt-value${r.warn ? " pt-warn" : ""}">${r.value}${r.sub ? ` <span class="pt-sub">(${r.sub})</span>` : ""}</span></div>`
    ).join("");
    const rect = el.getBoundingClientRect();
    tip.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    tip.style.right = (window.innerWidth - rect.right) + "px";
    tip.classList.add("visible");
  });
  el.addEventListener("mouseleave", () => tip.classList.remove("visible"));
}

// ── Config ──────────────────────────────────────────────────────────────
const GQL = "https://graphql.mainnet.sui.io/graphql";
const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

// ── DeFi Protocol Constants ────────────────────────────────────────────
// Pool oracle: on-chain pricing via Cetus + Bluefin CLMM pools
const POOL_ORACLE_PRICE_TTL_MS = 15_000;
const POOL_ORACLE_DISCOVERY_TTL_MS = 10 * 60_000;
const POOL_ORACLE_DISCOVERY_PER_ALIAS = 10;
const CETUS_POOL_TYPE_PREFIX = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool";
const BLUEFIN_POOL_TYPE_PREFIX = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool";
const QUOTE_COINS = {
  SUI: { type: "0x2::sui::SUI", decimals: 9 },
  USDC: { type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", decimals: 6 },
};
const POOL_ORACLE_SKIP = new Set(["SUI", "USDC", "USDT", "wUSDC", "BUCK", "AUSD", "FDUSD", "USDY", "SUI_USDE", "suiUSDe", "USDSUI"]);
const USD_PEGGED_SYMBOLS = new Set(["USDC", "USDT", "wUSDC", "BUCK", "AUSD", "FDUSD", "USDY", "SUI_USDE", "suiUSDe", "USDSUI"]);
const SUI_PEGGED_SYMBOLS = new Set(["haSUI", "afSUI", "vSUI", "sSUI", "HASUI", "SPRING_SUI", "MSUI", "KSUI", "CERT", "stSUI", "mSUI", "kSUI"]);
const BTC_PEGGED_SYMBOLS = new Set(["WBTC", "BTC", "LBTC", "stBTC", "enzoBTC", "MBTC", "YBTC", "XBTC", "EXBTC", "tBTC", "TBTC", "BTCvc"]);
const BTC_PRICE_SOURCE = "xBTC";
const EMBER_RATE_SCALE = 1_000_000_000n;
let poolAddressCache = {};
let oraclePricesTs = 0;
const COMMON_DECIMALS = {
  SUI: 9, USDC: 6, USDT: 6, DEEP: 6, WAL: 9, WBTC: 8, WETH: 8, ETH: 8,
  NAVX: 9, CETUS: 9, BLUE: 9, MSUI: 9, KSUI: 9, CERT: 9, stSUI: 9,
  sSUI: 9, SPRING_SUI: 9, IKA: 9, HASUI: 9, haSUI: 9, afSUI: 9, vSUI: 9,
  BUCK: 9, AUSD: 6, FUD: 5, XBTC: 8, wUSDC: 6, mSUI: 9, kSUI: 9,
  BTC: 8, LBTC: 8, stBTC: 8, enzoBTC: 8, MBTC: 8, YBTC: 8, xBTC: 8, tBTC: 8, TBTC: 8, BTCvc: 8,
  SOL: 8, NS: 6, SEND: 6, HAEDAL: 9, ALKIMI: 9, XAUM: 9, UP: 6,
  SCA: 9, LOFI: 9,
  FDUSD: 6, USDY: 6, SUI_USDE: 6, suiUSDe: 6, USDSUI: 6,
};
let defiPrices = {};
let defiPricesByCoinType = {};
const DEEPBOOK_SPOT_PACKAGE = "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809";
const DEEPBOOK_SUI_USDC_POOL = "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407";
const DEEPBOOK_BASE_DECIMALS = 9;  // SUI
const DEEPBOOK_QUOTE_DECIMALS = 6; // USDC
const DEEPBOOK_PRICE_LOOKBACK_VERSIONS = 12;
const DEEPBOOK_PRICE_EVENTS_PER_TX = 30;
const DEEPBOOK_SUI_PRICE_TTL_MS = 15 * 1000;
const DEFI_ACTIVITY_TTL_MS = 25 * 1000;
const DEFI_OVERVIEW_TTL_MS = 45 * 1000;
const DEFI_DEX_TTL_MS = 30 * 1000;
const DEFI_STABLECOINS_TTL_MS = 45 * 1000;
const DEFI_LST_TTL_MS = 60 * 1000;
const DEFI_FLOWS_TTL_MS = 25 * 1000;

const DEFI_HISTORY_TTL_MS = 10 * 60 * 1000;
const GQL_SERVICE_CONFIG_TTL_MS = 30 * 60 * 1000;
const PACKAGE_ACTIVITY_TTL_MS = 30 * 1000;
const PACKAGE_DETAIL_TTL_MS = 2 * 60 * 1000;
const ECOSYSTEM_TTL = 10 * 60 * 1000;
const DEFI_HISTORY_DAY_MS = 24 * 60 * 60 * 1000;
const DEFI_HISTORY_BOOTSTRAP_CP_DELTA = 1_000_000;
const DEFAULT_DEFI_HISTORY_OBJECT = "0x53041c6f86c4782aabbfc1d4fe234a6d37160310c7ee740c915f0a01b7127344";
const DEFAULT_DEFI_HISTORY_FORMAT = "{state.total_supply:json}";
const DEFI_HISTORY_PRESETS = {
  "1D": { label: "1D", days: 1, segmentDays: 1 },
  "1W": { label: "1W", days: 7, segmentDays: 7 },
  "1M": { label: "1M", days: 30, segmentDays: 5 },
  "2M": { label: "2M", days: 60, segmentDays: 7 },
};
const DEFI_WINDOW_DEFAULT_KEY = "fast";
const DEFI_WINDOW_PRESETS = {
  fast: { label: "Fast", hours: 1, maxCalls: 3, maxMs: 1800, pageSize: 40 },
  "1H": { label: "1H", hours: 1, maxCalls: 8, maxMs: 4500, pageSize: 50 },
  "6H": { label: "6H", hours: 6, maxCalls: 12, maxMs: 9000, pageSize: 50 },
  "24H": { label: "24H", hours: 24, maxCalls: 18, maxMs: 14000, pageSize: 50 },
};
const DEFI_WINDOW_SAMPLE_PROJECTIONS = Object.freeze({
  base: {
    includeCommands: true,
    includeBalanceChanges: false,
    includeObjectChanges: false,
    includeEvents: false,
    includeGasEffects: false,
  },
  flow: {
    includeCommands: true,
    includeBalanceChanges: true,
    includeObjectChanges: false,
    includeEvents: false,
    includeGasEffects: false,
  },
  package: {
    includeCommands: true,
    includeBalanceChanges: false,
    includeObjectChanges: true,
    includeEvents: true,
    includeGasEffects: true,
  },
  full: {
    includeCommands: true,
    includeBalanceChanges: true,
    includeObjectChanges: true,
    includeEvents: true,
    includeGasEffects: true,
  },
});
const DEFI_WINDOW_SAMPLE_TTL_MS = 20 * 1000;
const DASH_EPOCHS_TTL_MS = 60 * 1000;
const DASHBOARD_HEAD_TTL_MS = 10 * 1000;
const DASHBOARD_ACTIVITY_TTL_MS = 10 * 1000;
const DEFI_PRICE_PERSIST_TTL_MS = 15 * 1000;
const LIST_PAGE_TTL_MS = 15 * 1000;
const ENTITY_SHELL_TTL_MS = 20 * 1000;
const SEARCH_CLASSIFIER_TTL_MS = 10 * 60 * 1000;
const PERSISTED_CACHE_KEYS = Object.freeze({
  dashboardHead: "suigraph_cache_dashboard_head_v1",
  dashboardActivity: "suigraph_cache_dashboard_activity_v1",
  lendingRates: "suigraph_cache_lending_rates_v1",
  defiPrices: "suigraph_cache_defi_prices_v1",
  defiOverviewPrefix: "suigraph_cache_defi_overview_v2",
  defiDexPrefix: "suigraph_cache_defi_dex",
  packageActivityPrefix: "suigraph_cache_package_activity",
  defiStablecoinsPrefix: "suigraph_cache_defi_stablecoins_v2",
  defiFlowsPrefix: "suigraph_cache_defi_flows",
  defiLst: "suigraph_cache_defi_lst_v1",
  dashboardEpochs: "suigraph_cache_dashboard_epochs_v1",
  ecosystemStats: "suigraph_cache_ecosystem_stats_v2",
  stablecoinSupply: "suigraph_cache_stablecoin_supply_v3",
  checkpointsListFirstPage: "suigraph_cache_checkpoints_first_page_v1",
  transactionsListFirstPage: "suigraph_cache_transactions_first_page_v1",
  addressShellPrefix: "suigraph_cache_address_shell",
  checkpointDetailPrefix: "suigraph_cache_checkpoint_detail",
  epochDetailPrefix: "suigraph_cache_epoch_detail",
  searchTargetPrefix: "suigraph_cache_search_target",
});
let deepbookSuiPriceTs = 0;
let defiPricesInFlight = null;
const LENDING_RATES_TTL_MS = 60 * 1000;
const PROTOCOL_SUPPORTED_COIN_TYPES_TTL_MS = 30 * 60 * 1000;
const ADDRESS_BALANCE_TTL_MS = 20 * 1000;
const ADDRESS_BALANCE_PAGE_SIZE = 50;
const ADDRESS_BALANCE_MAX_PAGES = 20;
const PROTOCOL_METADATA_MAX_PAGES = 12;
let lendingRatesCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.lendingRates, LENDING_RATES_TTL_MS);
let protocolSupportedCoinTypesCache = { data: null, ts: 0, inFlight: null };
let lendingRatesInFlight = null;
let defiLstCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.defiLst, DEFI_LST_TTL_MS);
let gqlServiceConfigCache = { data: null, ts: 0, inFlight: null };
let ecosystemCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.ecosystemStats, ECOSYSTEM_TTL);
let stablecoinCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.stablecoinSupply, ECOSYSTEM_TTL);
const defiHistoryCache = {};
const packageDetailCache = {};
const txShellCache = {};
const objectShellCache = {};
const searchClassificationCache = {};
const addressShellCache = {};
const checkpointDetailCache = {};
const epochDetailCache = {};
const addressBalanceCache = {};
const defiActivityCacheByWindow = {};
const defiOverviewCacheByWindow = {};
const defiDexCacheByWindow = {};
const defiStablecoinsCacheByWindow = {};
const defiFlowsCacheByWindow = {};
const packageActivityCacheByWindow = {};
const defiOverviewParityCacheByWindow = {};
const defiWindowSampleCacheByProjection = {
  base: {},
  flow: {},
  package: {},
  full: {},
};
let dashboardHeadCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.dashboardHead, DASHBOARD_HEAD_TTL_MS);
let dashboardActivityCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.dashboardActivity, DASHBOARD_ACTIVITY_TTL_MS);
let dashboardEpochsCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.dashboardEpochs, DASH_EPOCHS_TTL_MS);
let checkpointsListCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.checkpointsListFirstPage, LIST_PAGE_TTL_MS);
let transactionsListCache = initPersistedTimedCacheState(PERSISTED_CACHE_KEYS.transactionsListFirstPage, LIST_PAGE_TTL_MS);

// Known coin type address prefixes → { symbol, decimals }
// Fixes decimal parsing for bridge tokens whose type ends in ::coin::COIN etc.
const KNOWN_COIN_TYPES = {
  "0x2::sui::SUI": { symbol: "SUI", decimals: 9 },
  // ── Stablecoins ──
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": { symbol: "USDC", decimals: 6 },
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN": { symbol: "wUSDC", decimals: 6 },
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN": { symbol: "USDT", decimals: 6 },
  "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT": { symbol: "USDT", decimals: 6 },
  "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK": { symbol: "BUCK", decimals: 9 },
  "0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD": { symbol: "AUSD", decimals: 6 },
  "0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD": { symbol: "FDUSD", decimals: 6 },
  "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY": { symbol: "USDY", decimals: 6 },
  "0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::usde::USDE": { symbol: "SUI_USDE", decimals: 6 },
  "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE": { symbol: "suiUSDe", decimals: 6 },
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI": { symbol: "USDSUI", decimals: 6 },
  // ── ETH variants ──
  "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN": { symbol: "WETH", decimals: 8 },
  "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH": { symbol: "ETH", decimals: 8 },
  // ── BTC variants ──
  "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN": { symbol: "WBTC", decimals: 8 },
  "0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC": { symbol: "WBTC", decimals: 8 },
  "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC": { symbol: "BTC", decimals: 8 },
  "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC": { symbol: "xBTC", decimals: 8 },
  "0x77045f1b9f811a7a8fb9ebd085b5b0c55c5cb0d1520ff55f7037f89b5da9f5f1::TBTC::TBTC": { symbol: "tBTC", decimals: 8 },
  "0xd8fe9619ff2bcef53e0330b83b31ab380a04ee787dafecc19aac365a9824517f::btcvc::BTCVC": { symbol: "BTCvc", decimals: 8 },
  "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC": { symbol: "LBTC", decimals: 8 },
  "0x5f496ed5d9d045c5b788dc1bb85f54100f2ede11e46f6a232c29daada4c5bdb6::coin::COIN": { symbol: "stBTC", decimals: 8 },
  "0x8f2b5eb696ed88b71fea398d330bccfa52f6e2a5a8e1ac6180fcb25c6de42ebc::coin::COIN": { symbol: "enzoBTC", decimals: 8 },
  "0xd1a91b46bd6d966b62686263609074ad16cfdffc63c31a4775870a2d54d20c6b::mbtc::MBTC": { symbol: "MBTC", decimals: 8 },
  "0xa03ab7eee2c8e97111977b77374eaf6324ba617e7027382228350db08469189e::ybtc::YBTC": { symbol: "YBTC", decimals: 8 },
  // ── SOL ──
  "0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN": { symbol: "SOL", decimals: 8 },
  // ── LSTs ──
  "0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI": { symbol: "sSUI", decimals: 9 },
  "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI": { symbol: "haSUI", decimals: 9 },
  "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI": { symbol: "afSUI", decimals: 9 },
  "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT": { symbol: "vSUI", decimals: 9 },
  "0x922d15d7f55c13fd790f6e54397470ec592caa2b508df292a2e8553f3d3b274f::msui::MSUI": { symbol: "mSUI", decimals: 9 },
  "0x41ff228bfd566f0c707173ee6413962a77e3929588d010250e4e76f0d1cc0ad4::ksui::KSUI": { symbol: "kSUI", decimals: 9 },
  "0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::stsui::STSUI": { symbol: "stSUI", decimals: 9 },
  // ── DeFi protocol tokens ──
  "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS": { symbol: "CETUS", decimals: 9 },
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP": { symbol: "DEEP", decimals: 6 },
  "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL": { symbol: "WAL", decimals: 9 },
  "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX": { symbol: "NAVX", decimals: 9 },
  "0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca::blue::BLUE": { symbol: "BLUE", decimals: 9 },
  "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS": { symbol: "NS", decimals: 6 },
  "0x3a304c7feba2d819ea57c3542d68439ca2c386ba02159c740f7b406e592c62ea::haedal::HAEDAL": { symbol: "HAEDAL", decimals: 9 },
  "0xb45fcfcc2cc07ce0702cc2d229621e046c906ef14d9b25e8e4d25f6e8763fef7::send::SEND": { symbol: "SEND", decimals: 6 },
  "0x3c1e5a06dfa28e3823c6a2e9b999f74c12b3e72d38e4a056be0e0bb22df3bb1a::ika::IKA": { symbol: "IKA", decimals: 9 },
  "0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA": { symbol: "IKA", decimals: 9 },
  "0x1a8f4bc33f8ef7fbc851f156857aa65d397a6a6fd27a7ac2ca717b51f2fd9489::alkimi::ALKIMI": { symbol: "ALKIMI", decimals: 9 },
  "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA": { symbol: "SCA", decimals: 9 },
  "0xf22da9a24ad027cccb5f2d496cbe91de953d363513db08a3a734d361c7c17503::LOFI::LOFI": { symbol: "LOFI", decimals: 9 },
  "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM": { symbol: "XAUM", decimals: 9 },
  "0x76cb819b01abed502bee8a702b4c2d547532c12f25001c9dea795a5e631c26f1::fud::FUD": { symbol: "FUD", decimals: 5 },
  "0x87dfe1248a1dc4ce473bd9cb2937d66cdc6c30fee63f3fe0dbb55c7a09d35dec::up::UP": { symbol: "UP", decimals: 6 },
};

const EMBER_SUI_VAULTS = {
  "0x88eb44ba72b24f31bcd022e6a0f85e149f533ee5319cb4891f2eab0ef37baa34::eacred::EACRED": { vaultObjectId: "0xc73fc473135e790d62f31f64859f602c6fa136615e92e0f789427c8a11b1b744", vaultName: "Ember Apollo ACRED", receiptSymbol: "eACRED", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Third Eye", targetApyPct: 10.0 },
  "0x34469c8accdd673df02600265cbbad3688577f0e716866e257f88d448d463492::eearn::EEARN": { vaultObjectId: "0x0779d2a4e1a6d3412982404cfe5567aac8cea229f17622c7b72d198b22a22e37", vaultName: "Ember Earn Vault", receiptSymbol: "eEARN", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Ember", targetApyPct: 10.0 },
  "0xe5401963924c21a3b2fafda7869dc0acd91571443b5c08215550e24d26c6e8a2::esuig::ESUIG": { vaultObjectId: "0x7c79c55ba1c1273585eea36482ddaa12196830a3a746a27b40f9771d6fa1db18", vaultName: "Ember SUIG Vault", receiptSymbol: "eSUIG", receiptDecimals: 9, depositCoinType: "0x2::sui::SUI", depositSymbol: "SUI", depositDecimals: 9, managerLabel: "Ember, SUIG", targetApyPct: 5.0 },
  "0xc360f622a9e77bb774061c44c11915e3cfc4242488cd668652dbff39cf0cdd58::esuiusde::ESUIUSDE": { vaultObjectId: "0x2a906b7633db9fca6c2f16c1efe73c7e289dfce8ed64a98ec5a5be10a9fb9aa1", vaultName: "suiUSDe Vault", receiptSymbol: "esuiUSDe", receiptDecimals: 6, depositCoinType: "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE", depositSymbol: "suiUSDe", depositDecimals: 6, managerLabel: "SUIG, Ember", targetApyPct: 10.0 },
  "0x820dd6ead8b56abb89a76cfc8e676703876a906a2e4dddde6c18c8052e5fd194::mrcusd::MRCUSD": { vaultObjectId: "0x6013f760aa089ef027e9b92f7c09edf5fef73ef6b48fc5ecd8af62a4ef2db3d8", vaultName: "R25 Treasury Vault", receiptSymbol: "mrcUSD", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Ember, R25", targetApyPct: 14.0 },
  "0x001f2e09f885ad96d8b00cf87f4a12ba08643c599f873b5a66173a1682489877::eudl::EUDL": { vaultObjectId: "0x4ae973cffb815734db41cfd1674a7bf7a892727870778103290054aa0efe7e94", vaultName: "UDL Vault", receiptSymbol: "eUDL", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "UDL", targetApyPct: 12.0 },
  "0xab7ef01122a9e54e2c46a1fc280a3e008b06c7e3f9accc0f4c141b71f3183a61::vbtcvc::VBTCVC": { vaultObjectId: "0xb3ccbc12cd633d3a8da0cf97a4d89f771a9bd8c0cd8ce321de13edc11cfb3e1c", vaultName: "Vishwa BTC Vault", receiptSymbol: "vBTCvc", receiptDecimals: 8, depositCoinType: "0xd8fe9619ff2bcef53e0330b83b31ab380a04ee787dafecc19aac365a9824517f::btcvc::BTCVC", depositSymbol: "BTCvc", depositDecimals: 8, managerLabel: "Vishwa", targetApyPct: 3.0 },
  "0x6e6b58a710a5d59cfc44ba3af8004dd832af980a62c4519818ff463caf35a493::epoly::EPOLY": { vaultObjectId: "0x34f6f5bf549f760fab8c05eb06c269561f57fc7f16ccf2a0d724d95916cb8394", vaultName: "Polymarket Vault", receiptSymbol: "ePOLY", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Polymarket, Third Eye", targetApyPct: 14.0 },
  "0x267a6e56d07057ba827c38904eb30614d3f01fd052129a709e74d0bb4ed9be3c::ercusd::ERCUSD": { vaultObjectId: "0x7af46a89faa486c47c60e12357305fbff7e04f4a7404104e890603176f7c7800", vaultName: "rcUSD Vault", receiptSymbol: "ercUSD", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Ember, R25", targetApyPct: 9.0 },
  "0x56589f5381303a763a62e79ac118e5242f83652f4c5a9448af75162d8cb7140c::exbtc::EXBTC": { vaultObjectId: "0x30844745c8197fdaf9fe06c4ffeb73fe05c092ce0040674a3758dbfcb032a1f4", vaultName: "xBTC Vault", receiptSymbol: "exBTC", receiptDecimals: 8, depositCoinType: "0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC", depositSymbol: "xBTC", depositDecimals: 8, managerLabel: "Gamma", targetApyPct: 6.0 },
  "0x8a398f65f8635be31c181632bf730aea25074505d70c77d9b287e7d4f063ef70::ewal::EWAL": { vaultObjectId: "0x612f2c52885ca7c9ef852174286f696f30e25b5b06a8c833b98d521e68fb8b3d", vaultName: "Walrus Vault", receiptSymbol: "eWAL", receiptDecimals: 9, depositCoinType: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", depositSymbol: "WAL", depositDecimals: 9, managerLabel: "Ember", targetApyPct: 0.0 },
  "0x09e1ddb610500c5326d91923aba379649982f671583d741dfc3f6b0263dbbcb9::eriver::ERIVER": { vaultObjectId: "0x4a0722fe7d134b28fbd4092cc04ffe18c77c3829ab9da53db7f9b131d662e70d", vaultName: "Concentrated Liquidity Vault", receiptSymbol: "eRIVER", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Ember", targetApyPct: 15.0 },
  "0xb8d11a432391868eedf0fee3e074baa1eac97c01d5670ee79164d64c6ade3bfd::emft::EMFT": { vaultObjectId: "0xd72710e4344fb7a08afe982bf152f21ea6db640e07945d423d4e23ea6ec7dca2", vaultName: "Trading Vault", receiptSymbol: "eMFT", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Ember Partner", targetApyPct: 7.0 },
  "0x89b0d4407f17cc1b1294464f28e176e29816a40612f7a553313ea0a797a5f803::ethird::ETHIRD": { vaultObjectId: "0xeadfc1a6ea4915501506945aba6c2acc37c04136a784bafd6ff823a93ef3434a", vaultName: "Crosschain USD Vault", receiptSymbol: "eTHIRD", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Third Eye", targetApyPct: 13.0 },
  "0xd84b887935d73110c8cb4b981f4925f83b7a20c41ac572840513422c5da283d6::eblue::EBLUE": { vaultObjectId: "0xf8d500875677345b6c0110ee8a48abc7c4974ca697df71eefd229827565168d0", vaultName: "Bluefin Vault", receiptSymbol: "eBLUE", receiptDecimals: 9, depositCoinType: "0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca::blue::BLUE", depositSymbol: "BLUE", depositDecimals: 9, managerLabel: "Bluefin", targetApyPct: 13.0 },
  "0x66629328922d609cf15af779719e248ae0e63fe0b9d9739623f763b33a9c97da::esui::ESUI": { vaultObjectId: "0xfaf4d0ec9b76147c926c0c8b2aba39ea21ec991500c1e3e53b60d447b0e5f655", vaultName: "SUI Vault", receiptSymbol: "eSUI", receiptDecimals: 9, depositCoinType: "0x2::sui::SUI", depositSymbol: "SUI", depositDecimals: 9, managerLabel: "Gamma", targetApyPct: 6.9 },
  "0x68532559a19101b58757012207d82328e75fde7a696d20a59e8307c1a7f42ad7::egusdc::EGUSDC": { vaultObjectId: "0x94c2826b24e44f710c5f80e3ed7ce898258d7008e3a643c894d90d276924d4b9", vaultName: "USD Vault", receiptSymbol: "egUSDC", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Gamma", targetApyPct: 10.8 },
  "0x65b3db01dd36de8706128d842ca3d738ed30bd72c155ea175a44aedca37d4caf::ebasis::EBASIS": { vaultObjectId: "0x1fdbd27ba90a7a5385185e3e0b76477202f2cadb0e4343163288c5625e7c5505", vaultName: "Basis Vault", receiptSymbol: "eBASIS", receiptDecimals: 6, depositCoinType: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", depositSymbol: "USDC", depositDecimals: 6, managerLabel: "Ember", targetApyPct: 9.0 },
  "0x244b98d29bd0bba401c7cfdd89f017c51759dad615e15a872ddfe45af079bb1d::ebtc::EBTC": { vaultObjectId: "0x323578c2b24683ca845c68c1e2097697d65e235826a9dc931abce3b4b1e43642", vaultName: "BTC Vault", receiptSymbol: "eBTC", receiptDecimals: 8, depositCoinType: "0x77045f1b9f811a7a8fb9ebd085b5b0c55c5cb0d1520ff55f7037f89b5da9f5f1::TBTC::TBTC", depositSymbol: "tBTC", depositDecimals: 8, managerLabel: "MEV Capital", targetApyPct: 8.0 },
};

let emberSuiVaultCatalog = null;

// Stablecoin types for supply tracking (all via GraphQL)
// Group 1: coinMetadata.supply works directly
const STABLECOINS_METADATA = [
  { type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", symbol: "USDC", decimals: 6, color: "#2775CA" },
  { type: "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT", symbol: "USDT", decimals: 6, color: "#26A17B" },
  { type: "0xf16e6b723f242ec745dfd7634ad072c42d5c1d9ac9d62a39c381303eaa57693a::fdusd::FDUSD", symbol: "FDUSD", decimals: 6, color: "#00D4AA" },
  { type: "0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD", symbol: "AUSD", decimals: 6, color: "#FF6B6B" },
  { type: "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY", symbol: "USDY", decimals: 6, color: "#1E90FF" },
  { type: "0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE", symbol: "suiUSDe", decimals: 6, color: "#8B5CF6" },
];
// Group 2: Wormhole-wrapped — TreasuryCap in token_registry dynamic field
const WORMHOLE_REGISTRY = "0x334881831bd89287554a6121087e498fa023ce52c037001b53a4563a00a281a5";
const WORMHOLE_KEY_PKG = "0x26efee2b51c911237888e5dc6702868abca3c7ac12c53f76ef8eba0697695e3d";
const STABLECOINS_WORMHOLE = [
  { type: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN", symbol: "wUSDC", decimals: 6, color: "#5A9FD4" },
  { type: "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN", symbol: "wUSDT", decimals: 6, color: "#50C878" },
];
// Group 3: Protocol/state objects — singleton treasury/state objects with explicit JSON paths
const BUCK_PROTOCOL_OBJ = "0x9e3dab13212b27f5434416939db5dec6a319d15b89a84fd074d03ece6350d3df";
const STABLECOINS_PROTOCOL = [
  { objAddr: BUCK_PROTOCOL_OBJ, supplyPath: "buck_treasury_cap.total_supply.value", symbol: "BUCK", decimals: 9, color: "#F5A623" },
  {
    typeFilter: "0x94e8cb8df7796c7ea57f747f330ef61aedd8f48d48f7ac21bc975708a6ca6a1a::stablecoin::Stablecoin<0x94e8cb8df7796c7ea57f747f330ef61aedd8f48d48f7ac21bc975708a6ca6a1a::reserve_ledger::RESERVE_LEDGER, 0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI>",
    supplyPath: "treasury_cap.total_supply.value",
    symbol: "USDSUI",
    decimals: 6,
    color: "#0EA5E9",
  },
];

// Normalize a full coin type by stripping leading zeros from the address portion.
// On-chain type.repr uses padded 64-char hex (0x0000...0002::sui::SUI) but
// KNOWN_COIN_TYPES uses short form (0x2::sui::SUI). This ensures lookups match.
function normalizeCoinType(coinType) {
  if (!coinType) return coinType;
  const sep = coinType.indexOf("::");
  if (sep <= 2) return coinType;
  const addr = coinType.slice(0, sep);
  const rest = coinType.slice(sep);
  const hex = addr.startsWith("0x") ? addr.slice(2) : addr;
  const short = "0x" + (hex.replace(/^0+/, "") || "0");
  return short + rest;
}

const MOVE_TYPE_TOKEN_RE = /0x[0-9a-fA-F]+::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*/g;
const COIN_TYPE_PREFIX_RE = /^(0x[0-9a-fA-F]+)::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)(.*)$/;

function normalizeSuiAddress(addr) {
  const raw = String(addr || "").trim().toLowerCase();
  if (!raw) return "";
  let hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!hex || !/^[0-9a-f]+$/.test(hex)) return "";
  if (hex.length > 64) {
    const trimmed = hex.replace(/^0+/, "");
    if (!trimmed || trimmed.length > 64) return "";
    hex = trimmed;
  }
  hex = hex.replace(/^0+/, "") || "0";
  return `0x${hex}`;
}

function parseTsMs(ts) {
  const n = new Date(ts || "").getTime();
  return Number.isFinite(n) ? n : NaN;
}

function normalizeCoinTypeQueryInput(raw) {
  const input = String(raw || "").trim();
  if (!input) return "";
  const prefixed = input.startsWith("0x") ? input : `0x${input}`;
  const match = prefixed.match(COIN_TYPE_PREFIX_RE);
  if (!match) return "";
  const suffix = String(match[4] || "").trim();
  if (suffix && !suffix.startsWith("<")) return "";
  const addr = normalizeSuiAddress(match[1]);
  if (!addr) return "";
  return `${addr}::${match[2]}::${match[3]}${suffix}`;
}

function normalizeCoinTypeLike(raw) {
  const input = String(raw || "").trim();
  if (!input) return "";
  const normalized = normalizeCoinTypeQueryInput(input);
  if (normalized) return normalized;
  const prefixed = input.startsWith("0x") ? input : `0x${input}`;
  return normalizeCoinType(prefixed);
}

function moveTypeStringHasCoinType(value, targetKey) {
  if (!targetKey) return false;
  const text = String(value || "");
  if (!text) return false;
  const tokens = text.match(MOVE_TYPE_TOKEN_RE) || [];
  for (const token of tokens) {
    if (coinTypeKey(token) === targetKey) return true;
  }
  return false;
}

function valueHasCoinType(value, targetKey, depth = 0) {
  if (!targetKey || value == null || depth > 6) return false;
  if (typeof value === "string") {
    if (moveTypeStringHasCoinType(value, targetKey)) return true;
    const normalized = normalizeCoinTypeQueryInput(value);
    return normalized ? coinTypeKey(normalized) === targetKey : false;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 24); i += 1) {
      if (valueHasCoinType(value[i], targetKey, depth + 1)) return true;
    }
    return false;
  }
  if (typeof value === "object") {
    const vals = Object.values(value);
    for (let i = 0; i < Math.min(vals.length, 24); i += 1) {
      if (valueHasCoinType(vals[i], targetKey, depth + 1)) return true;
    }
    return false;
  }
  return false;
}

function isKnownCoinType(coinType) {
  if (!coinType) return false;
  const normalized = normalizeCoinType(coinType);
  return !!(KNOWN_COIN_TYPES[coinType] || KNOWN_COIN_TYPES[normalized]);
}

function setDefiUsdPriceForCoinType(coinType, usd) {
  const key = coinTypeKey(coinType);
  const price = Number(usd || 0);
  if (!key || !(price > 0)) return;
  defiPricesByCoinType[key] = price;
}

function getDefiUsdPrice(symbol, coinType = "") {
  const key = coinTypeKey(coinType);
  if (key) {
    const exact = Number(defiPricesByCoinType[key] || 0);
    if (exact > 0) return exact;
    if (!isKnownCoinType(coinType)) return 0;
  }
  const resolvedSymbol = String(symbol || (coinType ? resolveCoinType(coinType).symbol : "") || "");
  return Number(defiPrices[resolvedSymbol] || 0);
}

function priceAmountUsd(amount, symbol, coinType = "") {
  const human = Number(amount || 0);
  if (!(human > 0)) return 0;
  const price = getDefiUsdPrice(symbol, coinType);
  return price > 0 ? human * price : 0;
}

// Resolve a full coin type string to { symbol, decimals } (sync, fast path)
function resolveCoinType(coinType) {
  if (!coinType) return { symbol: "?", decimals: 9 };
  const known = KNOWN_COIN_TYPES[coinType] || KNOWN_COIN_TYPES[normalizeCoinType(coinType)];
  if (known) return known;
  // Check if coinMetaCache has it (populated by prefetchCoinMeta or getCoinMeta)
  const normalized = normalizeCoinType(coinType);
  if (typeof coinMetaCache !== "undefined" && (coinMetaCache[coinType] || coinMetaCache[normalized])) {
    const m = coinMetaCache[coinType] || coinMetaCache[normalized];
    return { symbol: m.symbol, decimals: m.decimals };
  }
  const sym = coinType.split("::").pop() || "?";
  return { symbol: sym, decimals: COMMON_DECIMALS[sym] || 9 };
}

// Async version: tries on-chain CoinMetadata when not in KNOWN_COIN_TYPES
async function resolveCoinTypeAsync(coinType) {
  if (!coinType) return { symbol: "?", decimals: 9 };
  const known = KNOWN_COIN_TYPES[coinType];
  if (known) return known;
  // Try on-chain metadata
  const meta = await getCoinMeta(coinType);
  if (meta) return { symbol: meta.symbol, decimals: meta.decimals };
  const sym = coinType.split("::").pop() || "?";
  return { symbol: sym, decimals: COMMON_DECIMALS[sym] || 9 };
}

// ── MVR Package Name Resolution ─────────────────────────────────────────
const mvrNameCache = {
  "0x0000000000000000000000000000000000000000000000000000000000000001": "move-stdlib",
  "0x0000000000000000000000000000000000000000000000000000000000000002": "sui-framework",
  "0x0000000000000000000000000000000000000000000000000000000000000003": "sui-system",
};

async function resolvePackageNames(addresses) {
  const unique = [...new Set((addresses || []).map(a => String(a || "").toLowerCase()))]
    .filter(a => a && !mvrNameCache[a]);
  if (!unique.length) return mvrNameCache;
  try {
    async function fetchBulk(payload) {
      const resp = await fetch("https://mainnet.mvr.mystenlabs.com/v1/reverse-resolution/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) return null;
      try {
        return await resp.json();
      } catch (_) {
        return null;
      }
    }
    // Current MVR API expects `package_ids`; keep `addresses` fallback for compatibility.
    let data = await fetchBulk({ package_ids: unique });
    if (!data?.resolution) data = await fetchBulk({ addresses: unique });
    if (!data?.resolution) return mvrNameCache;
    const resolution = data.resolution || {};
    for (const addr of unique) {
      const entry = resolution[addr];
      if (entry?.name) mvrNameCache[addr] = entry.name;
    }
  } catch (e) { /* MVR unavailable, use cache */ }
  return mvrNameCache;
}

async function withTimedCache(cacheState, ttlMs, force, loader) {
  const now = Date.now();
  if (!force && cacheState.data && (now - cacheState.ts) < ttlMs) {
    notePerfCache(true);
    return cacheState.data;
  }
  if (cacheState.inFlight) {
    notePerfCache(true);
    return cacheState.inFlight;
  }
  notePerfCache(false);
  cacheState.inFlight = (async () => {
    const data = await loader();
    cacheState.data = data;
    cacheState.ts = Date.now();
    return data;
  })().finally(() => { cacheState.inFlight = null; });
  return cacheState.inFlight;
}

function peekTimedCache(cacheState, ttlMs) {
  const now = Date.now();
  if (cacheState?.data && (now - Number(cacheState.ts || 0)) < ttlMs) {
    notePerfCache(true);
    return cacheState.data;
  }
  return null;
}

function getKeyedCacheState(cacheMap, key) {
  const k = String(key || "");
  if (!cacheMap[k]) cacheMap[k] = { data: null, ts: 0, inFlight: null };
  return cacheMap[k];
}

function normalizeDefiWindowKey(input) {
  const raw = String(input || "").trim();
  if (!raw) return DEFI_WINDOW_DEFAULT_KEY;
  if (raw.toLowerCase() === "fast") return "fast";
  const up = raw.toUpperCase();
  if (DEFI_WINDOW_PRESETS[up]) return up;
  return DEFI_WINDOW_DEFAULT_KEY;
}

function parseDefiWindowAndForce(windowOrForce, forceMaybe = false) {
  if (typeof windowOrForce === "boolean") {
    return { windowKey: DEFI_WINDOW_DEFAULT_KEY, force: windowOrForce };
  }
  return {
    windowKey: normalizeDefiWindowKey(windowOrForce),
    force: !!forceMaybe,
  };
}

function normalizeDefiWindowProjection(projection = "full") {
  return DEFI_WINDOW_SAMPLE_PROJECTIONS[projection] ? projection : "full";
}

function renderDefiWindowSelect(windowKey, changeAction) {
  const selected = normalizeDefiWindowKey(windowKey);
  return `
    <span class="u-fs12-dim">Window</span>
    <select data-action="${escapeAttr(changeAction)}" class="ui-control">
      ${Object.entries(DEFI_WINDOW_PRESETS).map(([k, p]) => `<option value="${k}" ${selected === k ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("")}
    </select>
  `;
}

function renderDefiCoveragePanel(coverage, title = "Sampling Coverage") {
  const c = coverage || {};
  const status = c.completeWindow ? "Complete" : (c.budgetLimited ? "Budget-Limited" : "Partial");
  const statusColor = c.completeWindow ? "var(--green)" : (c.budgetLimited ? "var(--yellow)" : "var(--text-dim)");
  const body = `
    <div class="card-body u-p12-16">
      <div class="stats-grid" style="margin-bottom:0">
        <div class="stat-box"><div class="stat-label">Window</div><div class="stat-value">${escapeHtml(c.windowLabel || "—")}</div><div class="stat-sub">${fmtNumber(c.windowHours || 0)}h target</div></div>
        <div class="stat-box"><div class="stat-label">Status</div><div class="stat-value" style="color:${statusColor}">${status}</div><div class="stat-sub">${c.budgetReason ? escapeHtml(c.budgetReason) : "within budget"}</div></div>
        <div class="stat-box"><div class="stat-label">Tx In Window</div><div class="stat-value">${fmtNumber(c.txInWindow || 0)}</div><div class="stat-sub">${fmtNumber(c.txFetched || 0)} scanned</div></div>
        <div class="stat-box"><div class="stat-label">Checkpoints Scanned</div><div class="stat-value">${fmtNumber(c.checkpointsScanned || 0)}</div><div class="stat-sub">latest ${Number.isFinite(c.latestCheckpointSeen) ? fmtNumber(c.latestCheckpointSeen) : "—"}</div></div>
        <div class="stat-box"><div class="stat-label">Package Resolution</div><div class="stat-value">${fmtNumber(c.resolvedPackages || 0)}</div><div class="stat-sub">${fmtNumber(c.unresolvedPackages || 0)} unresolved</div></div>
        <div class="stat-box"><div class="stat-label">Budget Use</div><div class="stat-value">${fmtNumber(c.callsUsed || 0)}/${fmtNumber(c.maxCalls || 0)} calls</div><div class="stat-sub">${Math.round(c.elapsedMs || 0)}ms / ${fmtNumber(c.maxMs || 0)}ms</div></div>
        <div class="stat-box"><div class="stat-label">Last Checkpoint Included</div><div class="stat-value">${Number.isFinite(c.lastCheckpointIncluded) ? fmtNumber(c.lastCheckpointIncluded) : "—"}</div><div class="stat-sub">${c.oldestIncludedTs ? fmtTime(c.oldestIncludedTs) : "no rows"}</div></div>
      </div>
    </div>
  `;
  if (uiViewMode !== "advanced") {
    return `
      <details class="card u-mb16 coverage-panel">
        <summary class="card-header coverage-panel-summary">
          <div class="coverage-panel-summary-title">${escapeHtml(title)}</div>
          <div class="coverage-panel-summary-meta">
            <span class="badge" style="background:var(--surface2);color:${statusColor}">${status}</span>
            <span class="u-fs12-dim">${escapeHtml(c.windowLabel || "—")} · ${fmtNumber(c.callsUsed || 0)}/${fmtNumber(c.maxCalls || 0)} calls</span>
          </div>
        </summary>
        ${body}
      </details>
    `;
  }
  return `
    <div class="card u-mb16">
      <div class="card-header">${escapeHtml(title)}</div>
      ${body}
    </div>
  `;
}

function emptyStateReason(windowCoverage, rowCount, unresolvedCount = 0) {
  if (rowCount > 0) return "";
  const c = windowCoverage || {};
  if ((c.txInWindow || 0) === 0) return "No rows in selected window.";
  if (unresolvedCount > 0) return "No mapped rows. Activity exists but package mapping is unresolved.";
  return "No rows in selected window.";
}

const MVR_DEFI_ALIASES = {
  "suilend-v2": "suilend",
  "suilend/core": "suilend",
  "navi-protocol": "navi",
  "alpha-fi": "alpha",
  "cetus-protocol": "cetus",
  "cetuspackages/clmm": "cetus",
  "cetuspackages/integrate": "cetus",
  "turbos-finance": "turbos",
  "turbos/core": "turbos",
  "deepbook-v3": "deepbook",
  "deepbook/core": "deepbook",
  "bluefin-pro": "bluefin",
  "aftermath-finance": "aftermath",
  "bucket-protocol": "bucket",
  "lending@scallop/core": "scallop",
};
const PACKAGE_PROTOCOL_OVERRIDES = {
  "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809": { canonical: "deepbook", category: "dex", display: "DeepBook", confidence: "medium" },
  "0x97d9473771b01f77b0940c589484184b49f6444627ec121314fae6a6d36fb86b": { canonical: "deepbook", category: "dex", display: "DeepBook", confidence: "medium" },
  "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb": { canonical: "cetus", category: "dex", display: "Cetus", confidence: "medium" },
  "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1": { canonical: "turbos", category: "dex", display: "Turbos", confidence: "medium" },
  "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267": { canonical: "bluefin", category: "dex", display: "Bluefin", confidence: "medium" },
};
const CANONICAL_DISPLAY_NAMES = {
  suilend: "Suilend",
  navi: "NAVI",
  alpha: "Alpha",
  scallop: "Scallop",
  deepbook: "DeepBook",
  cetus: "Cetus",
  turbos: "Turbos",
  bluefin: "Bluefin",
  aftermath: "Aftermath",
  kriya: "Kriya",
  flowx: "FlowX",
  haedal: "Haedal",
  bucket: "Bucket",
  spring: "SpringSui",
  volo: "Volo",
};
const CATEGORY_KEYWORDS = {
  lending: ["suilend", "navi", "scallop", "alpha", "bucket", "lending"],
  dex: ["deepbook", "cetus", "turbos", "kriya", "flowx", "aftermath", "dex", "swap", "amm"],
  staking: ["haedal", "spring", "volo", "stake", "staking", "lst"],
  perps: ["bluefin", "perp", "perpetual", "futures", "derivative"],
  stablecoin: ["stable", "usdc", "usdt", "fdusd", "ausd", "usde", "usdsui", "buck"],
};
const NON_PROTOCOL_NAMES = new Set(["move-stdlib", "sui-framework", "sui-system", "unknown"]);

function normalizeMvrProtocolName(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";
  const cleaned = raw.replace(/^@/, "").replace(/[_\s]+/g, "-");
  if (MVR_DEFI_ALIASES[cleaned]) return MVR_DEFI_ALIASES[cleaned];
  for (const [k, v] of Object.entries(MVR_DEFI_ALIASES)) {
    if (cleaned.includes(k)) return v;
  }
  return cleaned;
}

function categoryFromProtocolName(canonical, rawName = "") {
  const c = String(canonical || "").toLowerCase();
  const raw = String(rawName || "").toLowerCase();
  if (!c && !raw) return "unknown";
  if (NON_PROTOCOL_NAMES.has(c) || NON_PROTOCOL_NAMES.has(raw)) return "system";
  for (const [cat, keys] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keys.some(k => c.includes(k) || raw.includes(k))) return cat;
  }
  return "other";
}

function protocolDisplayName(canonical, rawName, pkgAddr) {
  if (canonical && CANONICAL_DISPLAY_NAMES[canonical]) return CANONICAL_DISPLAY_NAMES[canonical];
  if (rawName) return rawName;
  return truncHash(pkgAddr || "unknown", 6);
}

function protocolInfoFromPackage(pkgAddr) {
  const pkgKey = String(pkgAddr || "").toLowerCase();
  const rawName = mvrNameCache[pkgAddr] || mvrNameCache[pkgKey] || "";
  const override = PACKAGE_PROTOCOL_OVERRIDES[pkgKey] || null;
  let canonical = normalizeMvrProtocolName(rawName);
  if (!canonical && override?.canonical) canonical = override.canonical;
  let category = categoryFromProtocolName(canonical, rawName);
  if (override?.category && (category === "other" || category === "unknown")) category = override.category;
  let confidence = "low";
  if (rawName) confidence = category !== "other" ? "high" : "medium";
  else if (override) confidence = override.confidence || "medium";
  return {
    pkgAddr,
    rawName,
    canonical,
    category,
    display: rawName ? protocolDisplayName(canonical, rawName, pkgAddr) : (override?.display || protocolDisplayName(canonical, rawName, pkgAddr)),
    confidence,
  };
}

// LST coin type addresses for detection + on-chain exchange rate sources
const LST_TYPES = {
  "0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI": { symbol: "sSUI", name: "SpringSui", protocol: "Suilend", rateObj: "0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b" },
  "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI": { symbol: "haSUI", name: "Haedal SUI", protocol: "Haedal", rateObj: "0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca" },
  "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI": { symbol: "afSUI", name: "Aftermath SUI", protocol: "Aftermath" },
  "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT": { symbol: "vSUI", name: "Volo SUI", protocol: "Volo" },
};
let lstExchangeRates = {}; // symbol -> SUI multiplier
let lstSupplies = {}; // symbol -> raw token supply

// Fetch on-chain LST-to-SUI exchange rates
async function fetchLstExchangeRates() {
  if (Object.keys(lstExchangeRates).length > 0) return;
  try {
    const data = await gql(`{
      ssui: object(address: "0x15eda7330c8f99c30e430b4d82fd7ab2af3ead4ae17046fcb224aa9bad394f6b") { ${GQL_F_MOVE_JSON} }
      hasui: object(address: "0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca") { ${GQL_F_MOVE_JSON} }
    }`);
    // sSUI: total_sui_supply / lst_total_supply
    const ssj = data.ssui?.asMoveObject?.contents?.json;
    if (ssj) {
      const suiSupply = Number(ssj.storage?.total_sui_supply || 0);
      const lstSupply = Number(ssj.lst_treasury_cap?.total_supply?.value || 0);
      if (lstSupply > 0) {
        lstExchangeRates.sSUI = suiSupply / lstSupply;
        lstSupplies.sSUI = lstSupply;
      }
    }
    // haSUI: (total_staked - total_unstaked + total_rewards) / stsui_supply
    const hj = data.hasui?.asMoveObject?.contents?.json;
    if (hj) {
      const netSui = Number(hj.total_staked || 0) - Number(hj.total_unstaked || 0) + Number(hj.total_rewards || 0);
      const supply = Number(hj.stsui_supply || 0);
      if (supply > 0) {
        lstExchangeRates.haSUI = netSui / supply;
        lstSupplies.haSUI = supply;
      }
    }
  } catch (e) { /* exchange rates stay empty, will use 1:1 */ }
  // Defaults for LSTs we can't query (close approximation)
  if (!lstExchangeRates.afSUI) lstExchangeRates.afSUI = lstExchangeRates.sSUI || 1;
  if (!lstExchangeRates.vSUI) lstExchangeRates.vSUI = lstExchangeRates.haSUI || 1;
}

// Suilend
const SUILEND_PKG = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const SUILEND_MARKET_TYPE = `${SUILEND_PKG}::suilend::MAIN_POOL`;
const SUILEND_CAP_TYPE = `${SUILEND_PKG}::lending_market::ObligationOwnerCap<${SUILEND_MARKET_TYPE}>`;
const SUILEND_MAIN_POOL_OBJECT = "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1";

// NAVI Protocol — Aave-style lending on Sui
// On-chain state is stored in two shared tables:
//   - USER_INFO_TABLE: Map<address, UserInfo> — holds per-user VecSet<u8> of collateral/loan asset IDs
//   - RESERVES_TABLE:  Map<u8, Reserve>       — per-asset reserve with indexes, rates, coin_type, balance tables
// All RAY-scaled values (indexes, rates, LTV) use 1e27 precision.
// User balances are stored as "scaled balances" with 9-decimal precision regardless of the coin's native decimals.
// Actual amount = scaled_balance * current_index / 1e9
const NAVI_USER_INFO_TABLE = "0xabc6c3fbc89b96e3351fdbeb5730bcc5398648367260c6a4e201779e34694e04";
const NAVI_RESERVES_TABLE = "0xe6d4c6610b86ce7735ea754596d71d72d10c7980b5052fc3c8cdf8d09fea9b4b";
const NAVI_RAY = 1e27;

// Alpha Lending
const ALPHA_PKG = "0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4";
const ALPHA_MARKETS_TABLE = "0x2326d387ba8bb7d24aa4cfa31f9a1e58bf9234b097574afb06c5dfb267df4c2e";
const ALPHA_POSITIONS_TABLE = "0x9923cec7b613e58cc3feec1e8651096ad7970c0b4ef28b805c7d97fe58ff91ba";
const ALPHA_CAP_TYPE = `${ALPHA_PKG}::position::PositionCap`;
const ALPHA_MARKETS = {
  1:"SUI", 2:"stSUI", 3:"BTC", 4:"LBTC", 5:"USDT", 6:"USDC",
  7:"WAL", 8:"DEEP", 9:"BLUE", 10:"ETH", 11:"DEEP",
  12:"ALPHA", 13:"DMC", 14:"TBTC", 15:"IKA",
  16:"XBTC", 17:"ALKIMI", 18:"XAUM", 19:"UP",
  20:"EBTC", 21:"ESUI", 22:"EGUSDC", 23:"ETHIRD",
  24:"EXBTC", 25:"SDEUSD", 26:"EWAL", 27:"RCUSDP",
  28:"COIN", 29:"WBTC", 30:"BTCVC", 31:"SUI_USDE", 32:"dbUSDC",
};

// Cetus CLMM
const CETUS_CLMM_PKG = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const CETUS_POSITION_TYPE = `${CETUS_CLMM_PKG}::position::Position`;

// Scallop Lending
const SCALLOP_PROTOCOL = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const SCALLOP_MARKET_OBJECT = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const SCALLOP_KEY_TYPE = `${SCALLOP_PROTOCOL}::obligation::ObligationKey`;
const SCALLOP_BORROW_DYNAMICS_TABLE = "0x2d878e129dec2d83f3e240fa403cd588bc5101dd9b60040c27007e24ef242d8d";
const SCALLOP_INTEREST_MODELS_TABLE = "0x1e8419e665b8b796723c97747c504f4a37a527d4f944f27ae9467ae68e8b50f9";
const SCALLOP_BALANCE_SHEETS_TABLE = "0x8708eb23153bdc4b345c9f536fe05b62206f3f55629b26389d4fe5f129bd8368";

// Turbos CLMM
const TURBOS_PKG = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1";
const TURBOS_POSITION_TYPE = `${TURBOS_PKG}::position_nft::TurbosPositionNFT`;
const TURBOS_POSITIONS_CONTAINER = "0xf5762ae5ae19a2016bb233c72d9a4b2cba5a302237a82724af66292ae43ae52d";

// Bluefin Spot (CLMM)
const BLUEFIN_SPOT_PKG = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267";
const BLUEFIN_POSITION_TYPE = `${BLUEFIN_SPOT_PKG}::position::Position`;

// Bluefin Pro (Perps) — positions stored in shared Table<address, Account>
const BLUEFIN_PRO_ACCOUNTS_TABLE = "0x63f16b288f33fbe6d9374602cbbfa9948bf1cc175e9b0a91aa50085aa04980a0";

// Aftermath Perpetuals — positions stored as dynamic fields on ClearingHouse objects
const AF_PERPS_PKG = "0x21d001e8b07da2e3facb3e2d636bbaef43ba3c978bd84810368840b7d57c5068";
const AF_ACCOUNT_CAP_TYPE = `${AF_PERPS_PKG}::account::AccountCap`;
const AF_ACCOUNT_ADMIN_TYPE = `${AF_PERPS_PKG}::account::AccountCap<${AF_PERPS_PKG}::account::ADMIN>`;
const AF_ACCOUNT_ASSISTANT_TYPE = `${AF_PERPS_PKG}::account::AccountCap<${AF_PERPS_PKG}::account::ASSISTANT>`;
const AF_ACCOUNT_CAP_FILTERS = [
  { type: AF_ACCOUNT_ADMIN_TYPE, role: "admin" },
  { type: AF_ACCOUNT_ASSISTANT_TYPE, role: "assistant" },
  // Fallback for indexers that may still expose a non-parameterized repr.
  { type: AF_ACCOUNT_CAP_TYPE, role: "unknown" },
];
const AF_CLEARING_HOUSES = {
  "0x95969906ca735c9d44e8a44b5b7791b4dacaddf70fbdfbda40ccd3f8a9fd4920": "BTC/USD",
  "0xed358c545b4a6698f757d3840a6b7effd1b958dd31260931bef07691f255b1fa": "XAUT/USD",
};
const AF_USDC_COIN_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const AF_CLEARING_HOUSE_TYPE = `${AF_PERPS_PKG}::clearing_house::ClearingHouse<${AF_USDC_COIN_TYPE}>`;
const AF_POSITION_KEY_TYPE = `${AF_PERPS_PKG}::keys::Position`;
const AF_ORDERBOOK_KEY_TYPE = `${AF_PERPS_PKG}::keys::Orderbook`;
const AF_ASKS_MAP_KEY_TYPE = `${AF_PERPS_PKG}::keys::AsksMap`;
const AF_BIDS_MAP_KEY_TYPE = `${AF_PERPS_PKG}::keys::BidsMap`;
const AF_IFIXED_SCALE_DECIMALS = 18;
const AF_IFIXED_SIGN_BIT = 1n << 255n;
const AF_IFIXED_FULL_RANGE = 1n << 256n;
const AF_PERPS_EPS_RAW = 1000000n; // 1e-12 in IFixed(1e18) terms
const AF_COLLATERAL_DUST_RAW = 1000000000000n; // 1e-6 in IFixed(1e18) terms
const AF_ORDER_SIZE_DECIMALS = 9;
const AF_ACCOUNT_CAP_PAGE_SIZE = 50;
const AF_ACCOUNT_CAP_MAX_PAGES = 10;
const AF_POSITION_QUERY_BATCH = 50;
const AF_ORDERBOOK_PAGE_SIZE = 50;
const AF_ORDERBOOK_MAX_PAGES = 24;
const AF_ORDER_EVENT_TX_SCAN = 40;
const AF_ORDER_EVENT_PER_TX = 20;
const AF_CLEARING_HOUSE_DISCOVERY_TTL_MS = 5 * 60 * 1000;
const AF_CLEARING_HOUSE_DISCOVERY_MAX_PAGES = 4;
const AF_PERPS_SIZE_EPS = 1e-12;
const AF_PERPS_COLLATERAL_DUST = 1e-6;
let afClearingHouseDiscoveryCache = { at: 0, rows: [], partial: false };

// ---------------------------------------------------------------------------
// Reusable GraphQL field-selection fragments
// ---------------------------------------------------------------------------
const GQL_F_OWNER = `... on AddressOwner { address { address } } ... on ObjectOwner { address { address } } ... on Shared { initialSharedVersion } ... on Immutable { __typename }`;
const GQL_F_MOVE_TYPE = `asMoveObject { contents { type { repr } } }`;
const GQL_F_MOVE_JSON = `asMoveObject { contents { json } }`;
const GQL_F_MOVE_TYPE_JSON = `asMoveObject { contents { type { repr } json } }`;
const GQL_F_CONTENTS_TYPE_JSON = `contents { type { repr } json }`;
const GQL_F_BAL_NODE = `owner { address } amount coinType { repr }`;
const GQL_F_EVENT_NODE = `contents { type { repr } json } sender { address } timestamp transactionModule { name package { address } }`;
const GQL_Q_LATEST_CHECKPOINT = `{ checkpoint { sequenceNumber timestamp } }`;

const GQL_TIMEOUT_MS = 16_000;
const GQL_RETRY_LIMIT = 2;
const GQL_RETRY_BASE_MS = 220;
const GQL_MAX_CONCURRENCY = 8;
const gqlInFlight = new Map();
let gqlActiveRequests = 0;
const gqlWaiters = [];
let routeRequestController = null;
let routeRenderToken = 0;
const ROUTE_VIEW_CACHE_TTL_MS = 20 * 1000;
const routeViewCache = {};

function isActiveRouteApp(app, routeToken = routeRenderToken) {
  return !!app?.isConnected && routeToken === routeRenderToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function gqlFingerprint(query) {
  const text = String(query || "");
  const compact = text.replace(/\s+/g, " ").trim();
  if (/t\d+\s*:\s*transaction\s*\(\s*digest\s*:/.test(compact)) return "batch:transactionByDigest";
  if (/c\d+\s*:\s*coinMetadata\s*\(\s*coinType\s*:/.test(compact)) return "batch:coinMetadataByCoinType";
  if (/ob\d+\s*:\s*object\s*\(\s*address\s*:/.test(compact)) return "batch:objectByAddress";
  if (/a\d+\s*:\s*objects\s*\(\s*filter\s*:\s*\{\s*type\s*:/.test(compact)) return "batch:objectsByType";
  const op = text.match(/\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (op) return `${op[1]}:${op[2]}`;
  const root = text.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/);
  if (root) return `root:${root[1]}`;
  return `anon:${compact.slice(0, 48) || "query"}`;
}

function gqlInFlightKey(query, variables) {
  return `${String(query || "").trim()}\n${stableStringify(variables || {})}`;
}

function isRetriableStatus(status) {
  const code = Number(status || 0);
  return code === 408 || code === 425 || code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
}

function isLikelyRetriableGraphqlError(errors) {
  const rows = Array.isArray(errors) ? errors : [];
  return rows.some((e) => {
    const msg = String(e?.message || "").toLowerCase();
    return msg.includes("timeout")
      || msg.includes("temporar")
      || msg.includes("rate")
      || msg.includes("limit exceeded")
      || msg.includes("internal")
      || msg.includes("unavailable")
      || msg.includes("deadline");
  });
}

function isRetriableFetchError(err) {
  const name = String(err?.name || "");
  if (name === "AbortError") return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("fetch")
    || msg.includes("network")
    || msg.includes("timed out")
    || msg.includes("timeout")
    || msg.includes("temporar")
    || msg.includes("unavailable")
    || msg.includes("503")
    || msg.includes("502")
    || msg.includes("504")
    || msg.includes("429");
}

async function acquireGqlSlot() {
  if (gqlActiveRequests < GQL_MAX_CONCURRENCY) {
    gqlActiveRequests += 1;
    return;
  }
  await new Promise((resolve) => gqlWaiters.push(resolve));
}

function releaseGqlSlot() {
  const next = gqlWaiters.shift();
  if (next) {
    next();
    return;
  }
  gqlActiveRequests = Math.max(0, gqlActiveRequests - 1);
}

function makeAbortError(message = "Request canceled") {
  const err = new Error(String(message || "Request canceled"));
  err.name = "AbortError";
  return err;
}

function isAbortError(err) {
  if (!err) return false;
  if (String(err?.name || "") === "AbortError") return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("aborted") || msg.includes("canceled") || msg.includes("cancelled");
}

function getRouteSignal() {
  return routeRequestController?.signal || null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const upstream = options?.signal || null;
  const onUpstreamAbort = () => controller.abort();
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener("abort", onUpstreamAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || GQL_TIMEOUT_MS));
  try {
    return await fetch(url, { ...(options || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
  }
}

async function gql(query, variables = {}, opts = {}) {
  const payload = JSON.stringify({ query, variables });
  const reqBytes = payload.length;
  const queryKey = gqlFingerprint(query);
  const dedupeEnabled = opts?.dedupe !== false;
  const routeSignal = opts?.routeSignal === false ? null : getRouteSignal();
  const effectiveSignal = opts?.signal || routeSignal;
  const inFlightKey = gqlInFlightKey(query, variables);
  if (dedupeEnabled && gqlInFlight.has(inFlightKey)) {
    notePerfGqlDeduped();
    return gqlInFlight.get(inFlightKey);
  }

  const run = (async () => {
    let lastErr = null;
    for (let attempt = 0; attempt <= GQL_RETRY_LIMIT; attempt += 1) {
      let acquired = false;
      let attemptNoted = false;
      const t0 = performance.now();
      try {
        await acquireGqlSlot();
        acquired = true;
        const res = await fetchWithTimeout(GQL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: effectiveSignal || undefined,
        }, GQL_TIMEOUT_MS);
        const raw = await res.text();
        const elapsed = performance.now() - t0;
        let json = {};
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch (_) {
          notePerfGql(elapsed, reqBytes, raw.length, queryKey, false);
          attemptNoted = true;
          throw new Error("Invalid GraphQL JSON response");
        }

        if (!res.ok) {
          notePerfGql(elapsed, reqBytes, raw.length, queryKey, false);
          attemptNoted = true;
          const httpErr = new Error(json?.errors?.[0]?.message || `GraphQL request failed (${res.status})`);
          if (attempt < GQL_RETRY_LIMIT && isRetriableStatus(res.status)) {
            notePerfGqlRetry();
            const waitMs = GQL_RETRY_BASE_MS * (2 ** attempt) + Math.floor(Math.random() * 120);
            await sleep(waitMs);
            continue;
          }
          throw httpErr;
        }

        if (json.errors) {
          console.error("GQL errors:", json.errors);
          if (!json.data) {
            notePerfGql(elapsed, reqBytes, raw.length, queryKey, false);
            attemptNoted = true;
            const gqlErr = new Error(json.errors[0]?.message || "GraphQL query failed");
            if (attempt < GQL_RETRY_LIMIT && isLikelyRetriableGraphqlError(json.errors)) {
              notePerfGqlRetry();
              const waitMs = GQL_RETRY_BASE_MS * (2 ** attempt) + Math.floor(Math.random() * 120);
              await sleep(waitMs);
              continue;
            }
            throw gqlErr;
          }
        }

        notePerfGql(elapsed, reqBytes, raw.length, queryKey, true);
        attemptNoted = true;
        return json.data;
      } catch (e) {
        lastErr = e;
        if (!attemptNoted) {
          const elapsed = performance.now() - t0;
          notePerfGql(elapsed, reqBytes, 0, queryKey, false);
        }
        if (isAbortError(e) || effectiveSignal?.aborted) {
          throw isAbortError(e) ? e : makeAbortError("Request canceled");
        }
        const retriable = isRetriableFetchError(e);
        if (attempt < GQL_RETRY_LIMIT && retriable) {
          notePerfGqlRetry();
          const waitMs = GQL_RETRY_BASE_MS * (2 ** attempt) + Math.floor(Math.random() * 120);
          await sleep(waitMs);
          continue;
        }
        throw e;
      } finally {
        if (acquired) releaseGqlSlot();
      }
    }
    throw lastErr || new Error("GraphQL query failed");
  })();

  if (dedupeEnabled) gqlInFlight.set(inFlightKey, run);
  try {
    return await run;
  } finally {
    if (dedupeEnabled) gqlInFlight.delete(inFlightKey);
  }
}

async function suiRpcCall(method, params = []) {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: `${method}:${Date.now()}`,
    method,
    params,
  });
  const res = await fetch(SUI_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const raw = await res.text();
  let json = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch (e) {
    throw new Error("Invalid RPC JSON response");
  }
  if (!res.ok) {
    throw new Error(json?.error?.message || `RPC request failed (${res.status})`);
  }
  if (json?.error) {
    throw new Error(json.error?.message || "RPC request failed");
  }
  return json?.result;
}

function formatSupplyUnavailableReason(msg) {
  const text = String(msg || "").trim();
  if (!text) return "Supply lookup unavailable for this coin type.";
  const lower = text.toLowerCase();
  if (lower.includes("treasurycap") || lower.includes("treasury cap")) {
    return "No TreasuryCap was found for this coin type.";
  }
  if (lower.includes("package-created objects")) {
    return "No package-created TreasuryCap was found for this coin type.";
  }
  if (lower.includes("not found")) {
    return "Supply object was not found on-chain for this coin type.";
  }
  return text;
}

function uniqueNormalizedAddresses(addresses) {
  const out = [];
  const seen = new Set();
  for (const raw of (addresses || [])) {
    const norm = normalizeSuiAddress(raw || "");
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

function indexMultiGetObjectsByAddress(nodes) {
  const byId = {};
  for (const node of (nodes || [])) {
    const addrNorm = normalizeSuiAddress(node?.address || "");
    if (addrNorm) byId[addrNorm] = node;
  }
  return byId;
}

async function multiGetObjectsTypeJsonByAddress(addresses) {
  const keys = uniqueNormalizedAddresses(addresses);
  if (!keys.length) return {};
  const data = await gql(`query($keys: [ObjectKey!]!) {
    multiGetObjects(keys: $keys) {
      address
      ${GQL_F_MOVE_TYPE_JSON}
    }
  }`, {
    keys: keys.map(address => ({ address })),
  });
  return indexMultiGetObjectsByAddress(data?.multiGetObjects || []);
}

async function multiGetObjectsJsonByAddress(addresses) {
  const keys = uniqueNormalizedAddresses(addresses);
  if (!keys.length) return {};
  const data = await gql(`query($keys: [ObjectKey!]!) {
    multiGetObjects(keys: $keys) {
      address
      ${GQL_F_MOVE_JSON}
    }
  }`, {
    keys: keys.map(address => ({ address })),
  });
  return indexMultiGetObjectsByAddress(data?.multiGetObjects || []);
}

function uniqueNonEmptyStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of (values || [])) {
    const v = String(raw || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

async function multiGetTransactionEffectsSummary(digests) {
  const keys = uniqueNonEmptyStrings(digests);
  if (!keys.length) return [];
  const data = await gql(`query($keys: [String!]!) {
    multiGetTransactionEffects(keys: $keys) {
      digest
      status
      timestamp
      checkpoint { sequenceNumber }
      executionError { message abortCode }
      gasEffects { gasSummary { computationCost storageCost storageRebate } }
    }
  }`, { keys });
  return data?.multiGetTransactionEffects || [];
}

async function multiGetTransactionEffectsWithObjectChanges(digests, first = 50) {
  const keys = uniqueNonEmptyStrings(digests);
  if (!keys.length) return [];
  const safeFirst = Number.isFinite(first) ? Math.max(1, Math.floor(first)) : 50;
  const data = await gql(`query($keys: [String!]!, $first: Int!) {
    multiGetTransactionEffects(keys: $keys) {
      digest
      status
      timestamp
      checkpoint { sequenceNumber }
      objectChanges(first: $first) {
        nodes {
          address
          idCreated
          idDeleted
          inputState { version }
          outputState {
            version
            owner {
              ... on AddressOwner { address { address } }
              ... on Shared { initialSharedVersion }
              ... on Immutable { __typename }
            }
            ${GQL_F_MOVE_TYPE}
          }
        }
      }
    }
  }`, { keys, first: safeFirst });
  return data?.multiGetTransactionEffects || [];
}

// BCS encoders for GraphQL dynamic field queries
function addrBcs(hexAddr) {
  const hex = (hexAddr.startsWith("0x") ? hexAddr.slice(2) : hexAddr).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function u8Bcs(n) { return btoa(String.fromCharCode(n & 0xff)); }
function objectIdBcs(hexId) { return addrBcs(hexId); } // ObjectID is same encoding as address
function u64Bcs(n) {
  const bytes = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) { bytes[i] = Number(v & 0xFFn); v >>= 8n; }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function parseIFixedRaw(val) {
  const raw = parseBigIntSafe(val);
  return raw >= AF_IFIXED_SIGN_BIT ? raw - AF_IFIXED_FULL_RANGE : raw;
}
function scaledBigIntToApprox(raw, decimals, maxFrac = 8) {
  const bi = typeof raw === "bigint" ? raw : parseBigIntSafe(raw);
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const d = Math.max(0, Math.floor(Number(decimals || 0)));
  const scale = pow10BigInt(d);
  const whole = abs / scale;
  const frac = abs % scale;
  let wholeNum = Number(whole);
  if (!Number.isFinite(wholeNum)) wholeNum = Number.MAX_SAFE_INTEGER;
  if (d <= 0) return neg ? -wholeNum : wholeNum;
  const fracStr = frac.toString().padStart(d, "0").slice(0, Math.max(0, maxFrac));
  const fracNum = fracStr ? Number(`0.${fracStr}`) : 0;
  const mag = wholeNum + (Number.isFinite(fracNum) ? fracNum : 0);
  return neg ? -mag : mag;
}
function scaledBigIntAbsToApprox(raw, decimals, maxFrac = 8) {
  const bi = typeof raw === "bigint" ? raw : parseBigIntSafe(raw);
  return scaledBigIntToApprox(bi < 0n ? -bi : bi, decimals, maxFrac);
}
function scaledBigIntToText(raw, decimals, maxFrac = 8) {
  const bi = typeof raw === "bigint" ? raw : parseBigIntSafe(raw);
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const d = Math.max(0, Math.floor(Number(decimals || 0)));
  const scale = pow10BigInt(d);
  const whole = abs / scale;
  const frac = abs % scale;
  if (d <= 0) return `${neg ? "-" : ""}${whole.toString()}`;
  let fracStr = frac.toString().padStart(d, "0");
  fracStr = fracStr.slice(0, Math.max(0, maxFrac)).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${fracStr ? "." + fracStr : ""}`;
}
function parseIFixed(val) {
  return scaledBigIntToApprox(parseIFixedRaw(val), AF_IFIXED_SCALE_DECIMALS, 8);
}

const FIXED32_SCALE = 4294967296; // 2^32
function numOrZero(v) {
  const n = Number(v?.value ?? v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function rawToHuman(raw, decimals) {
  return Number(raw) / Math.pow(10, Math.max(0, Math.floor(Number(decimals || 0))));
}
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
function decodeB64U8Array(b64) {
  if (!b64) return [];
  try {
    const raw = atob(b64);
    const out = [];
    for (let i = 0; i < raw.length; i++) out.push(raw.charCodeAt(i));
    return out;
  } catch (e) {
    return [];
  }
}
function coinTypeKey(coinType) {
  if (!coinType) return "";
  const parts = String(coinType).split("::");
  if (parts.length < 3) return String(coinType).toLowerCase();
  let addr = parts[0].toLowerCase();
  if (!addr.startsWith("0x")) addr = "0x" + addr;
  addr = "0x" + addr.slice(2).replace(/^0+/, "");
  if (addr === "0x") addr = "0x0";
  return `${addr}::${parts.slice(1).join("::").toLowerCase()}`;
}
function tokenFromCoinType(coinType) {
  if (!coinType) return "";
  // Try KNOWN_COIN_TYPES first (handles wormhole ::coin::COIN types)
  const ct = coinType.startsWith("0x") ? coinType : "0x" + coinType;
  const known = KNOWN_COIN_TYPES[ct] || KNOWN_COIN_TYPES[normalizeCoinType(ct)];
  if (known) return known.symbol;
  // Fallback: extract module::TYPE from the coin type string
  const parts = String(coinType).split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : "";
}
function interpolateRateBps(utilPct, kinks, rates) {
  const ks = (kinks || []).map(numOrZero).filter(Number.isFinite);
  const rs = (rates || []).map(numOrZero).filter(Number.isFinite);
  const len = Math.min(ks.length, rs.length);
  if (!len) return 0;
  if (len === 1) return rs[0];
  const u = Math.max(0, utilPct);
  if (u <= ks[0]) return rs[0];
  for (let i = 1; i < len; i++) {
    if (u <= ks[i]) {
      const x0 = ks[i - 1], x1 = ks[i];
      const y0 = rs[i - 1], y1 = rs[i];
      if (x1 <= x0) return y1;
      return y0 + (y1 - y0) * ((u - x0) / (x1 - x0));
    }
  }
  return rs[len - 1];
}
function fixed32ToFloat(v) {
  return numOrZero(v) / FIXED32_SCALE;
}

// ── Utilities ───────────────────────────────────────────────────────────
function truncHash(h, n = 8) {
  if (!h) return "—";
  if (h.length <= n * 2 + 3) return h;
  return h.slice(0, n) + "..." + h.slice(-n);
}

function fmtNumber(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}

function fmtSui(mist) {
  if (mist == null) return "—";
  return (Number(mist) / 1e9).toFixed(4) + " SUI";
}

function fmtCompact(n) {
  if (n == null || n === 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(2);
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

// timeAgo with full local time on hover
function timeTag(ts) {
  if (!ts) return '<span class="u-c-dim">—</span>';
  return `<span title="${fmtTime(ts)}" style="color:var(--text-dim);cursor:help;border-bottom:1px dotted var(--border)">${timeAgo(ts)}</span>`;
}

function fmtDayShort(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch (e) {
    return "—";
  }
}

function quantile(arr, q) {
  const vals = (arr || []).filter(Number.isFinite);
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.floor((s.length - 1) * q)));
  return s[idx];
}

function chunkArray(arr, size) {
  const out = [];
  if (!Array.isArray(arr) || size <= 0) return out;
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapChunksWithLimit(items, chunkSize, concurrency, worker) {
  const chunks = chunkArray(items || [], chunkSize);
  if (!chunks.length) return [];
  const limit = Math.max(1, Math.floor(Number(concurrency || 1)));
  const out = new Array(chunks.length);
  let cursor = 0;
  async function run() {
    while (cursor < chunks.length) {
      const idx = cursor;
      cursor += 1;
      out[idx] = await worker(chunks[idx], idx);
    }
  }
  const runners = Array.from({ length: Math.min(limit, chunks.length) }, () => run());
  await Promise.all(runners);
  return out;
}

function parseHistoryNumericValue(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    try {
      const j = JSON.parse(t);
      if (typeof j === "number" && Number.isFinite(j)) return j;
      if (typeof j === "string") {
        const n2 = Number(j);
        if (Number.isFinite(n2)) return n2;
      }
    } catch (_) { /* ignore */ }
    return null;
  }
  if (typeof v === "object") {
    if ("value" in v) return parseHistoryNumericValue(v.value);
    return null;
  }
  return null;
}

function hashLink(hash, route) {
  return `<a class="hash-link" href="#${route}">${truncHash(hash)}</a>`;
}

function fullHashLink(hash, route) {
  return `<a class="hash-link" href="#${route}">${hash}</a>`;
}

function copyBtn(text) {
  return `<button class="copy-btn" data-action="copy-text" data-copy-text="${escapeAttr(text)}" title="Copy" aria-label="Copy to clipboard">&#x2398;</button>`;
}

function statusBadge(s) {
  if (s === "SUCCESS") return '<span class="badge badge-success">Success</span>';
  return '<span class="badge badge-fail">Failed</span>';
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escapeAttr(s) {
  return escapeHtml(s)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCoinTypeLabel(coinType, addrChars = 6) {
  const normalized = normalizeCoinTypeQueryInput(coinType) || String(coinType || "");
  const sep = normalized.indexOf("::");
  if (sep <= 2) return normalized || "—";
  const addr = normalized.slice(0, sep);
  const rest = normalized.slice(sep);
  return `${truncHash(addr, addrChars)}${rest}`;
}

function coinTypeLink(coinType, label = "") {
  const normalized = normalizeCoinTypeQueryInput(coinType);
  const display = label || formatCoinTypeLabel(coinType);
  if (!normalized) return `<span class="coin-type-text">${escapeHtml(display)}</span>`;
  return `<a class="hash-link coin-type-text" href="#/coin?type=${encodeURIComponent(normalized)}" title="${escapeAttr(normalized)}">${escapeHtml(display)}</a>`;
}

// ── Intent Lite (deterministic, no extra requests) ──────────────────────
const INTENT_PROTOCOL_HINTS = {
  "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf": "suilend",
  "0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4": "alpha",
  "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb": "cetus",
  "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1": "turbos",
  "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267": "bluefin",
  "0x21d001e8b07da2e3facb3e2d636bbaef43ba3c978bd84810368840b7d57c5068": "aftermath",
  "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf": "scallop",
  "0x97d9473771b01f77b0940c589484184b49f6444627ec121314fae6a6d36fb86b": "deepbook",
};

function inferProtocolTag(pkgAddr) {
  if (!pkgAddr) return "";
  return mvrNameCache[pkgAddr] || INTENT_PROTOCOL_HINTS[pkgAddr] || "";
}

function intentConfidenceClass(confidence) {
  if (confidence === "high") return "intent-high";
  if (confidence === "medium") return "intent-medium";
  return "intent-low";
}

// Event/command keyword -> normalized action tags for intent and coin flow typing.
const EVENT_ACTION_TAGS = [
  { key: "swap", re: /swap/, label: "Swap", priority: 120 },
  { key: "fill", re: /\bfill/, label: "Fill", priority: 112 },
  { key: "order", re: /order/, label: "Order", priority: 110 },
  { key: "flash-loan", re: /flash/, label: "Flash Loan", priority: 102 },
  { key: "liquidation", re: /liquidat/, label: "Liquidation", priority: 100 },
  { key: "borrow", re: /borrow/, label: "Borrow", priority: 95 },
  { key: "repay", re: /repay/, label: "Repay", priority: 95 },
  { key: "deposit", re: /deposit/, label: "Deposit", priority: 92 },
  { key: "withdraw", re: /withdraw/, label: "Withdraw", priority: 92 },
  { key: "unstake", re: /unstake/, label: "Unstake", priority: 84 },
  { key: "stake", re: /(?<![re])stake/, label: "Stake", priority: 82 },
  { key: "claim", re: /claim/, label: "Claim", priority: 78 },
  { key: "mint", re: /\bmint/, label: "Mint", priority: 40 },
  { key: "burn", re: /\bburn/, label: "Burn", priority: 40 },
];
const COIN_SWAP_ACTION_KEYS = new Set(["swap", "fill"]);
const COIN_SUPPLY_ACTION_KEYS = new Set(["mint", "burn"]);
const COIN_NON_SUPPLY_ACTION_KEYS = new Set([
  "order",
  "flash-loan",
  "liquidation",
  "borrow",
  "repay",
  "deposit",
  "withdraw",
  "unstake",
  "stake",
  "claim",
]);
const ACTION_LABEL_TO_KEY = Object.freeze(EVENT_ACTION_TAGS.reduce((acc, tag) => {
  const key = String(tag?.key || "").trim().toLowerCase();
  const label = String(tag?.label || "").trim().toLowerCase();
  if (key) acc[key] = key;
  if (label) acc[label] = key;
  return acc;
}, {}));

function normalizeActionKey(actionInfo) {
  if (!actionInfo) return "";
  if (typeof actionInfo === "object") {
    const key = String(actionInfo?.key || "").trim().toLowerCase();
    if (key) return key;
    const label = String(actionInfo?.label || "").trim().toLowerCase();
    if (label && ACTION_LABEL_TO_KEY[label]) return ACTION_LABEL_TO_KEY[label];
    return label ? label.replace(/\s+/g, "-") : "";
  }
  const raw = String(actionInfo || "").trim().toLowerCase();
  if (!raw) return "";
  return ACTION_LABEL_TO_KEY[raw] || raw.replace(/\s+/g, "-");
}

function pickBestActionMatch(matches) {
  const rows = [...(matches || new Map()).values()];
  if (!rows.length) return null;
  rows.sort((a, b) =>
    (Number(b?.tag?.priority || 0) - Number(a?.tag?.priority || 0))
    || ((b?.count || 0) - (a?.count || 0))
    || String(a?.tag?.label || "").localeCompare(String(b?.tag?.label || ""))
  );
  return rows[0];
}

function classifyEventAction(events) {
  if (!events?.length) return null;
  const matches = new Map();
  for (const ev of events) {
    const typeRepr = String(ev?.contents?.type?.repr || "");
    const repr = typeRepr.toLowerCase();
    if (!repr) continue;
    for (const tag of EVENT_ACTION_TAGS) {
      if (!tag.re.test(repr)) continue;
      const prev = matches.get(tag.key);
      if (prev) {
        prev.count += 1;
      } else {
        matches.set(tag.key, { tag, count: 1, eventType: typeRepr });
      }
    }
  }
  const best = pickBestActionMatch(matches);
  if (!best) return null;
  return {
    key: best.tag.key,
    label: best.tag.label,
    priority: Number(best.tag.priority || 0),
    eventType: best.eventType || "",
    source: "event",
  };
}

function classifyMoveCallAction(commands) {
  const matches = new Map();
  for (const cmd of (commands || [])) {
    if (cmd?.__typename !== "MoveCallCommand") continue;
    const modName = String(cmd?.function?.module?.name || "");
    const fnName = String(cmd?.function?.name || "");
    const target = `${modName}::${fnName}`;
    const text = target.toLowerCase();
    if (!text || text === "::") continue;
    for (const tag of EVENT_ACTION_TAGS) {
      if (!tag.re.test(text)) continue;
      const prev = matches.get(tag.key);
      if (prev) {
        prev.count += 1;
      } else {
        matches.set(tag.key, { tag, count: 1, commandTarget: target });
      }
    }
  }
  const best = pickBestActionMatch(matches);
  if (!best) return null;
  return {
    key: best.tag.key,
    label: best.tag.label,
    priority: Number(best.tag.priority || 0),
    commandTarget: best.commandTarget || "",
    source: "command",
  };
}

function classifyTransactionAction(tx) {
  const eventAction = classifyEventAction(tx?.effects?.events?.nodes || []);
  const moveAction = classifyMoveCallAction(tx?.kind?.commands?.nodes || []);
  if (eventAction && moveAction) {
    // Prefer swap call signatures when event-only tags would otherwise downgrade to mint/burn.
    if (moveAction.key === "swap" && (eventAction.key === "mint" || eventAction.key === "burn")) {
      return {
        ...moveAction,
        source: "event+command",
        confidence: "high",
        eventType: eventAction.eventType || "",
      };
    }
    if ((eventAction.priority || 0) >= (moveAction.priority || 0)) {
      return { ...eventAction, confidence: "high" };
    }
    return { ...moveAction, confidence: moveAction.key === "swap" ? "high" : "medium" };
  }
  if (eventAction) return { ...eventAction, confidence: "high" };
  if (moveAction) return { ...moveAction, confidence: moveAction.key === "swap" ? "high" : "medium" };
  return null;
}

const COIN_TRANSFER_KIND_META = {
  transfer: { label: "Transfer", css: "transfer", fromFallback: "—", toFallback: "—" },
  inflow: { label: "Inflow", css: "transfer", fromFallback: "unknown/protocol", toFallback: "—" },
  outflow: { label: "Outflow", css: "transfer", fromFallback: "—", toFallback: "unknown/protocol" },
  mint: { label: "Mint/Inflow", css: "mint", fromFallback: "mint/system", toFallback: "—" },
  burn: { label: "Burn/Outflow", css: "burn", fromFallback: "—", toFallback: "burn/sink" },
  swap: { label: "Swap", css: "swap", fromFallback: "swap router/pool", toFallback: "swap router/pool" },
  "swap-in": { label: "Swap In", css: "swap", fromFallback: "swap router/pool", toFallback: "—" },
  "swap-out": { label: "Swap Out", css: "swap", fromFallback: "—", toFallback: "swap router/pool" },
  "object-transfer": { label: "Object Transfer", css: "transfer", fromFallback: "—", toFallback: "—" },
};

function classifyCoinBalanceFlowKind(sentRaw, recvRaw, actionInfo = null) {
  const sent = parseBigIntSafe(sentRaw);
  const recv = parseBigIntSafe(recvRaw);
  const hasSent = sent > 0n;
  const hasRecv = recv > 0n;
  const actionKey = normalizeActionKey(actionInfo);
  if (COIN_SWAP_ACTION_KEYS.has(actionKey)) {
    if (hasSent && hasRecv) return "swap";
    if (hasRecv) return "swap-in";
    if (hasSent) return "swap-out";
  }
  // Non-supply actions often move funds into protocol-owned accounts
  // without changing coin supply.
  if (actionKey && COIN_NON_SUPPLY_ACTION_KEYS.has(actionKey)) {
    if (hasSent && hasRecv) return "transfer";
    if (hasRecv) return "inflow";
    if (hasSent) return "outflow";
  }
  if (actionKey === "mint") {
    if (hasRecv && !hasSent) return "mint";
    if (hasSent && !hasRecv) return "outflow";
  }
  if (actionKey === "burn") {
    if (hasSent && !hasRecv) return "burn";
    if (hasRecv && !hasSent) return "inflow";
  }
  if (hasSent && hasRecv) return "transfer";
  if (hasRecv) return "mint";
  if (hasSent) return "burn";
  return "transfer";
}

function deriveCoinFlowKindWithContext(effects, targetKey, sentRaw, recvRaw, actionInfo = null) {
  const actionKey = normalizeActionKey(actionInfo);
  const baseKind = classifyCoinBalanceFlowKind(sentRaw, recvRaw, actionInfo);
  let flowKind = baseKind;
  let recastByContext = false;
  if (baseKind !== "mint" && baseKind !== "burn" && baseKind !== "inflow" && baseKind !== "outflow") {
    return { actionKey, baseKind, flowKind, recastByContext, hasOppositeNonTarget: false };
  }
  // Only auto-recast to swap when action is unknown or explicitly swap/fill.
  if (actionKey && !COIN_SWAP_ACTION_KEYS.has(actionKey)) {
    return { actionKey, baseKind, flowKind, recastByContext, hasOppositeNonTarget: false };
  }
  const allRows = effects?.balanceChanges?.nodes || [];
  const hasOppositeNonTarget = allRows.some((bc) => {
    const ct = coinTypeKey(bc?.coinType?.repr || "");
    if (!ct || ct === targetKey) return false;
    const raw = parseBigIntSafe(bc?.amount || 0);
    if (baseKind === "mint" || baseKind === "inflow") return raw < 0n;
    return raw > 0n;
  });
  if (hasOppositeNonTarget) {
    flowKind = (baseKind === "mint" || baseKind === "inflow") ? "swap-in" : "swap-out";
    recastByContext = true;
  }
  return { actionKey, baseKind, flowKind, recastByContext, hasOppositeNonTarget };
}

function classifyCoinFlowKindWithContext(effects, targetKey, sentRaw, recvRaw, actionInfo = null) {
  return deriveCoinFlowKindWithContext(effects, targetKey, sentRaw, recvRaw, actionInfo).flowKind;
}

function classifyCoinTransferFlow(effects, targetKey, sentRaw, recvRaw, txAction = null) {
  const derived = deriveCoinFlowKindWithContext(effects, targetKey, sentRaw, recvRaw, txAction);
  const actionKey = derived.actionKey || normalizeActionKey(txAction);
  const actionLabel = typeof txAction === "string" ? String(txAction) : String(txAction?.label || "");
  const actionSource = typeof txAction === "object" && txAction ? String(txAction?.source || "") : "";
  const actionConfidence = typeof txAction === "object" && txAction ? String(txAction?.confidence || "") : "";
  const reasons = [];
  if (actionKey) reasons.push(`action:${actionKey}`);
  reasons.push(`base:${derived.baseKind}`);
  if (derived.recastByContext) reasons.push("context:cross-asset-opposite-flow");
  const isSupplyChanging = COIN_SUPPLY_ACTION_KEYS.has(actionKey) || derived.flowKind === "mint" || derived.flowKind === "burn";
  return {
    actionKey,
    actionLabel,
    actionSource,
    actionConfidence,
    flowKind: derived.flowKind,
    baseKind: derived.baseKind,
    isSupplyChanging,
    reasons,
  };
}

function getCoinTransferKindMeta(kind, row = null) {
  const fallback = COIN_TRANSFER_KIND_META[kind] || COIN_TRANSFER_KIND_META.transfer;
  return {
    kindClass: fallback.css || "transfer",
    kindLabel: fallback.label || "Transfer",
    fromFallback: row?.fromHint || fallback.fromFallback || "—",
    toFallback: row?.toHint || fallback.toFallback || "—",
  };
}

const _intentCache = new Map();
function analyzeTxIntent(tx) {
  const digest = tx?.digest;
  if (digest && _intentCache.has(digest)) return _intentCache.get(digest);
  const result = _analyzeTxIntentInner(tx);
  if (digest) { if (_intentCache.size >= 1024) _intentCache.clear(); _intentCache.set(digest, result); }
  return result;
}
function _analyzeTxIntentInner(tx) {
  const kind = tx?.kind;
  if (!kind) {
    return { label: "Transaction", confidence: "low", protocol: "", evidence: ["Missing transaction kind metadata"] };
  }
  if (kind.__typename === "ConsensusCommitPrologueTransaction") {
    return { label: "Consensus", confidence: "high", protocol: "sui-system", evidence: ["ConsensusCommitPrologueTransaction"] };
  }
  if (kind.__typename === "EndOfEpochTransaction") {
    return { label: "End of Epoch", confidence: "high", protocol: "sui-system", evidence: ["EndOfEpochTransaction"] };
  }
  if (kind.__typename === "GenesisTransaction") {
    return { label: "Genesis", confidence: "high", protocol: "sui-system", evidence: ["GenesisTransaction"] };
  }

  const commands = kind?.commands?.nodes || [];
  if (!commands.length) {
    return { label: "System Tx", confidence: "medium", protocol: "", evidence: ["No programmable commands"] };
  }

  const counts = {
    move: 0,
    transfer: 0,
    split: 0,
    merge: 0,
    publish: 0,
    upgrade: 0,
    makeVec: 0,
    other: 0,
  };
  for (const c of commands) {
    const t = c.__typename;
    if (t === "MoveCallCommand") counts.move++;
    else if (t === "TransferObjectsCommand") counts.transfer++;
    else if (t === "SplitCoinsCommand") counts.split++;
    else if (t === "MergeCoinsCommand") counts.merge++;
    else if (t === "PublishCommand") counts.publish++;
    else if (t === "UpgradeCommand") counts.upgrade++;
    else if (t === "MakeMoveVecCommand") counts.makeVec++;
    else counts.other++;
  }

  const firstMove = commands.find(c => c.__typename === "MoveCallCommand");
  const movePkg = firstMove?.function?.module?.package?.address;
  const moveTarget = firstMove?.function?.module?.name && firstMove?.function?.name
    ? `${firstMove.function.module.name}::${firstMove.function.name}`
    : "";
  const protocol = inferProtocolTag(movePkg);

  // Event-based action tagging (high confidence — protocol-authored events)
  const txAction = classifyTransactionAction(tx);

  let label = "Programmable Tx";
  let confidence = "low";
  const evidence = [];

  if (txAction) {
    label = txAction.label;
    confidence = txAction.confidence || "medium";
    if (txAction.eventType) evidence.push(`Event: ${txAction.eventType}`);
    if (txAction.commandTarget) evidence.push(`MoveCall: ${txAction.commandTarget}`);
  } else if (counts.publish > 0) {
    label = counts.publish > 1 ? "Publish Batch" : "Publish";
    confidence = "high";
    evidence.push(`${counts.publish} publish command${counts.publish > 1 ? "s" : ""}`);
  } else if (counts.upgrade > 0) {
    label = counts.upgrade > 1 ? "Upgrade Batch" : "Upgrade";
    confidence = "high";
    evidence.push(`${counts.upgrade} upgrade command${counts.upgrade > 1 ? "s" : ""}`);
  } else if (counts.move === 0 && counts.transfer > 0 && counts.transfer === commands.length) {
    label = "Transfer";
    confidence = "high";
    evidence.push(`${counts.transfer} transfer command${counts.transfer > 1 ? "s" : ""}`);
  } else if (counts.move === 0 && (counts.split > 0 || counts.merge > 0) && counts.split + counts.merge === commands.length) {
    label = counts.split > 0 && counts.merge > 0 ? "Coin Rebalance" : (counts.split > 0 ? "Coin Split" : "Coin Merge");
    confidence = "high";
    evidence.push(`${counts.split} split / ${counts.merge} merge`);
  } else if (counts.move === 1) {
    label = "Move Call";
    confidence = "medium";
    evidence.push("Single move call");
  } else if (counts.move > 1) {
    label = "Multi MoveCall";
    confidence = "medium";
    evidence.push(`${counts.move} move calls`);
  }

  if (moveTarget) evidence.push(`Target: ${moveTarget}`);
  if (protocol) evidence.push(`Protocol hint: @${protocol}`);

  return { label, confidence, protocol, evidence };
}

function renderIntentChip(intent, { showProtocol = true } = {}) {
  const safe = intent || { label: "Unknown", confidence: "low", protocol: "", evidence: [] };
  const cls = intentConfidenceClass(safe.confidence);
  const title = safe.evidence?.length ? ` title="${escapeAttr(safe.evidence.join(" | "))}"` : "";
  const proto = (showProtocol && safe.protocol) ? `<span class="intent-proto">@${escapeHtml(safe.protocol)}</span>` : "";
  return `<span class="intent-chip ${cls}"${title}>${escapeHtml(safe.label)}</span>${proto}`;
}

function renderLoading() {
  return '<div class="loading"><div class="spinner"></div><br>Loading...</div>';
}

function renderEmpty(msg = "No data found.") {
  return `<div class="empty">${msg}</div>`;
}

function renderStackBar(segments, opts = {}) {
  const rows = (segments || []).map(s => ({
    label: String(s?.label || "Unknown"),
    value: Number(s?.value || 0),
    color: s?.color || "var(--accent)",
  })).filter(s => s.value > 0);
  const total = rows.reduce((sum, r) => sum + r.value, 0);
  if (!total) return opts.empty || '<div class="u-fs12-dim">No data.</div>';
  const maxLegend = Number.isFinite(opts.maxLegend) ? opts.maxLegend : 6;
  return `
    <div class="stackbar">
      ${rows.map((r) => {
        const pct = r.value / total * 100;
        const tip = `${r.label}: ${fmtNumber(r.value)} (${pct.toFixed(1)}%)`;
        return `<div class="stackbar-seg" style="width:${pct.toFixed(2)}%;background:${r.color}" data-chart-tooltip="${escapeAttr(tip)}"></div>`;
      }).join("")}
    </div>
    <div class="stackbar-legend">
      ${rows.slice(0, maxLegend).map(r => {
        const pct = r.value / total * 100;
        return `<span><span class="stackbar-dot" style="background:${r.color}"></span>${escapeHtml(r.label)} ${pct.toFixed(1)}%</span>`;
      }).join("")}
      ${rows.length > maxLegend ? `<span class="u-c-dim">+${rows.length - maxLegend} more</span>` : ""}
    </div>
  `;
}

let sparklineSeq = 0;
function renderSparkline(values, opts = {}) {
  const nums = (values || []).map(v => Number(v)).filter(Number.isFinite);
  if (nums.length < 2) return "";
  const W = Number(opts.width || 180);
  const H = Number(opts.height || 24);
  const pad = Number(opts.pad || 2);
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const xAt = (i) => pad + (i * ((W - pad * 2) / Math.max(1, nums.length - 1)));
  const yAt = (v) => {
    const t = (v - min) / (max - min);
    return (H - pad) - t * (H - pad * 2);
  };
  const points = nums.map((v, i) => `${xAt(i).toFixed(2)},${yAt(v).toFixed(2)}`).join(" ");
  const color = opts.color || "var(--accent)";
  const id = `sparkline-crosshair-${sparklineSeq++}`;
  const circles = nums.map((v, i) => {
    const x = xAt(i).toFixed(2);
    const y = yAt(v).toFixed(2);
    const tip = `${opts.prefix || ""}${fmtNumber(v)}${opts.suffix || ""}`;
    return `<circle cx="${x}" cy="${y}" r="5" fill="transparent" data-chart-tooltip="${escapeAttr(tip)}" data-chart-crosshair-id="${id}" data-chart-crosshair-x="${x}" />`;
  }).join("");
  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
      <line id="${id}" x1="${pad}" y1="1" x2="${pad}" y2="${H - 1}" stroke="${color}" opacity="0.45" stroke-dasharray="3 3" style="display:none"></line>
      <polyline fill="none" stroke="${color}" stroke-width="1.8" points="${points}" />
      ${circles}
    </svg>
  `;
}

function parseRelativeAgoToMs(text) {
  const m = String(text || "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([smhd])\s*ago$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (!Number.isFinite(n)) return null;
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  return null;
}

function parseCompactNumericToken(token) {
  const m = String(token || "").match(/^([-+]?\d+(?:\.\d+)?)([kmbt])$/i);
  if (!m) return null;
  const base = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(base)) return null;
  const scale = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : 1e12;
  return base * scale;
}

function parseSortableCellValue(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return { type: "empty", value: "" };
  const relMs = parseRelativeAgoToMs(raw);
  if (Number.isFinite(relMs)) return { type: "number", value: relMs };
  const lower = raw.toLowerCase();
  if (/^v\d+(\.\d+)?$/.test(lower)) return { type: "number", value: Number(lower.slice(1)) };
  if (!lower.startsWith("0x")) {
    // Check plain numbers and compact suffixes BEFORE Date.parse to avoid
    // JS interpreting numbers like "52" or "1000" as calendar years.
    const stripped = lower.replace(/[$,%]/g, "").replace(/,/g, "").trim();
    const compactCandidate = stripped.match(/^[-+]?\d+(?:\.\d+)?[kmbt]$/i)?.[0];
    const compact = parseCompactNumericToken(compactCandidate);
    if (Number.isFinite(compact)) return { type: "number", value: compact };
    const pureNum = stripped.match(/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i)?.[0];
    if (pureNum != null) {
      const n = Number(pureNum);
      if (Number.isFinite(n)) return { type: "number", value: n };
    }
    const dt = Date.parse(raw);
    if (Number.isFinite(dt)) return { type: "number", value: dt };
  }
  return { type: "text", value: lower };
}

function compareSortableValues(a, b) {
  if (a.type === "number" && b.type === "number") return a.value - b.value;
  if (a.type === "number" && b.type !== "number") return -1;
  if (a.type !== "number" && b.type === "number") return 1;
  return String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: "base" });
}

function sortTableByColumn(table, colIdx, dir = "asc") {
  const tbody = table.tBodies?.[0];
  if (!tbody) return;
  const rows = Array.from(tbody.rows).map((row, idx) => {
    const cell = row.cells?.[colIdx];
    const raw = cell?.dataset?.sortValue != null ? String(cell.dataset.sortValue) : String(cell?.innerText || "");
    return { row, idx, sortVal: parseSortableCellValue(raw) };
  });
  rows.sort((a, b) => {
    const c = compareSortableValues(a.sortVal, b.sortVal);
    if (c === 0) return a.idx - b.idx;
    return dir === "asc" ? c : -c;
  });
  for (const r of rows) tbody.appendChild(r.row);
}

function enhanceSortableTables(root = document) {
  const tables = root.querySelectorAll("table");
  for (const table of tables) {
    if (table.dataset.sortableInit === "1") continue;
    const tbody = table.tBodies?.[0];
    const headerRow = table.tHead?.rows?.[0];
    if (!tbody || !headerRow) continue;
    const headers = Array.from(headerRow.cells || []);
    const bodyRows = Array.from(tbody.rows || []);
    if (!headers.length || bodyRows.length < 2) continue;
    // Skip complex tables with expandable/detail rows where sorting breaks row pairing.
    if (bodyRows.some(row => row.querySelector("[colspan]"))) continue;
    if (bodyRows.some(row => row.cells.length !== headers.length)) continue;
    table.dataset.sortableInit = "1";
    headers.forEach((th, idx) => {
      th.classList.add("sortable-header");
      th.setAttribute("role", "button");
      th.setAttribute("tabindex", "0");
      th.dataset.sortDir = "";
      const trigger = () => {
        const isSame = table.dataset.sortCol === String(idx);
        const dir = isSame && table.dataset.sortDir === "asc" ? "desc" : "asc";
        table.dataset.sortCol = String(idx);
        table.dataset.sortDir = dir;
        headers.forEach((h, i) => { h.dataset.sortDir = i === idx ? dir : ""; });
        sortTableByColumn(table, idx, dir);
      };
      th.addEventListener("click", trigger);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          trigger();
        }
      });
    });
  }
}

let chartTooltipEl = null;
let chartTooltipActiveEl = null;
let chartTooltipPinnedEl = null;
let chartTooltipPinnedPoint = null;
let chartCrosshairActiveEl = null;
let uiEnhanceObserver = null;
let uiEnhanceRaf = 0;

function ensureChartTooltip() {
  if (chartTooltipEl) return chartTooltipEl;
  chartTooltipEl = document.createElement("div");
  chartTooltipEl.className = "chart-tooltip";
  document.body.appendChild(chartTooltipEl);
  return chartTooltipEl;
}

function hideChartTooltip() {
  if (!chartTooltipEl) return;
  if (chartTooltipPinnedEl) return;
  chartTooltipEl.style.display = "none";
  chartTooltipEl.classList.remove("pinned");
  chartTooltipActiveEl = null;
  if (chartCrosshairActiveEl) {
    chartCrosshairActiveEl.style.display = "none";
    chartCrosshairActiveEl = null;
  }
}

function setChartCrosshairFromEl(ownerEl) {
  const id = ownerEl?.dataset?.chartCrosshairId;
  const x = Number(ownerEl?.dataset?.chartCrosshairX);
  if (!id || !Number.isFinite(x)) {
    if (chartCrosshairActiveEl) {
      chartCrosshairActiveEl.style.display = "none";
      chartCrosshairActiveEl = null;
    }
    return;
  }
  const line = document.getElementById(id);
  if (!line) return;
  line.setAttribute("x1", String(x));
  line.setAttribute("x2", String(x));
  line.style.display = "block";
  chartCrosshairActiveEl = line;
}

function unpinChartTooltip() {
  chartTooltipPinnedEl = null;
  chartTooltipPinnedPoint = null;
  if (!chartTooltipEl) return;
  chartTooltipEl.classList.remove("pinned");
  chartTooltipEl.style.display = "none";
  if (chartCrosshairActiveEl) {
    chartCrosshairActiveEl.style.display = "none";
    chartCrosshairActiveEl = null;
  }
}

function pinChartTooltip(ownerEl, text, x, y) {
  if (!ownerEl) return;
  chartTooltipPinnedEl = ownerEl;
  chartTooltipPinnedPoint = { x, y };
  setChartCrosshairFromEl(ownerEl);
  showChartTooltip(text, x, y, ownerEl);
  if (chartTooltipEl) chartTooltipEl.classList.add("pinned");
}

function showChartTooltip(text, x, y, ownerEl) {
  if (chartTooltipPinnedEl && ownerEl && ownerEl !== chartTooltipPinnedEl) return;
  const tip = ensureChartTooltip();
  const safe = String(text || "").trim();
  if (!safe) { hideChartTooltip(); return; }
  chartTooltipActiveEl = ownerEl || null;
  tip.textContent = safe;
  tip.classList.toggle("pinned", !!chartTooltipPinnedEl);
  tip.style.display = "block";
  const pad = 12;
  const rect = tip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, top) + "px";
  if (ownerEl) setChartCrosshairFromEl(ownerEl);
}

function enhanceChartHoverTooltips(root = document) {
  const nodes = root.querySelectorAll("[data-chart-tooltip], svg [title], .tvl-bar [title]");
  for (const el of nodes) {
    if (el.dataset.chartTooltipBound === "1") continue;
    if (!el.hasAttribute("data-chart-tooltip") && el.hasAttribute("title")) {
      el.setAttribute("data-chart-tooltip", el.getAttribute("title") || "");
      el.removeAttribute("title");
    }
    const getText = () => el.getAttribute("data-chart-tooltip") || "";
    el.dataset.chartTooltipBound = "1";
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    el.addEventListener("mouseenter", (e) => showChartTooltip(getText(), e.clientX, e.clientY, el));
    el.addEventListener("mousemove", (e) => {
      if (chartTooltipActiveEl === el) showChartTooltip(getText(), e.clientX, e.clientY, el);
    });
    el.addEventListener("mouseleave", () => {
      if (!chartTooltipPinnedEl && chartTooltipActiveEl === el) hideChartTooltip();
    });
    el.addEventListener("focus", () => {
      const r = el.getBoundingClientRect();
      showChartTooltip(getText(), r.left + 8, r.top + 8, el);
    });
    el.addEventListener("blur", () => {
      if (!chartTooltipPinnedEl && chartTooltipActiveEl === el) hideChartTooltip();
    });
    el.addEventListener("click", (e) => {
      const text = getText();
      if (!text) return;
      if (chartTooltipPinnedEl === el) {
        unpinChartTooltip();
        return;
      }
      pinChartTooltip(el, text, e.clientX, e.clientY);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        if (chartTooltipPinnedEl === el) {
          unpinChartTooltip();
        } else {
          pinChartTooltip(el, getText(), r.left + 8, r.top + 8);
        }
      }
    });
  }
}

document.addEventListener("click", (e) => {
  if (!chartTooltipPinnedEl) return;
  if (e.target === chartTooltipPinnedEl) return;
  unpinChartTooltip();
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target?.matches?.(".jtree-toggle[data-action='jtree-toggle']")) {
    e.preventDefault();
    e.target.click();
    return;
  }
  if (e.key === "Escape" && chartTooltipPinnedEl) unpinChartTooltip();
});

function applyUiEnhancements() {
  const app = document.getElementById("app");
  if (!app) return;
  enhanceSortableTables(app);
  enhanceChartHoverTooltips(app);
}

function scheduleUiEnhancements() {
  if (uiEnhanceRaf) return;
  uiEnhanceRaf = requestAnimationFrame(() => {
    uiEnhanceRaf = 0;
    applyUiEnhancements();
  });
}

function initUiEnhancements() {
  const app = document.getElementById("app");
  if (!app || uiEnhanceObserver) return;
  uiEnhanceObserver = new MutationObserver(() => scheduleUiEnhancements());
  uiEnhanceObserver.observe(app, { childList: true, subtree: true });
  scheduleUiEnhancements();
}

function runWhenVisible(target, task, opts = {}) {
  const rootMargin = String(opts?.rootMargin || "280px 0px");
  const timeoutMs = Math.max(0, Number(opts?.timeoutMs ?? 2500));
  const el = typeof target === "string" ? document.getElementById(target) : target;
  if (!el || typeof task !== "function") return;
  let done = false;
  let observer = null;
  let timer = null;
  const run = () => {
    if (done) return;
    done = true;
    if (observer) observer.disconnect();
    observer = null;
    if (timer) clearTimeout(timer);
    timer = null;
    Promise.resolve().then(task).catch(() => null);
  };
  if (typeof IntersectionObserver !== "function") {
    run();
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if ((entries || []).some((entry) => entry?.isIntersecting)) run();
  }, { root: null, rootMargin, threshold: 0.01 });
  observer.observe(el);
  if (timeoutMs > 0) timer = setTimeout(run, timeoutMs);
}

function viewQueryBtn(queryKey, params = {}) {
  const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const href = `#/graphql?q=${queryKey}${qs ? '&' + qs : ''}`;
  return `<a class="gql-query-btn" href="${href}" title="View the GraphQL query powering this page">&lt;/&gt; Query</a>`;
}

// ── Coin Metadata Cache ─────────────────────────────────────────────────
const coinMetaCache = {};
const coinTotalSupplyRpcCache = {};
const coinTxMetaDigestCache = {};
const coinTxDetailDigestCache = {};
const coinObjectDigestCache = {};
const coinActivityScanCache = {};
const COIN_OBJECT_DIGEST_TTL_MS = 20 * 1000;
const COIN_ACTIVITY_SCAN_TTL_MS = 25 * 1000;
const COIN_ACTIVITY_SCAN_CACHE_MAX = 120;
const COIN_ACTIVITY_SCAN_MODE_CONFIG = Object.freeze({
  fast: {
    label: "Fast",
    pageSize: 20,
    resultLimit: 50,
    globalScanMaxTx: 60,
    globalScanEmptyPageThreshold: 2,
    objectScanMaxPages: 6,
    objectScanMaxDigests: 160,
    objectTxLoadLimit: 48,
  },
  full: {
    label: "Full",
    pageSize: 20,
    resultLimit: 50,
    globalScanMaxTx: 220,
    globalScanEmptyPageThreshold: 3,
    objectScanMaxPages: 12,
    objectScanMaxDigests: 420,
    objectTxLoadLimit: 120,
  },
});

function getCoinActivityScanMode(rawMode) {
  return String(rawMode || "").toLowerCase() === "full" ? "full" : "fast";
}

function coinSearchPackTransferRows(rows) {
  return (rows || []).map((row) => ([
    String(row?.digest || ""),
    String(row?.timestamp || ""),
    String(row?.status || ""),
    Array.isArray(row?.fromRows) ? row.fromRows.filter(Boolean) : [],
    Array.isArray(row?.toRows) ? row.toRows.filter(Boolean) : [],
    row?.amountRaw == null ? "" : String(row.amountRaw),
    String(row?.kind || ""),
    String(row?.fromHint || ""),
    String(row?.toHint || ""),
    String(row?.actionLabel || ""),
    String(row?.actionKey || ""),
    String(row?.actionSource || ""),
    String(row?.actionConfidence || ""),
    String(row?.baseKind || ""),
    Array.isArray(row?.actionReasons) ? row.actionReasons.map((r) => String(r || "")) : [],
  ]));
}

function coinSearchUnpackTransferRows(rows) {
  return (rows || []).map((row) => ({
    digest: String(row?.[0] || ""),
    timestamp: String(row?.[1] || ""),
    status: String(row?.[2] || ""),
    fromRows: Array.isArray(row?.[3]) ? row[3] : [],
    toRows: Array.isArray(row?.[4]) ? row[4] : [],
    amountRaw: row?.[5] ? parseBigIntSafe(row[5]) : null,
    kind: String(row?.[6] || ""),
    fromHint: String(row?.[7] || ""),
    toHint: String(row?.[8] || ""),
    actionLabel: String(row?.[9] || ""),
    actionKey: String(row?.[10] || ""),
    actionSource: String(row?.[11] || ""),
    actionConfidence: String(row?.[12] || ""),
    baseKind: String(row?.[13] || ""),
    actionReasons: Array.isArray(row?.[14]) ? row[14].map((r) => String(r || "")) : [],
  }));
}

function coinSearchPackEventRows(rows) {
  return (rows || []).map((row) => ([
    String(row?.digest || ""),
    String(row?.timestamp || ""),
    String(row?.status || ""),
    String(row?.sender || ""),
    String(row?.typeRepr || ""),
    String(row?.moduleName || ""),
    String(row?.modulePackage || ""),
    String(row?.jsonPreview || ""),
    String(row?.matchSource || ""),
  ]));
}

function coinSearchUnpackEventRows(rows) {
  return (rows || []).map((row) => ({
    digest: String(row?.[0] || ""),
    timestamp: String(row?.[1] || ""),
    status: String(row?.[2] || ""),
    sender: String(row?.[3] || ""),
    typeRepr: String(row?.[4] || ""),
    moduleName: String(row?.[5] || ""),
    modulePackage: String(row?.[6] || ""),
    jsonPreview: String(row?.[7] || ""),
    matchSource: String(row?.[8] || ""),
  }));
}

function coinSearchPackObjectRows(rows) {
  return (rows || []).map((row) => ([
    String(row?.digest || ""),
    String(row?.timestamp || ""),
    String(row?.status || ""),
    String(row?.objectId || ""),
    String(row?.changeKind || ""),
    String(row?.typeRepr || ""),
    String(row?.ownerAddress || ""),
    String(row?.ownerKind || ""),
  ]));
}

function coinSearchUnpackObjectRows(rows) {
  return (rows || []).map((row) => ({
    digest: String(row?.[0] || ""),
    timestamp: String(row?.[1] || ""),
    status: String(row?.[2] || ""),
    objectId: String(row?.[3] || ""),
    changeKind: String(row?.[4] || ""),
    typeRepr: String(row?.[5] || ""),
    ownerAddress: String(row?.[6] || ""),
    ownerKind: String(row?.[7] || ""),
  }));
}

function coinSearchPackMatchedActivityRows(rows) {
  return (rows || []).map((row) => ([
    String(row?.digest || ""),
    String(row?.timestamp || ""),
    String(row?.status || ""),
    String(row?.sender || ""),
    String(row?.signals || ""),
  ]));
}

function coinSearchUnpackMatchedActivityRows(rows) {
  return (rows || []).map((row) => ({
    digest: String(row?.[0] || ""),
    timestamp: String(row?.[1] || ""),
    status: String(row?.[2] || ""),
    sender: String(row?.[3] || ""),
    signals: String(row?.[4] || ""),
  }));
}

function coinSearchPackActivityScanResult(data) {
  if (!data) return data;
  return {
    mode: String(data.scanMode || "fast"),
    r: Number(data.resultLimit || 50),
    s: [
      Number(data.scannedTx || 0),
      Number(data.scannedPages || 0),
      Number(data.objectFallbackScannedObjects || 0),
      Number(data.objectFallbackScannedPages || 0),
      Number(data.objectFallbackConsideredDigests || 0),
      Number(data.objectFallbackLoadedTx || 0),
      Number(data.directEventCount || 0),
      Number(data.contextEventCount || 0),
      Number(data.matchedTxCount || 0),
    ],
    f: [
      data.objectDigestHasNext ? 1 : 0,
      data.globalSupplementApplied ? 1 : 0,
      data.globalScanEarlyStop ? 1 : 0,
      data.truncatedBalances ? 1 : 0,
      data.truncatedEvents ? 1 : 0,
      data.truncatedObjects ? 1 : 0,
      data.scanLimitReached ? 1 : 0,
      data.usedObjectScan ? 1 : 0,
    ],
    n: Array.isArray(data.notes) ? data.notes.map((row) => String(row || "")) : [],
    l: [
      String(data.transferEmptyLabel || ""),
      String(data.eventEmptyLabel || ""),
    ],
    t: coinSearchPackTransferRows(data.transfers || []),
    e: coinSearchPackEventRows(data.events || []),
    o: coinSearchPackObjectRows(data.objects || []),
    m: coinSearchPackMatchedActivityRows(data.matchedActivity || []),
  };
}

function coinSearchUnpackActivityScanResult(data) {
  if (!data) return data;
  const s = Array.isArray(data?.s) ? data.s : [];
  const f = Array.isArray(data?.f) ? data.f : [];
  const l = Array.isArray(data?.l) ? data.l : [];
  return {
    scanMode: getCoinActivityScanMode(data?.mode),
    resultLimit: Number(data?.r || 50),
    scannedTx: Number(s[0] || 0),
    scannedPages: Number(s[1] || 0),
    objectFallbackScannedObjects: Number(s[2] || 0),
    objectFallbackScannedPages: Number(s[3] || 0),
    objectFallbackConsideredDigests: Number(s[4] || 0),
    objectFallbackLoadedTx: Number(s[5] || 0),
    directEventCount: Number(s[6] || 0),
    contextEventCount: Number(s[7] || 0),
    matchedTxCount: Number(s[8] || 0),
    objectDigestHasNext: !!Number(f[0] || 0),
    globalSupplementApplied: !!Number(f[1] || 0),
    globalScanEarlyStop: !!Number(f[2] || 0),
    truncatedBalances: !!Number(f[3] || 0),
    truncatedEvents: !!Number(f[4] || 0),
    truncatedObjects: !!Number(f[5] || 0),
    scanLimitReached: !!Number(f[6] || 0),
    usedObjectScan: !!Number(f[7] || 0),
    notes: Array.isArray(data?.n) ? data.n.map((row) => String(row || "")) : [],
    transferEmptyLabel: String(l[0] || ""),
    eventEmptyLabel: String(l[1] || ""),
    transfers: coinSearchUnpackTransferRows(data?.t || []),
    events: coinSearchUnpackEventRows(data?.e || []),
    objects: coinSearchUnpackObjectRows(data?.o || []),
    matchedActivity: coinSearchUnpackMatchedActivityRows(data?.m || []),
  };
}

async function coinSearchLoadActivityScanCached(cacheKey, { force = false, ttlMs = COIN_ACTIVITY_SCAN_TTL_MS } = {}, loader) {
  const state = getKeyedCacheState(coinActivityScanCache, cacheKey);
  const packed = await withTimedCache(state, ttlMs, !!force, async () => {
    const raw = await loader();
    return coinSearchPackActivityScanResult(raw);
  });
  prunePlainObjectCache(coinActivityScanCache, COIN_ACTIVITY_SCAN_CACHE_MAX);
  return coinSearchUnpackActivityScanResult(packed);
}

function prunePlainObjectCache(obj, maxEntries = 2500) {
  const keys = Object.keys(obj || {});
  if (keys.length <= maxEntries) return;
  const drop = Math.max(1, keys.length - maxEntries);
  for (let i = 0; i < drop; i += 1) delete obj[keys[i]];
}

function coinSearchSummarizeJson(value, maxLen = 180) {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return "";
    return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
  } catch (_) {
    return "";
  }
}

function coinSearchRenderAddressList(addrs, emptyLabel = "—") {
  const rows = [...new Set((addrs || []).map((a) => normalizeSuiAddress(a)).filter(Boolean))];
  if (!rows.length) return `<span class="u-c-dim">${escapeHtml(emptyLabel)}</span>`;
  const first = rows[0];
  const extra = rows.length > 1 ? ` <span class="u-fs11-dim">+${rows.length - 1}</span>` : "";
  return `${hashLink(first, "/address/" + first)}${extra}`;
}

function coinSearchParseOwnerInfo(owner) {
  if (owner?.initialSharedVersion != null) return { address: "", kind: "shared" };
  if (owner?.__typename === "Immutable") return { address: "", kind: "immutable" };
  const address = normalizeSuiAddress(owner?.address?.address || "");
  if (address) return { address, kind: "address" };
  return { address: "", kind: "" };
}

function coinSearchFmtCoinAbs(raw, decimals) {
  const bi = typeof raw === "bigint" ? raw : parseBigIntSafe(raw);
  if (bi <= 0n) return "0";
  const approx = scaledBigIntAbsToApprox(bi, decimals, 8);
  if (!Number.isFinite(approx) || approx > 1e15) return scaledBigIntToText(bi, decimals, 8);
  if (approx >= 1000000) return fmtCompact(approx);
  if (approx >= 1) return approx.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (approx >= 0.0001) return approx.toLocaleString(undefined, { maximumFractionDigits: 8 });
  return approx.toExponential(2);
}

async function coinSearchFetchObjectDigestCandidates(coinTypeValue, { maxPages = 8, maxDigests = 280, force = false } = {}) {
  const safePages = Math.max(1, Number(maxPages || 0));
  const safeDigests = Math.max(1, Number(maxDigests || 0));
  const keyBase = coinTypeKey(coinTypeValue) || normalizeCoinType(coinTypeValue) || String(coinTypeValue || "");
  const cacheKey = `${keyBase}|p${safePages}|d${safeDigests}`;
  const cacheState = getKeyedCacheState(coinObjectDigestCache, cacheKey);
  return withTimedCache(cacheState, COIN_OBJECT_DIGEST_TTL_MS, !!force, async () => {
    const coinObjectType = `0x2::coin::Coin<${coinTypeValue}>`;
    let after = null;
    let hasNext = true;
    let pages = 0;
    const rows = [];
    while (hasNext && pages < safePages && rows.length < safeDigests * 2) {
      const data = await gql(`query($type: String!, $after: String) {
        objects(filter: { type: $type }, first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            version
            previousTransaction { digest }
          }
        }
      }`, { type: coinObjectType, after });
      const conn = data?.objects;
      const nodes = conn?.nodes || [];
      for (const node of nodes) {
        const digest = String(node?.previousTransaction?.digest || "");
        if (!digest) continue;
        rows.push({ digest, version: parseBigIntSafe(node?.version || 0) });
      }
      pages += 1;
      hasNext = !!conn?.pageInfo?.hasNextPage;
      after = conn?.pageInfo?.endCursor || null;
      if (!nodes.length) break;
    }
    rows.sort((a, b) => (a.version === b.version ? 0 : (a.version < b.version ? 1 : -1)));
    const deduped = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row.digest || seen.has(row.digest)) continue;
      seen.add(row.digest);
      deduped.push(row.digest);
      if (deduped.length >= safeDigests) break;
    }
    return {
      digests: deduped,
      pages,
      sampledObjects: rows.length,
      hasNext,
    };
  });
}

async function coinSearchFetchTxMetaRowsByDigest(digests) {
  const uniqueDigests = [...new Set((digests || []).filter(Boolean))];
  const rows = [];
  const missing = [];
  for (const digest of uniqueDigests) {
    const cached = coinTxMetaDigestCache[digest];
    if (cached) rows.push(cached);
    else missing.push(digest);
  }
  const chunkRows = await mapChunksWithLimit(missing, 30, 6, async (chunk) => {
    if (!chunk.length) return [];
    const aliases = chunk.map((digest, i) => `t${i}: transaction(digest: "${digest}") { digest effects { status timestamp } }`);
    const data = await gql(`{ ${aliases.join("\n")} }`).catch(() => null);
    if (!data) return [];
    const out = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const tx = data?.[`t${i}`];
      if (!tx?.digest) continue;
      const row = {
        digest: tx.digest,
        timestamp: tx?.effects?.timestamp || "",
        status: tx?.effects?.status || "",
      };
      out.push(row);
      coinTxMetaDigestCache[row.digest] = row;
    }
    prunePlainObjectCache(coinTxMetaDigestCache, 4000);
    return out;
  });
  rows.push(...chunkRows.flat());
  return rows;
}

async function coinSearchFetchTxDetailsByDigest(digests) {
  const uniqueDigests = [...new Set((digests || []).filter(Boolean))];
  const rows = [];
  const missing = [];
  for (const digest of uniqueDigests) {
    const cached = coinTxDetailDigestCache[digest];
    if (cached) rows.push(cached);
    else missing.push(digest);
  }
  // Keep payload below Sui GraphQL 5KB request cap.
  const chunkRows = await mapChunksWithLimit(missing, 2, 4, async (chunk) => {
    if (!chunk.length) return [];
    const aliases = chunk.map((digest, i) => `t${i}: transaction(digest: "${digest}") {
      digest
      sender { address }
      kind {
        __typename
        ... on ProgrammableTransaction {
          commands(first: 8) {
            nodes {
              __typename
              ... on MoveCallCommand {
                function { name module { name package { address } } }
              }
            }
          }
        }
      }
      effects {
        status timestamp
        balanceChanges(first: 50) {
          pageInfo { hasNextPage }
          nodes { ${GQL_F_BAL_NODE} }
        }
        events(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            ${GQL_F_EVENT_NODE}
          }
        }
        objectChanges(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            address idCreated idDeleted
            inputState {
              owner {
                ${GQL_F_OWNER}
              }
              ${GQL_F_MOVE_TYPE}
            }
            outputState {
              owner {
                ${GQL_F_OWNER}
              }
              ${GQL_F_MOVE_TYPE}
            }
          }
        }
      }
    }`);
    const data = await gql(`{ ${aliases.join("\n")} }`).catch(() => null);
    if (!data) return [];
    const out = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const tx = data?.[`t${i}`];
      if (!tx?.digest) continue;
      out.push(tx);
      coinTxDetailDigestCache[tx.digest] = tx;
    }
    prunePlainObjectCache(coinTxDetailDigestCache, 1500);
    return out;
  });
  rows.push(...chunkRows.flat());
  return rows;
}

const CoinSearchData = Object.freeze({
  summarizeJson: coinSearchSummarizeJson,
  renderAddressList: coinSearchRenderAddressList,
  parseOwnerInfo: coinSearchParseOwnerInfo,
  fmtCoinAbs: coinSearchFmtCoinAbs,
  fetchObjectDigestCandidates: coinSearchFetchObjectDigestCandidates,
  fetchTxMetaRowsByDigest: coinSearchFetchTxMetaRowsByDigest,
  fetchTxDetailsByDigest: coinSearchFetchTxDetailsByDigest,
});

async function fetchCoinObjectSupplySnapshot(coinType, { maxObjects = 1200, maxPages = 32 } = {}) {
  const coinObjType = `0x2::coin::Coin<${coinType}>`;
  let after = null;
  let hasNext = true;
  let pages = 0;
  let objectCount = 0;
  let total = 0n;
  while (hasNext && pages < Math.max(1, Number(maxPages || 0)) && objectCount < Math.max(1, Number(maxObjects || 0))) {
    const data = await gql(`query($type: String!, $after: String) {
      objects(filter: { type: $type }, first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${GQL_F_MOVE_JSON} }
      }
    }`, { type: coinObjType, after });
    const conn = data?.objects;
    const nodes = conn?.nodes || [];
    for (const node of nodes) {
      const balRaw = node?.asMoveObject?.contents?.json?.balance;
      total += parseBigIntSafe(balRaw ?? 0);
      objectCount += 1;
      if (objectCount >= Math.max(1, Number(maxObjects || 0))) break;
    }
    pages += 1;
    hasNext = !!conn?.pageInfo?.hasNextPage;
    after = conn?.pageInfo?.endCursor || null;
    if (!nodes.length) break;
  }
  const complete = !hasNext;
  return {
    value: complete ? String(total) : null,
    partialValue: String(total),
    objectCount,
    pages,
    complete,
    hasNext,
  };
}

async function getCoinMeta(coinType) {
  if (!coinType) return null;
  if (coinMetaCache[coinType]) return coinMetaCache[coinType];
  try {
    const data = await gql(`query($ct: String!) { coinMetadata(coinType: $ct) { decimals symbol name iconUrl supply } }`, { ct: coinType });
    if (data?.coinMetadata) {
      coinMetaCache[coinType] = data.coinMetadata;
      return data.coinMetadata;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function getCoinMetaMap(coinTypes) {
  const unique = [...new Set((coinTypes || []).filter(Boolean))];
  const out = {};
  const missing = [];
  for (const coinType of unique) {
    if (coinMetaCache[coinType]) out[coinType] = coinMetaCache[coinType];
    else missing.push(coinType);
  }
  if (!missing.length) return out;

  const chunks = chunkArray(missing, 5);
  await Promise.all(chunks.map(async (chunk) => {
    const aliases = chunk.map((coinType, i) => `c${i}: coinMetadata(coinType: "${coinType}") { decimals symbol name iconUrl supply }`);
    try {
      const data = await gql(`{ ${aliases.join("\n")} }`);
      chunk.forEach((coinType, i) => {
        const meta = data?.[`c${i}`] || null;
        if (meta) coinMetaCache[coinType] = meta;
        out[coinType] = meta;
      });
    } catch (_) {
      await Promise.all(chunk.map(async (coinType) => {
        out[coinType] = await getCoinMeta(coinType);
      }));
    }
  }));

  for (const coinType of unique) {
    if (!(coinType in out)) out[coinType] = coinMetaCache[coinType] || null;
  }
  return out;
}

async function fetchCoinTotalSupplyRpc(coinType, shortCoinType = "") {
  const candidates = [...new Set([coinType, shortCoinType].filter(Boolean))];
  if (!candidates.length) {
    return {
      value: null,
      source: "",
      note: "No coin type provided.",
      estimated: false,
      canonicalKnown: false,
      canonicalUnavailableReason: "No coin type provided.",
    };
  }
  const cacheKey = candidates.map(coinTypeKey).filter(Boolean)[0] || coinTypeKey(candidates[0]);
  if (cacheKey && coinTotalSupplyRpcCache[cacheKey]) return coinTotalSupplyRpcCache[cacheKey];
  const run = (async () => {
    let lastErr = "";
    for (const ct of candidates) {
      try {
        const result = await suiRpcCall("suix_getTotalSupply", [ct]);
        if (result?.value != null) {
          return {
            value: String(result.value),
            source: "suix_getTotalSupply",
            note: "",
            estimated: false,
            canonicalKnown: true,
            canonicalUnavailableReason: "",
          };
        }
      } catch (e) {
        lastErr = e?.message || String(e);
      }
    }
    let canonicalUnavailableReason = "";
    let registryNote = "";
    try {
      const md = await suiRpcCall("suix_getCoinMetadata", [candidates[0]]);
      const mdId = normalizeSuiAddress(md?.id || "");
      if (mdId) {
        const mdObj = await suiRpcCall("sui_getObject", [mdId, { showContent: true }]).catch(() => null);
        const variant = String(mdObj?.data?.content?.fields?.supply?.variant || "");
        if (variant) {
          if (variant.toLowerCase() === "unknown") {
            canonicalUnavailableReason = "Unknown Supply: canonical total supply is not tracked for this coin type (TreasuryCap may be managed externally).";
            registryNote = "Coin registry marks supply state as Unknown.";
          }
          else registryNote = `Coin registry supply state is ${variant}.`;
        }
      }
    } catch (_) { /* ignore */ }

    try {
      const objectSupply = await fetchCoinObjectSupplySnapshot(candidates[0], { maxObjects: 1200, maxPages: 32 });
      if (objectSupply?.value != null) {
        const countLabel = fmtNumber(objectSupply.objectCount || 0);
        const noteParts = [
          `Derived from ${countLabel} live Coin objects.`,
          "May exclude balances wrapped as Balance<T> in shared objects.",
        ];
        return {
          value: String(objectSupply.value),
          source: "coinObjects.sum",
          note: noteParts.join(" "),
          estimated: true,
          canonicalKnown: false,
          canonicalUnavailableReason: canonicalUnavailableReason || "Canonical supply unavailable from coin registry/RPC sources.",
        };
      }
      if (!registryNote && objectSupply?.hasNext) {
        registryNote = `Coin-object scan hit cap at ${fmtNumber(objectSupply.objectCount || 0)} objects before completion.`;
      }
    } catch (_) { /* ignore */ }

    const reason = formatSupplyUnavailableReason(lastErr);
    const mergedNote = [registryNote, reason].filter(Boolean).join(" ");
    return {
      value: null,
      source: "suix_getTotalSupply",
      note: mergedNote || reason,
      estimated: false,
      canonicalKnown: false,
      canonicalUnavailableReason: canonicalUnavailableReason || mergedNote || reason,
    };
  })();
  if (cacheKey) coinTotalSupplyRpcCache[cacheKey] = run;
  return run;
}

// Batch-fetch metadata for multiple coin types at once (via aliases)
async function prefetchCoinMeta(coinTypes) {
  const toFetch = [...new Set(coinTypes.filter(ct => ct && !coinMetaCache[ct] && !KNOWN_COIN_TYPES[ct] && !KNOWN_COIN_TYPES[normalizeCoinType(ct)]))];
  if (!toFetch.length) return;
  // Run chunks in parallel (5 aliases each to stay within GQL backing-store limits)
  const chunks = chunkArray(toFetch, 5);
  await Promise.all(chunks.map(async (chunk) => {
    const aliases = chunk.map((ct, i) => `c${i}: coinMetadata(coinType: "${ct}") { decimals symbol name iconUrl supply }`);
    try {
      const data = await gql(`{ ${aliases.join("\n")} }`);
      chunk.forEach((ct, i) => { if (data?.[`c${i}`]) coinMetaCache[ct] = data[`c${i}`]; });
    } catch (e) {
      // Batch failed — try individual lookups in parallel
      await Promise.all(chunk.map(async (ct) => {
        try { await getCoinMeta(ct); } catch (_) { /* ignore */ }
      }));
    }
  }));
}

function fmtCoinWithMeta(amount, coinRepr) {
  const amt = Number(amount);
  const meta = coinRepr ? coinMetaCache[coinRepr] : null;
  const known = coinRepr ? KNOWN_COIN_TYPES[coinRepr] : null;
  const decimals = meta ? meta.decimals : (known ? known.decimals : (COMMON_DECIMALS[coinRepr?.split("::").pop()] || 9));
  const symbol = meta ? meta.symbol : (known ? known.symbol : coinName(coinRepr));
  const val = amt / Math.pow(10, decimals);
  const abs = Math.abs(val);
  const formatted = abs < 0.001 && abs > 0 ? abs.toExponential(2) : abs.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return { val, abs: formatted, name: symbol, sign: amt >= 0 ? "+" : "-", raw: amt };
}

function copyLinkBtn() {
  return `<button class="copy-btn" data-action="copy-link" title="Copy link" aria-label="Copy page link to clipboard">&#x1F517;</button>`;
}

// Short type display: "0xpkg::mod::Type<...>" → "mod::Type"
function shortType(repr) {
  if (!repr) return "";
  const m = repr.match(/0x[0-9a-f]+::(\w+::\w+)/);
  return m ? m[1] : repr;
}

// ── JSON Tree Renderer ──────────────────────────────────────────────────
// Recursive renderer: collapsible objects/arrays, color-coded types, address auto-linking
const SUI_ADDR_RE = /^0x[0-9a-f]{64}$/i;
const SUI_TYPE_RE = /^0x[0-9a-f]+::\w+::\w+/;

function renderJson(value, {depth = 0, collapsed = false, maxDepth = 2} = {}) {
  if (value === null || value === undefined) return '<span class="jtree-null">null</span>';
  if (typeof value === "boolean") return `<span class="jtree-b">${value}</span>`;
  if (typeof value === "number") return `<span class="jtree-n">${value}</span>`;
  if (typeof value === "string") {
    // Sui address → clickable link
    if (SUI_ADDR_RE.test(value)) {
      return `<a class="jtree-addr" href="#/object/${value}">"${value}"</a>`;
    }
    // Move type with address → link the package
    if (SUI_TYPE_RE.test(value)) {
      const pkg = value.match(/^(0x[0-9a-f]+)/i)?.[1];
      const escaped = value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (pkg) return `"<a class="jtree-addr" href="#/object/${pkg}" title="${escaped}">${escaped}</a>"`;
    }
    const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Large string → truncate
    if (escaped.length > 200) return `<span class="jtree-s">"${escaped.slice(0, 200)}…"</span>`;
    return `<span class="jtree-s">"${escaped}"</span>`;
  }

  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const count = entries.length;
  const open = isArr ? "[" : "{";
  const close = isArr ? "]" : "}";

  if (count === 0) return `<span>${open}${close}</span>`;

  // Auto-collapse deeper nesting or large objects
  const startCollapsed = collapsed || depth >= maxDepth || count > 20;
  const id = "jt_" + Math.random().toString(36).slice(2, 9);
  const summary = isArr ? `${count} item${count !== 1 ? "s" : ""}` : `${count} key${count !== 1 ? "s" : ""}`;

  let html = `<span class="jtree-toggle${startCollapsed ? "" : " open"}" data-action="jtree-toggle" data-target-id="${id}" role="button" tabindex="0">${open}</span>`;
  html += `<span class="jtree-summary${startCollapsed ? "" : " jtree-hidden"}">${summary}${close}</span>`;
  html += `<div id="${id}" class="jtree-indent${startCollapsed ? " jtree-hidden" : ""}">`;

  for (const [key, val] of entries) {
    const keyHtml = isArr ? "" : `<span class="jtree-k">"${key}"</span>: `;
    html += `<div>${keyHtml}${renderJson(val, {depth: depth + 1, maxDepth})}</div>`;
  }

  html += `</div><span class="${startCollapsed ? "jtree-hidden" : ""}" data-close="${id}">${close}</span>`;
  return html;
}

// Wrap renderJson output in a container with copy button
function jsonTreeBlock(value, maxHeight) {
  const raw = JSON.stringify(value, null, 2);
  const style = maxHeight ? `max-height:${maxHeight}px;overflow:auto` : "";
  return `<div class="jtree-wrap" style="${style}">
    <button class="jtree-copy" data-action="copy-text-flash" data-copy-text="${escapeAttr(raw)}">Copy</button>
    <div class="jtree">${renderJson(value)}</div>
  </div>`;
}

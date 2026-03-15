// ── Router ──────────────────────────────────────────────────────────────
function navigate(path) {
  window.location.hash = path;
}

function getRoute() {
  const hash = window.location.hash.slice(1) || "/";
  return hash;
}

function splitRouteAndParams(route = getRoute()) {
  const raw = String(route || "/");
  const qIdx = raw.indexOf("?");
  if (qIdx === -1) return { path: raw || "/", params: new URLSearchParams() };
  return {
    path: raw.slice(0, qIdx) || "/",
    params: new URLSearchParams(raw.slice(qIdx + 1)),
  };
}

function setRouteParams(updates = {}, opts = {}) {
  const { path, params } = splitRouteAndParams(getRoute());
  const clearKeys = Array.isArray(opts.clearKeys) ? opts.clearKeys : [];
  for (const key of clearKeys) params.delete(key);
  for (const [key, value] of Object.entries(updates || {})) {
    if (value == null || value === "" || value === false) params.delete(key);
    else params.set(key, String(value));
  }
  const qs = params.toString();
  const nextHash = `#${path}${qs ? "?" + qs : ""}`;
  if (window.location.hash !== nextHash) history.replaceState(null, "", nextHash);
}

function routeCacheKey(route) {
  const split = splitRouteAndParams(route || "/");
  const pairs = [];
  for (const [k, v] of split.params.entries()) pairs.push([k, v]);
  pairs.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  const qs = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${split.path || "/"}${qs ? "?" + qs : ""}`;
}

function getRouteViewCacheEntry(cacheKey) {
  const row = routeViewCache[cacheKey];
  if (!row) return null;
  if ((Date.now() - Number(row.ts || 0)) > ROUTE_VIEW_CACHE_TTL_MS) return null;
  return row;
}

function setRouteViewCacheEntry(cacheKey, html) {
  if (!cacheKey || !html) return;
  routeViewCache[cacheKey] = { html: String(html), ts: Date.now() };
  prunePlainObjectCache(routeViewCache, 120);
}

function parseRoute(route) {
  const routeParts = splitRouteAndParams(route);
  const cleanRoute = routeParts.path;
  const routeParams = routeParts.params;
  if (cleanRoute === "/" || cleanRoute === "") return { page: "home" };
  const parts = cleanRoute.split("/").filter(Boolean);
  if (parts[0] === "checkpoint" && parts[1]) return { page: "checkpoint", id: parts[1] };
  if (parts[0] === "checkpoints") return { page: "checkpoints" };
  if (parts[0] === "tx" && parts[1]) return { page: "tx", digest: parts[1] };
  if (parts[0] === "txs") return { page: "txs" };
  if (parts[0] === "address" && parts[1]) return { page: "address", addr: decodeURIComponent(parts[1]) };
  if (parts[0] === "object" && parts[1]) {
    const rawId = decodeURIComponent(parts[1]);
    const coinType = normalizeCoinTypeQueryInput(rawId);
    if (coinType) return { page: "coin", coinType };
    return { page: "object", id: rawId };
  }
  if (parts[0] === "coin") return { page: "coin", coinType: routeParams.get("type") || "" };
  if (parts[0] === "graphql") return { page: "graphql" };
  if (parts[0] === "epoch" && parts[1]) return { page: "epoch", id: parts[1] };
  if (parts[0] === "transfers") return { page: "transfers" };
  if (parts[0] === "congestion") return { page: "congestion" };
  if (parts[0] === "validators") return { page: "validators" };
  if (parts[0] === "events") return { page: "events" };
  if (parts[0] === "defi-overview") return { page: "defi-overview" };
  if (parts[0] === "defi-rates") return { page: "defi-rates" };
  if (parts[0] === "defi-dex") return { page: "defi-dex" };
  if (parts[0] === "defi-stablecoins") return { page: "defi-stablecoins" };
  if (parts[0] === "defi-lst") return { page: "defi-lst" };
  if (parts[0] === "defi-flows") return { page: "defi-flows" };
  if (parts[0] === "defi-perps") return { page: "defi-perps" };
  if (parts[0] === "protocol") return { page: "protocol" };
  if (parts[0] === "packages") return { page: "packages" };
  if (parts[0] === "simulate") return { page: "simulate" };
  if (parts[0] === "docs") return { page: "docs" };
  return { page: "home" };
}

const CORE_ROUTE_PAGES = new Set(["home", "checkpoints", "checkpoint", "txs", "tx", "address", "object", "coin"]);
let extraRoutesLoadPromise = null;
const EXTRA_ROUTES_MAX_SCRIPT_ATTEMPTS = 3;
const EXTRA_ROUTES_RETRY_DELAY_MS = 250;

function areExtraRoutesLoaded() {
  return globalThis.__SUIGRAPH_EXTRA_LOADED__ === true;
}

function getExtraRoutesSrc() {
  return document.querySelector('meta[name="suigraph-extra-src"]')?.getAttribute("content") || "./assets/app-extra.js";
}

function resolveExtraRoutesSrc(src = getExtraRoutesSrc()) {
  try {
    return new URL(String(src || "./assets/app-extra.js"), window.location.href).toString();
  } catch (_) {
    return String(src || "./assets/app-extra.js");
  }
}

function withExtraRoutesRetryQuery(src, attempt) {
  if (!attempt) return src;
  try {
    const url = new URL(src, window.location.href);
    url.searchParams.set("load_retry", String(attempt));
    return url.toString();
  } catch (_) {
    const joiner = String(src).includes("?") ? "&" : "?";
    return `${src}${joiner}load_retry=${encodeURIComponent(String(attempt))}`;
  }
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendInlineScript(text) {
  const script = document.createElement("script");
  script.text = `${String(text || "")}\n//# sourceURL=suigraph-extra-fallback.js`;
  document.head.appendChild(script);
}

function loadExtraRoutesScriptTag(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.remove();
      resolve();
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("Failed to load explorer extra bundle."));
    };
    document.head.appendChild(script);
  });
}

async function loadExtraRoutesFallback(src) {
  const res = await fetch(src, { cache: "reload" });
  if (!res.ok) throw new Error(`Failed to fetch explorer extra bundle (${res.status})`);
  const text = await res.text();
  appendInlineScript(text);
}

function ensureExtraRoutesLoaded() {
  if (areExtraRoutesLoaded()) return Promise.resolve();
  if (extraRoutesLoadPromise) return extraRoutesLoadPromise;
  extraRoutesLoadPromise = (async () => {
    const src = resolveExtraRoutesSrc();
    let lastErr = null;
    for (let attempt = 0; attempt < EXTRA_ROUTES_MAX_SCRIPT_ATTEMPTS; attempt += 1) {
      try {
        await loadExtraRoutesScriptTag(withExtraRoutesRetryQuery(src, attempt));
        globalThis.__SUIGRAPH_EXTRA_LOADED__ = true;
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < (EXTRA_ROUTES_MAX_SCRIPT_ATTEMPTS - 1)) await delayMs(EXTRA_ROUTES_RETRY_DELAY_MS);
      }
    }
    try {
      await loadExtraRoutesFallback(src);
      globalThis.__SUIGRAPH_EXTRA_LOADED__ = true;
      return;
    } catch (fallbackErr) {
      lastErr = fallbackErr;
    }
    extraRoutesLoadPromise = null;
    throw lastErr || new Error("Failed to load explorer extra bundle.");
  })();
  return extraRoutesLoadPromise;
}

async function routeTo(route) {
  const r = parseRoute(route);
  if (routeRequestController) routeRequestController.abort();
  routeRequestController = new AbortController();
  clearVisibleRouteShellPrefetch();
  clearVisibleObjectShellPrefetch();
  const localRouteToken = ++routeRenderToken;
  startPagePerf(r.page);
  // Update active nav — handle flat links and dropdown items
  const networkPages = ["transfers","congestion","events","protocol","validators","coin"];
  const defiPages = ["defi-overview","defi-rates","defi-dex","defi-stablecoins","defi-lst","defi-perps"];
  const devtoolsPages = ["graphql","simulate"];
  document.querySelectorAll(".topbar nav > a").forEach(a => {
    a.classList.toggle("active", a.dataset.page === r.page);
  });
  document.querySelectorAll(".dropdown-menu a").forEach(a => {
    a.classList.toggle("active", a.dataset.page === r.page);
  });
  document.querySelectorAll(".nav-dropdown").forEach(dd => {
    const group = dd.dataset.group;
    const isActive = (group === "network" && networkPages.includes(r.page))
                  || (group === "defi" && defiPages.includes(r.page))
                  || (group === "devtools" && devtoolsPages.includes(r.page));
    dd.querySelector(".nav-trigger").classList.toggle("active", isActive);
  });

  // Clear dashboard auto-refresh when navigating away
  if (dashboardTimer && r.page !== "home") { clearInterval(dashboardTimer); dashboardTimer = null; }

  const app = document.getElementById("app");
  const cacheKey = routeCacheKey(route);
  const cacheEntry = getRouteViewCacheEntry(cacheKey);
  if (cacheEntry?.html) {
    notePerfCache(true);
    app.innerHTML = cacheEntry.html;
  } else {
    notePerfCache(false);
    app.innerHTML = renderLoading();
  }

  try {
    if (!CORE_ROUTE_PAGES.has(r.page)) await ensureExtraRoutesLoaded();
    switch (r.page) {
      case "home": await renderDashboard(app); break;
      case "checkpoints": await renderCheckpoints(app); break;
      case "checkpoint": await renderCheckpointDetail(app, r.id); break;
      case "txs": await renderTransactions(app); break;
      case "tx": await renderTxDetail(app, r.digest); break;
      case "address": await renderAddress(app, r.addr); break;
      case "object": await renderObjectDetail(app, r.id); break;
      case "coin": await renderCoin(app, r.coinType); break;
      case "graphql": await renderGraphQLPlayground(app); break;
      case "epoch": await renderEpochDetail(app, r.id); break;
      case "transfers": await renderTransfers(app); break;
      case "congestion": await renderCongestion(app); break;
      case "validators": await renderValidators(app); break;
      case "events": await renderEvents(app); break;
      case "defi-overview": await renderDefiOverview(app); break;
      case "defi-rates": await renderDefiRates(app); break;
      case "defi-dex": await renderDefiDex(app); break;
      case "defi-stablecoins": await renderDefiStablecoins(app); break;
      case "defi-lst": await renderDefiLst(app); break;
      case "defi-flows": await renderDefiFlows(app); break;
      case "defi-perps": await renderDefiPerps(app); break;
      case "protocol": await renderProtocolConfig(app); break;
      case "packages": await renderPackages(app); break;
      case "simulate": await renderSimulator(app); break;
      case "docs": await renderDocs(app); break;
      default: app.innerHTML = renderEmpty("Page not found.");
    }
    if (localRouteToken !== routeRenderToken) return;
    setRouteViewCacheEntry(cacheKey, app.innerHTML);
    finishPagePerf("ok");
  } catch (e) {
    if (localRouteToken !== routeRenderToken) return;
    if (isAbortError(e)) return;
    console.error(e);
    app.innerHTML = renderEmpty("Error loading page: " + escapeHtml(e.message));
    finishPagePerf("error");
  }
  if (localRouteToken !== routeRenderToken) return;
  scheduleUiEnhancements();
  scheduleVisibleRouteShellPrefetch(app);
  scheduleVisibleObjectShellPrefetch(app);
}

window.addEventListener("hashchange", () => routeTo(getRoute()));

const ROUTE_SHELL_PREFETCH_LIMIT = 6;
const ROUTE_SHELL_PREFETCH_CRITICAL_DELAY_MS = 40;
const OBJECT_SHELL_PREFETCH_LIMIT = 1;
const OBJECT_SHELL_PREFETCH_DELAY_MS = 25;
let routeShellPrefetchCriticalHandle = 0;
let routeShellPrefetchIdleHandle = 0;
let routeShellPrefetchIdleUsesIdle = false;
let objectShellPrefetchHandle = 0;

function clearVisibleRouteShellPrefetch() {
  if (routeShellPrefetchCriticalHandle) {
    clearTimeout(routeShellPrefetchCriticalHandle);
    routeShellPrefetchCriticalHandle = 0;
  }
  if (!routeShellPrefetchIdleHandle) return;
  if (routeShellPrefetchIdleUsesIdle && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(routeShellPrefetchIdleHandle);
  } else {
    clearTimeout(routeShellPrefetchIdleHandle);
  }
  routeShellPrefetchIdleHandle = 0;
  routeShellPrefetchIdleUsesIdle = false;
}

function clearVisibleObjectShellPrefetch() {
  if (!objectShellPrefetchHandle) return;
  clearTimeout(objectShellPrefetchHandle);
  objectShellPrefetchHandle = 0;
}

function isVisiblePrefetchAnchor(anchor) {
  if (!(anchor instanceof Element)) return false;
  const rect = anchor.getBoundingClientRect();
  return rect.width > 0
    && rect.height > 0
    && rect.bottom >= 0;
}

function prefetchRouteShellFromRoute(route) {
  const parsed = parseRoute(route);
  if (parsed.page === "tx" && parsed.digest) {
    return fetchTxShell(parsed.digest, false);
  }
  if (parsed.page === "checkpoint" && parsed.id) {
    return fetchCheckpointDetailShell(parsed.id, false);
  }
  if (parsed.page === "epoch" && parsed.id) {
    if (!areExtraRoutesLoaded()) return Promise.resolve(null);
    return fetchEpochDetailShell(parsed.id, false);
  }
  if (parsed.page === "address" && parsed.addr) {
    if (!areExtraRoutesLoaded()) return Promise.resolve(null);
    const addrNorm = normalizeSuiAddress(decodeURIComponent(String(parsed.addr || "")));
    if (addrNorm) return fetchAddressShell(addrNorm, false);
  }
  return Promise.resolve(null);
}

function prefetchObjectShellFromRoute(route) {
  const parsed = parseRoute(route);
  if (parsed.page !== "object" || !parsed.id) return Promise.resolve(null);
  const idNorm = normalizeSuiAddress(decodeURIComponent(String(parsed.id || "")));
  if (!idNorm) return Promise.resolve(null);
  return fetchObjectShell(idNorm, false);
}

function routeShellPrefetchKey(parsed) {
  if (!parsed?.page) return "";
  if (parsed.page === "tx") return parsed.digest ? `tx:${parsed.digest}` : "";
  if (parsed.page === "checkpoint") return parsed.id ? `checkpoint:${parsed.id}` : "";
  if (parsed.page === "epoch") return parsed.id ? `epoch:${parsed.id}` : "";
  if (parsed.page === "address") {
    const addrNorm = normalizeSuiAddress(decodeURIComponent(String(parsed.addr || "")));
    return addrNorm ? `address:${addrNorm}` : "";
  }
  return "";
}

function collectVisibleRouteShellPrefetchCandidates(target) {
  const candidates = [];
  const seen = new Set();
  for (const anchor of target.querySelectorAll('a[href^="#/"]')) {
    if (!isVisiblePrefetchAnchor(anchor)) continue;
    const href = anchor.getAttribute("href") || "";
    if (!href.startsWith("#/")) continue;
    const route = href.slice(1);
    const parsed = parseRoute(route);
    if (!["tx", "checkpoint", "epoch", "address"].includes(parsed.page)) continue;
    const key = routeShellPrefetchKey(parsed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push({ route, parsed, key });
  }
  return candidates;
}

function selectCriticalRouteShellPrefetchCandidates(candidates, currentPage) {
  const priority = currentPage === "home"
    ? ["tx", "checkpoint", "epoch", "address"]
    : (currentPage === "checkpoints"
      ? ["checkpoint", "tx", "epoch", "address"]
      : (["txs", "transfers", "defi-overview", "defi-dex", "defi-flows", "packages", "address"].includes(currentPage)
        ? ["tx", "address", "checkpoint", "epoch"]
        : ["tx", "checkpoint", "address", "epoch"]));
  const selected = [];
  const used = new Set();
  for (const page of priority) {
    const candidate = candidates.find((row) => row.parsed.page === page && !used.has(row.key));
    if (!candidate) continue;
    selected.push(candidate);
    used.add(candidate.key);
    if (selected.length >= 3) break;
  }
  return selected;
}

function scheduleVisibleRouteShellPrefetch(root = null) {
  const target = root || document.getElementById("app");
  if (!target) return;
  if (document.visibilityState === "hidden") return;
  if (navigator.connection?.saveData) return;
  const currentPage = parseRoute(getRoute()).page;
  // Overview already does enough work on first load; keep tx shell warming intent-driven here.
  if (currentPage === "defi-overview") return;
  clearVisibleRouteShellPrefetch();
  const candidates = collectVisibleRouteShellPrefetchCandidates(target);
  if (!candidates.length) return;
  const critical = selectCriticalRouteShellPrefetchCandidates(candidates, currentPage);
  const criticalKeys = new Set(critical.map((row) => row.key));
  const secondary = candidates
    .filter((row) => !criticalKeys.has(row.key))
    .slice(0, Math.max(0, ROUTE_SHELL_PREFETCH_LIMIT - critical.length));
  const runCritical = () => {
    routeShellPrefetchCriticalHandle = 0;
    if (!critical.length) return;
    Promise.allSettled(critical.map((row) => prefetchRouteShellFromRoute(row.route).catch(() => null))).catch(() => null);
  };
  const runSecondary = () => {
    routeShellPrefetchIdleHandle = 0;
    routeShellPrefetchIdleUsesIdle = false;
    if (!secondary.length) return;
    Promise.allSettled(secondary.map((row) => prefetchRouteShellFromRoute(row.route).catch(() => null))).catch(() => null);
  };
  routeShellPrefetchCriticalHandle = window.setTimeout(runCritical, ROUTE_SHELL_PREFETCH_CRITICAL_DELAY_MS);
  if (!secondary.length) return;
  if (typeof requestIdleCallback === "function") {
    routeShellPrefetchIdleUsesIdle = true;
    routeShellPrefetchIdleHandle = requestIdleCallback(runSecondary, { timeout: 800 });
  } else {
    routeShellPrefetchIdleHandle = window.setTimeout(runSecondary, 180);
  }
}

function collectVisibleObjectShellPrefetchCandidates(target) {
  const candidates = [];
  const seen = new Set();
  for (const anchor of target.querySelectorAll('a[href^="#/object/"]')) {
    if (!isVisiblePrefetchAnchor(anchor)) continue;
    const href = anchor.getAttribute("href") || "";
    if (!href.startsWith("#/object/")) continue;
    const parsed = parseRoute(href.slice(1));
    const idNorm = normalizeSuiAddress(decodeURIComponent(String(parsed?.id || "")));
    if (!idNorm || seen.has(idNorm)) continue;
    seen.add(idNorm);
    candidates.push({ route: href.slice(1), idNorm });
    if (candidates.length >= OBJECT_SHELL_PREFETCH_LIMIT) break;
  }
  return candidates;
}

function scheduleVisibleObjectShellPrefetch(root = null) {
  const target = root || document.getElementById("app");
  if (!target) return;
  if (document.visibilityState === "hidden") return;
  if (navigator.connection?.saveData) return;
  const currentPage = parseRoute(getRoute()).page;
  if (!["tx", "address", "object"].includes(currentPage)) return;
  clearVisibleObjectShellPrefetch();
  const candidates = collectVisibleObjectShellPrefetchCandidates(target);
  if (!candidates.length) return;
  objectShellPrefetchHandle = window.setTimeout(() => {
    objectShellPrefetchHandle = 0;
    Promise.allSettled(candidates.map((row) => prefetchObjectShellFromRoute(row.route).catch(() => null))).catch(() => null);
  }, OBJECT_SHELL_PREFETCH_DELAY_MS);
}

function handleRouteShellPrefetchHint(ev) {
  const anchor = ev.target?.closest?.('a[href^="#/"]');
  if (!anchor) return;
  const href = anchor.getAttribute("href") || "";
  if (!href.startsWith("#/")) return;
  prefetchRouteShellFromRoute(href.slice(1)).catch(() => null);
  if (href.startsWith("#/object/")) prefetchObjectShellFromRoute(href.slice(1)).catch(() => null);
}

document.addEventListener("mouseover", handleRouteShellPrefetchHint, { passive: true });
document.addEventListener("focusin", handleRouteShellPrefetchHint);
document.addEventListener("touchstart", handleRouteShellPrefetchHint, { passive: true });

// ── Search ──────────────────────────────────────────────────────────────
async function classifyHexSearchTarget(rawQuery, force = false) {
  const addrNorm = normalizeSuiAddress(rawQuery);
  if (!addrNorm) return { route: "/address/" + encodeURIComponent(String(rawQuery || "")) };
  const storageKey = persistedEntityCacheKey(PERSISTED_CACHE_KEYS.searchTargetPrefix, addrNorm);
  const cacheState = getKeyedCacheState(searchClassificationCache, addrNorm);
  hydratePersistedTimedCacheState(cacheState, storageKey, SEARCH_CLASSIFIER_TTL_MS);
  return withTimedCache(cacheState, SEARCH_CLASSIFIER_TTL_MS, force, async () => {
    const probe = await gql(`query($address: SuiAddress!) {
      object(address: $address) {
        asMovePackage { modules(first: 1) { nodes { name } } }
        ${GQL_F_MOVE_TYPE}
      }
    }`, { address: addrNorm });
    const route = (probe?.object?.asMovePackage || probe?.object?.asMoveObject)
      ? "/object/" + addrNorm
      : "/address/" + addrNorm;
    const result = { route };
    writePersistedTimedCacheRecord(storageKey, result, 4000);
    return result;
  });
}

// ── Search Preview ───────────────────────────────────────────────────
let searchPreviewRoute = "";
let searchPreviewAbort = null;

function hideSearchPreview() {
  const el = document.getElementById("searchPreview");
  if (el) { el.style.display = "none"; el.innerHTML = ""; }
  searchPreviewRoute = "";
  if (searchPreviewAbort) { searchPreviewAbort.abort(); searchPreviewAbort = null; }
}

function showSearchPreviewLoading(query) {
  const el = document.getElementById("searchPreview");
  if (!el) return;
  el.style.display = "block";
  el.innerHTML = `<div class="search-preview-loading">
    <div class="spinner"></div>
    Looking up <span style="font-family:var(--mono);color:var(--text)">${escapeHtml(truncHash(query, 10))}</span>...
  </div>`;
}

function renderSearchPreviewCard(type, title, metaParts, route) {
  const dot = '<span class="sp-dot">&middot;</span>';
  return `<div class="search-preview-type">${escapeHtml(type)}</div>
    <div class="search-preview-title">${escapeHtml(title)}</div>
    <div class="search-preview-meta">${metaParts.filter(Boolean).join(dot)}</div>
    <div class="search-preview-hint">Press Enter or click to view &rarr;</div>`;
}

async function fetchSearchPreviewData(route, query) {
  const el = document.getElementById("searchPreview");
  if (!el) return;

  if (route.startsWith("/tx/")) {
    const digest = route.slice(4);
    try {
      const data = await fetchTxShell(digest, false);
      const tx = data?.transaction;
      if (!tx) { el.innerHTML = renderSearchPreviewCard("Transaction", digest, ["Not found"], route); return; }
      const status = tx.effects?.status === "SUCCESS" ? "Success" : "Failed";
      const statusColor = tx.effects?.status === "SUCCESS" ? "var(--green)" : "var(--red)";
      const gs = tx.effects?.gasEffects?.gasSummary;
      const gas = gs ? fmtSui(Number(gs.computationCost) + Number(gs.storageCost) - Number(gs.storageRebate)) : "";
      const cmds = tx.kind?.commands?.nodes || [];
      const cmdSummary = cmds.length ? cmds.map(c => {
        if (c.__typename === "MoveCallCommand") {
          const fn = c.function;
          return fn ? `${fn.module?.name || "?"}::${fn.name}` : "MoveCall";
        }
        return c.__typename?.replace("Command", "") || "?";
      }).slice(0, 3).join(", ") : "system";
      const sender = tx.sender?.address ? truncHash(tx.sender.address) : "";
      const time = tx.effects?.timestamp ? timeAgo(tx.effects.timestamp) : "";
      el.innerHTML = renderSearchPreviewCard("Transaction", truncHash(digest, 16), [
        `<span style="color:${statusColor}">${status}</span>`,
        cmdSummary,
        sender ? `from ${sender}` : "",
        gas,
        time,
      ], route);
    } catch { el.innerHTML = renderSearchPreviewCard("Transaction", digest, ["Preview unavailable"], route); }

  } else if (route.startsWith("/address/")) {
    const addr = decodeURIComponent(route.slice(9));
    try {
      const data = await fetchAddressShell(addr, false);
      const a = data?.address;
      if (!a) { el.innerHTML = renderSearchPreviewCard("Address", truncHash(addr, 16), ["Not found or empty"], route); return; }
      const name = a.defaultNameRecord?.domain;
      const objects = a.objects?.nodes || [];
      const objCount = objects.length + (a.objects?.pageInfo?.hasNextPage ? "+" : "");
      // Extract SUI balance from objects
      const suiObjs = objects.filter(o => (o.contents?.type?.repr || "").includes("::sui::SUI") && (o.contents?.type?.repr || "").includes("Coin<"));
      let suiBal = 0;
      for (const o of suiObjs) {
        const bal = Number(o.contents?.json?.balance || 0);
        suiBal += bal;
      }
      const coinTypes = new Set();
      for (const o of objects) {
        const t = o.contents?.type?.repr || "";
        if (t.includes("Coin<")) coinTypes.add(t);
      }
      el.innerHTML = renderSearchPreviewCard("Address", name ? `${name} (${truncHash(addr, 8)})` : truncHash(addr, 16), [
        suiBal > 0 ? fmtSui(suiBal) : "",
        coinTypes.size > 0 ? `${coinTypes.size} coin type${coinTypes.size > 1 ? "s" : ""}` : "",
        `${objCount} object${objects.length !== 1 ? "s" : ""}`,
      ], route);
    } catch { el.innerHTML = renderSearchPreviewCard("Address", truncHash(addr, 16), ["Preview unavailable"], route); }

  } else if (route.startsWith("/object/")) {
    const id = route.slice(8);
    try {
      const data = await fetchObjectShell(id, false);
      const obj = data?.object;
      if (!obj) { el.innerHTML = renderSearchPreviewCard("Object", truncHash(id, 16), ["Not found"], route); return; }
      const isPkg = !!obj.asMovePackage;
      const typeRepr = obj.asMoveObject?.contents?.type?.repr || "";
      const label = isPkg ? "Package" : "Object";
      const modules = obj.asMovePackage?.modules;
      const modCount = modules?.nodes?.length || 0;
      const hasMore = modules?.pageInfo?.hasNextPage;
      el.innerHTML = renderSearchPreviewCard(label, truncHash(id, 16), [
        isPkg ? `${modCount}${hasMore ? "+" : ""} module${modCount !== 1 ? "s" : ""}` : shortType(typeRepr),
        `v${obj.version || "?"}`,
      ], route);
    } catch { el.innerHTML = renderSearchPreviewCard("Object", truncHash(id, 16), ["Preview unavailable"], route); }

  } else if (route.startsWith("/checkpoint/")) {
    const seq = route.slice(12);
    try {
      const data = await fetchCheckpointDetailShell(seq, false);
      const cp = data?.checkpoint;
      if (!cp) { el.innerHTML = renderSearchPreviewCard("Checkpoint", seq, ["Not found"], route); return; }
      const txCount = cp.transactions?.nodes?.length || 0;
      const hasMore = cp.transactions?.pageInfo?.hasNextPage;
      const time = cp.timestamp ? timeAgo(cp.timestamp) : "";
      el.innerHTML = renderSearchPreviewCard("Checkpoint", fmtNumber(cp.sequenceNumber), [
        `Epoch ${cp.epoch?.epochId || "?"}`,
        `${txCount}${hasMore ? "+" : ""} transaction${txCount !== 1 ? "s" : ""}`,
        time,
      ], route);
    } catch { el.innerHTML = renderSearchPreviewCard("Checkpoint", seq, ["Preview unavailable"], route); }

  } else if (route.startsWith("/coin")) {
    const coinType = new URLSearchParams(route.split("?")[1] || "").get("type") || "";
    el.innerHTML = renderSearchPreviewCard("Coin Type", shortType(coinType) || coinType, [
      "View supply, holders, and activity",
    ], route);
  }
}

function navigateFromSearchPreview() {
  if (searchPreviewRoute) {
    const route = searchPreviewRoute;
    hideSearchPreview();
    navigate(route);
  }
}

document.getElementById("searchPreview").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  navigateFromSearchPreview();
});

// Close preview on outside click or Escape
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) hideSearchPreview();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideSearchPreview();
});

document.getElementById("searchForm").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const input = document.getElementById("searchInput");
  const q = input.value.trim();
  if (!q) return;

  // If preview is already showing for this query, navigate directly
  if (searchPreviewRoute) {
    navigateFromSearchPreview();
    input.blur();
    return;
  }

  input.blur();
  if (searchPreviewAbort) searchPreviewAbort.abort();
  searchPreviewAbort = new AbortController();

  // Detect type by format and resolve route
  let route = "";
  const coinTypeQuery = normalizeCoinTypeQueryInput(q);
  if (coinTypeQuery) {
    route = "/coin?type=" + encodeURIComponent(coinTypeQuery);
  } else if (q.startsWith("0x") && q.includes("::")) {
    route = "/coin?type=" + encodeURIComponent(q);
  } else if (/^\d+$/.test(q)) {
    route = "/checkpoint/" + q;
  } else if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
    showSearchPreviewLoading(q);
    try {
      const target = await classifyHexSearchTarget(q, false);
      route = target?.route || ("/address/" + q);
    } catch {
      route = "/address/" + q;
    }
  } else if (q.length >= 32 && q.length <= 50 && /^[A-Za-z0-9+/=]+$/.test(q)) {
    route = "/tx/" + q;
  } else if (q.startsWith("0x")) {
    route = "/object/" + q;
  } else if (/\.sui$/i.test(q)) {
    showSearchPreviewLoading(q);
    try {
      const data = await gql(`query($name: String!) { nameRecord(name: $name) { target { address } } }`, { name: q });
      if (data?.nameRecord?.target?.address) {
        route = "/address/" + data.nameRecord.target.address;
      } else {
        const el = document.getElementById("searchPreview");
        if (el) {
          el.style.display = "block";
          el.innerHTML = renderSearchPreviewCard("SuiNS", q, ["Name not found"], "");
        }
        return;
      }
    } catch (err) {
      const el = document.getElementById("searchPreview");
      if (el) {
        el.style.display = "block";
        el.innerHTML = renderSearchPreviewCard("SuiNS", q, ["Lookup failed: " + escapeHtml(err.message)], "");
      }
      return;
    }
  } else {
    route = "/tx/" + q;
  }

  if (!route) return;
  searchPreviewRoute = route;

  // Show loading state, then fetch preview data
  showSearchPreviewLoading(q);
  await fetchSearchPreviewData(route, q);
});

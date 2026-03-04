#!/usr/bin/env node

const GQL = "https://graphql.mainnet.sui.io/graphql";
const RPC = "https://fullnode.mainnet.sui.io:443";

const DEFAULT_COIN_TYPES = [
  "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI",
  "0x9f854b3ad20f8161ec0886f15f4a1752bf75d22261556f14cc8d3a1c5d50e529::magma::MAGMA",
];

const MOVE_TYPE_TOKEN_RE = /0x[0-9a-fA-F]+::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*/g;
const COIN_TYPE_PREFIX_RE = /^(0x[0-9a-fA-F]+)::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)(.*)$/;

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

function parseArgs(argv) {
  const opts = {
    coinTypes: [],
    maxObjectPages: 10,
    maxDigests: 320,
    txLimit: 80,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a === "--coin" || a === "-c") {
      const next = argv[i + 1];
      if (next) {
        opts.coinTypes.push(next);
        i += 1;
      }
    } else if (a === "--max-object-pages") {
      opts.maxObjectPages = Math.max(1, Number(argv[i + 1] || opts.maxObjectPages));
      i += 1;
    } else if (a === "--max-digests") {
      opts.maxDigests = Math.max(1, Number(argv[i + 1] || opts.maxDigests));
      i += 1;
    } else if (a === "--tx-limit") {
      opts.txLimit = Math.max(1, Number(argv[i + 1] || opts.txLimit));
      i += 1;
    } else if (a.startsWith("0x") && a.includes("::")) {
      opts.coinTypes.push(a);
    }
  }
  if (!opts.coinTypes.length) opts.coinTypes = DEFAULT_COIN_TYPES;
  return opts;
}

function printHelp() {
  console.log([
    "Usage: node scripts/smoke-coin-search.mjs [options]",
    "",
    "Options:",
    "  -c, --coin <coinType>       Coin type to inspect (repeatable)",
    "      --max-object-pages <n>  Object pages to scan (default: 10)",
    "      --max-digests <n>       Candidate digests to keep (default: 320)",
    "      --tx-limit <n>          Tx details to load (default: 80)",
    "  -h, --help                  Show help",
    "",
    `Default coins: ${DEFAULT_COIN_TYPES.join(", ")}`,
  ].join("\n"));
}

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
  return "0x" + hex;
}

function normalizeCoinTypeInput(raw) {
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

function coinTypeKey(coinType) {
  const norm = normalizeCoinTypeInput(coinType) || normalizeCoinType(coinType);
  return String(norm || "").toLowerCase();
}

function parseBigIntSafe(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return 0n;
    try { return BigInt(t); } catch (_) { return 0n; }
  }
  return 0n;
}

function parseTsMs(ts) {
  const n = Date.parse(String(ts || ""));
  return Number.isFinite(n) ? n : 0;
}

function shortHash(v, n = 8) {
  const s = String(v || "");
  if (s.length <= n * 2) return s;
  return `${s.slice(0, n)}...${s.slice(-n)}`;
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
    const normalized = normalizeCoinTypeInput(value);
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

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function gql(query, variables = {}) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await res.text();
  let json = {};
  try { json = raw ? JSON.parse(raw) : {}; } catch (_) { throw new Error("Invalid GraphQL JSON response"); }
  if (!res.ok) throw new Error(json?.errors?.[0]?.message || `GraphQL request failed (${res.status})`);
  if (json.errors && !json.data) throw new Error(json.errors[0]?.message || "GraphQL query failed");
  return json.data || {};
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${method}:${Date.now()}`, method, params }),
  });
  const raw = await res.text();
  const json = raw ? JSON.parse(raw) : {};
  if (!res.ok || json?.error) throw new Error(json?.error?.message || `RPC ${method} failed`);
  return json?.result;
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
  const matches = new Map();
  for (const ev of (events || [])) {
    const typeRepr = String(ev?.contents?.type?.repr || "");
    const repr = typeRepr.toLowerCase();
    if (!repr) continue;
    for (const tag of EVENT_ACTION_TAGS) {
      if (!tag.re.test(repr)) continue;
      const prev = matches.get(tag.key);
      if (prev) prev.count += 1;
      else matches.set(tag.key, { tag, count: 1, eventType: typeRepr });
    }
  }
  const best = pickBestActionMatch(matches);
  if (!best) return null;
  return { key: best.tag.key, label: best.tag.label, priority: Number(best.tag.priority || 0), eventType: best.eventType || "", source: "event" };
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
      if (prev) prev.count += 1;
      else matches.set(tag.key, { tag, count: 1, commandTarget: target });
    }
  }
  const best = pickBestActionMatch(matches);
  if (!best) return null;
  return { key: best.tag.key, label: best.tag.label, priority: Number(best.tag.priority || 0), commandTarget: best.commandTarget || "", source: "command" };
}

function classifyTransactionAction(tx) {
  const eventAction = classifyEventAction(tx?.effects?.events?.nodes || []);
  const moveAction = classifyMoveCallAction(tx?.kind?.commands?.nodes || []);
  if (eventAction && moveAction) {
    if (moveAction.key === "swap" && (eventAction.key === "mint" || eventAction.key === "burn")) {
      return { ...moveAction, source: "event+command", confidence: "high", eventType: eventAction.eventType || "" };
    }
    if ((eventAction.priority || 0) >= (moveAction.priority || 0)) return { ...eventAction, confidence: "high" };
    return { ...moveAction, confidence: moveAction.key === "swap" ? "high" : "medium" };
  }
  if (eventAction) return { ...eventAction, confidence: "high" };
  if (moveAction) return { ...moveAction, confidence: moveAction.key === "swap" ? "high" : "medium" };
  return null;
}

function classifyCoinBalanceFlowKind(sentRaw, recvRaw, actionLabel = "") {
  const sent = parseBigIntSafe(sentRaw);
  const recv = parseBigIntSafe(recvRaw);
  const hasSent = sent > 0n;
  const hasRecv = recv > 0n;
  if (actionLabel === "Swap") {
    if (hasSent && hasRecv) return "swap";
    if (hasRecv) return "swap-in";
    if (hasSent) return "swap-out";
  }
  if (hasSent && hasRecv) return "transfer";
  if (hasRecv) return "mint";
  if (hasSent) return "burn";
  return "transfer";
}

function classifyCoinFlowKindWithContext(effects, targetKey, sentRaw, recvRaw, actionLabel = "") {
  const base = classifyCoinBalanceFlowKind(sentRaw, recvRaw, actionLabel);
  if (base !== "mint" && base !== "burn") return base;
  const allRows = effects?.balanceChanges?.nodes || [];
  const hasOppositeNonTarget = allRows.some((bc) => {
    const ct = coinTypeKey(bc?.coinType?.repr || "");
    if (!ct || ct === targetKey) return false;
    const raw = parseBigIntSafe(bc?.amount || 0);
    if (base === "mint") return raw < 0n;
    return raw > 0n;
  });
  if (!hasOppositeNonTarget) return base;
  return base === "mint" ? "swap-in" : "swap-out";
}

async function fetchObjectDigestCandidates(coinType, maxPages, maxDigests) {
  const coinObjectType = `0x2::coin::Coin<${coinType}>`;
  let after = null;
  let hasNext = true;
  let pages = 0;
  let objectCount = 0;
  const rows = [];
  while (hasNext && pages < maxPages && rows.length < maxDigests * 2) {
    const data = await gql(`query($type: String!, $after: String) {
      objects(filter: { type: $type }, first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { version previousTransaction { digest } }
      }
    }`, { type: coinObjectType, after });
    const conn = data?.objects;
    const nodes = conn?.nodes || [];
    objectCount += nodes.length;
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
    if (deduped.length >= maxDigests) break;
  }
  return { digests: deduped, pages, objectCount, hasNext };
}

async function fetchTxMetaRowsByDigest(digests) {
  const rows = [];
  const chunks = chunkArray([...new Set(digests.filter(Boolean))], 30);
  for (const chunk of chunks) {
    const aliases = chunk.map((digest, i) => `t${i}: transaction(digest: "${digest}") { digest effects { status timestamp } }`);
    const data = await gql(`{ ${aliases.join("\n")} }`).catch(() => ({}));
    for (let i = 0; i < chunk.length; i += 1) {
      const tx = data?.[`t${i}`];
      if (!tx?.digest) continue;
      rows.push({
        digest: tx.digest,
        timestamp: tx?.effects?.timestamp || "",
        status: tx?.effects?.status || "",
      });
    }
  }
  rows.sort((a, b) => {
    const d = parseTsMs(b.timestamp) - parseTsMs(a.timestamp);
    if (d !== 0) return d;
    return String(b.digest || "").localeCompare(String(a.digest || ""));
  });
  return rows;
}

async function fetchTxDetailsByDigest(digests) {
  const rows = [];
  const chunks = chunkArray([...new Set(digests.filter(Boolean))], 2);
  for (const chunk of chunks) {
    const aliases = chunk.map((digest, i) => `t${i}: transaction(digest: "${digest}") {
      digest
      sender { address }
      kind {
        __typename
        ... on ProgrammableTransaction {
          commands(first: 8) { nodes { __typename ... on MoveCallCommand { function { name module { name package { address } } } } }
          }
        }
      }
      effects {
        status timestamp
        balanceChanges(first: 50) { pageInfo { hasNextPage } nodes { owner { address } amount coinType { repr } } }
        events(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            contents { type { repr } json }
            sender { address }
            timestamp
            transactionModule { name package { address } }
          }
        }
        objectChanges(first: 50) {
          pageInfo { hasNextPage }
          nodes {
            address idCreated idDeleted
            inputState { asMoveObject { contents { type { repr } } } }
            outputState { asMoveObject { contents { type { repr } } } }
          }
        }
      }
    }`);
    const data = await gql(`{ ${aliases.join("\n")} }`).catch(() => ({}));
    for (let i = 0; i < chunk.length; i += 1) {
      const tx = data?.[`t${i}`];
      if (!tx?.digest) continue;
      rows.push(tx);
    }
  }
  return rows;
}

async function inspectCoin(coinType, opts) {
  const targetKey = coinTypeKey(coinType);
  if (!targetKey) throw new Error(`Invalid coin type: ${coinType}`);

  const metadata = await gql(`query($ct: String!) {
    coinMetadata(coinType: $ct) { decimals symbol name iconUrl supply }
  }`, { ct: coinType }).then((d) => d?.coinMetadata || null).catch(() => null);

  let rpcSupply = null;
  try {
    rpcSupply = await rpc("suix_getTotalSupply", [coinType]);
  } catch (_) {
    rpcSupply = null;
  }

  const digestSample = await fetchObjectDigestCandidates(
    coinType,
    Math.max(1, Number(opts.maxObjectPages || 10)),
    Math.max(1, Number(opts.maxDigests || 320))
  );

  const metaRows = await fetchTxMetaRowsByDigest(digestSample.digests || []);
  const topDigests = metaRows.map((r) => r.digest).filter(Boolean).slice(0, Math.max(1, Number(opts.txLimit || 80)));
  const txRows = await fetchTxDetailsByDigest(topDigests);

  const processed = new Set();
  const matchedTx = new Set();
  const actionCounts = new Map();
  const kindCounts = new Map();
  let directEvents = 0;
  let contextEvents = 0;
  let objectChanges = 0;
  let transfers = 0;
  let swapAsMintSignals = 0;
  const swapAsMintDigests = [];

  for (const tx of txRows) {
    const digest = String(tx?.digest || "");
    if (!digest || processed.has(digest)) continue;
    processed.add(digest);
    const eff = tx?.effects || {};
    const txAction = classifyTransactionAction(tx);
    const action = String(txAction?.label || "Unknown");
    actionCounts.set(action, (actionCounts.get(action) || 0) + 1);

    let txHasTransfer = false;
    let txHasObject = false;
    let txHasDirectEvent = false;
    let txHasContextEvent = false;

    const balanceRows = (eff?.balanceChanges?.nodes || []).filter((bc) => coinTypeKey(bc?.coinType?.repr || "") === targetKey);
    if (balanceRows.length) {
      txHasTransfer = true;
      let sentRaw = 0n;
      let recvRaw = 0n;
      for (const bc of balanceRows) {
        const raw = parseBigIntSafe(bc?.amount || 0);
        if (raw < 0n) sentRaw += -raw;
        else if (raw > 0n) recvRaw += raw;
      }
      const kind = classifyCoinFlowKindWithContext(eff, targetKey, sentRaw, recvRaw, action);
      kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
      transfers += 1;
      if ((kind === "mint" || kind === "burn") && action === "Swap") {
        swapAsMintSignals += 1;
        swapAsMintDigests.push(digest);
      }
    }

    const txEvents = eff?.events?.nodes || [];
    const contextPool = [];
    for (const ev of txEvents) {
      const typeRepr = String(ev?.contents?.type?.repr || "");
      const json = ev?.contents?.json;
      if (moveTypeStringHasCoinType(typeRepr, targetKey) || valueHasCoinType(json, targetKey)) {
        directEvents += 1;
        txHasDirectEvent = true;
      } else {
        contextPool.push(ev);
      }
    }

    for (const oc of (eff?.objectChanges?.nodes || [])) {
      const inType = String(oc?.inputState?.asMoveObject?.contents?.type?.repr || "");
      const outType = String(oc?.outputState?.asMoveObject?.contents?.type?.repr || "");
      if (!moveTypeStringHasCoinType(inType, targetKey) && !moveTypeStringHasCoinType(outType, targetKey)) continue;
      objectChanges += 1;
      txHasObject = true;
    }

    if (!txHasDirectEvent && contextPool.length && (txHasTransfer || txHasObject)) {
      contextEvents += Math.min(8, contextPool.length);
      txHasContextEvent = true;
    }

    if (txHasTransfer || txHasObject || txHasDirectEvent || txHasContextEvent) matchedTx.add(digest);
  }

  return {
    coinType,
    metadata,
    rpcSupply,
    digestSample,
    txLoaded: txRows.length,
    matchedTx: matchedTx.size,
    transfers,
    directEvents,
    contextEvents,
    objectChanges,
    actionCounts: [...actionCounts.entries()].sort((a, b) => b[1] - a[1]),
    kindCounts: [...kindCounts.entries()].sort((a, b) => b[1] - a[1]),
    swapAsMintSignals,
    swapAsMintDigests: swapAsMintDigests.slice(0, 6),
  };
}

function printResult(res) {
  const symbol = res?.metadata?.symbol || res?.coinType?.split("::").pop() || "?";
  const name = res?.metadata?.name || symbol;
  const decimals = Number.isFinite(Number(res?.metadata?.decimals)) ? Number(res.metadata.decimals) : "—";
  const mdSupply = res?.metadata?.supply ?? null;
  const rpcSupply = res?.rpcSupply?.value ?? null;
  const dig = res?.digestSample || {};
  console.log(`\n=== ${symbol} (${name}) ===`);
  console.log(`coinType: ${res.coinType}`);
  console.log(`decimals: ${decimals}`);
  console.log(`supply(metadata): ${mdSupply == null ? "missing" : String(mdSupply)}`);
  console.log(`supply(rpc): ${rpcSupply == null ? "missing" : String(rpcSupply)}`);
  console.log(`objectScan: pages=${dig.pages || 0}, objects=${dig.objectCount || 0}, digests=${(dig.digests || []).length}, hasNext=${!!dig.hasNext}`);
  console.log(`txLoaded=${res.txLoaded}, matchedTx=${res.matchedTx}, transfers=${res.transfers}, events(direct/context)=${res.directEvents}/${res.contextEvents}, objectChanges=${res.objectChanges}`);
  console.log(`actions: ${res.actionCounts.length ? res.actionCounts.map(([k, v]) => `${k}:${v}`).join(", ") : "none"}`);
  console.log(`transferKinds: ${res.kindCounts.length ? res.kindCounts.map(([k, v]) => `${k}:${v}`).join(", ") : "none"}`);
  console.log(`swapAsMintSignals: ${res.swapAsMintSignals}`);
  if (res.swapAsMintDigests.length) {
    console.log(`swapAsMintDigests: ${res.swapAsMintDigests.map((d) => shortHash(d)).join(", ")}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const normalizedCoins = [...new Set(opts.coinTypes.map((c) => normalizeCoinTypeInput(c)).filter(Boolean))];
  if (!normalizedCoins.length) {
    console.error("No valid coin types provided.");
    process.exit(1);
  }

  console.log(`Running coin smoke for ${normalizedCoins.length} coin type(s)...`);
  for (const coinType of normalizedCoins) {
    try {
      const res = await inspectCoin(coinType, opts);
      printResult(res);
    } catch (e) {
      console.error(`\n=== ${coinType} ===`);
      console.error(`error: ${e?.message || String(e)}`);
    }
  }
}

await main();

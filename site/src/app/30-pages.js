// ── Dashboard ───────────────────────────────────────────────────────────
let dashboardTimer = null;

function parseIsoMsOrNull(ts) {
  const ms = Date.parse(String(ts || ""));
  return Number.isFinite(ms) ? ms : null;
}

function fmtDurationCompact(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function fetchDashboardEpochTrends(force = false) {
  return withTimedCache(dashboardEpochsCache, DASH_EPOCHS_TTL_MS, force, async () => {
    const data = await gql(`{
      checkpoint { timestamp }
      epochs(last: 8) {
        nodes {
          epochId
          startTimestamp
          endTimestamp
          totalTransactions
          totalCheckpoints
          referenceGasPrice
        }
      }
    }`);
    const nowMs = parseIsoMsOrNull(data?.checkpoint?.timestamp) || Date.now();
    const rows = (data?.epochs?.nodes || [])
      .map((e) => {
        const epochId = Number(e?.epochId);
        const startMs = parseIsoMsOrNull(e?.startTimestamp);
        const endMsRaw = parseIsoMsOrNull(e?.endTimestamp);
        if (!Number.isFinite(epochId) || !Number.isFinite(startMs)) return null;
        const isLive = !Number.isFinite(endMsRaw);
        const endMs = isLive ? nowMs : endMsRaw;
        const durationMs = Math.max(1000, Number(endMs) - Number(startMs));
        const txCount = Number(e?.totalTransactions || 0);
        const checkpointCount = Number(e?.totalCheckpoints || 0);
        const gasPrice = Number(e?.referenceGasPrice || 0);
        const avgTps = txCount > 0 ? (txCount / (durationMs / 1000)) : 0;
        return {
          epochId,
          isLive,
          startMs,
          endMs,
          durationMs,
          txCount,
          checkpointCount,
          gasPrice,
          avgTps,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.epochId - b.epochId);
    const result = {
      rows,
      nowMs,
      sourceTimestamp: data?.checkpoint?.timestamp || "",
    };
    writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.dashboardEpochs, result, 24000);
    return result;
  });
}

async function fetchDashboardHead(force = false) {
  return withTimedCache(dashboardHeadCache, DASHBOARD_HEAD_TTL_MS, force, async () => {
    const data = await gql(`{
      checkpoint {
        sequenceNumber digest timestamp
        networkTotalTransactions
      }
      epoch {
        epochId referenceGasPrice startTimestamp
        totalCheckpoints totalTransactions
      }
    }`);
    const result = {
      checkpoint: data?.checkpoint || {},
      epoch: data?.epoch || {},
    };
    writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.dashboardHead, result, 12000);
    return result;
  });
}

async function fetchDashboardActivitySnapshot(force = false) {
  return withTimedCache(dashboardActivityCache, DASHBOARD_ACTIVITY_TTL_MS, force, async () => {
    const data = await gql(`{
      transactions(last: 10, filter: {}) {
        nodes {
          digest
          sender { address }
          kind {
            __typename
            ... on ProgrammableTransaction {
              commands(first: 3) { nodes { __typename ... on MoveCallCommand { function { name module { name package { address } } } } } }
            }
          }
          effects {
            status timestamp
            gasEffects { gasSummary { computationCost storageCost storageRebate } }
            events(first: 3) { nodes { contents { type { repr } } } }
          }
        }
      }
      checkpoints(last: 6) {
        nodes { sequenceNumber digest timestamp networkTotalTransactions rollingGasSummary { computationCost storageCost storageRebate } }
      }
    }`);
    const result = {
      txRows: (data?.transactions?.nodes || []).reverse(),
      cpRows: (data?.checkpoints?.nodes || []).reverse(),
    };
    writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.dashboardActivity, result, 40000);
    return result;
  });
}

async function renderDashboard(app) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const dashHead = peekTimedCache(dashboardHeadCache, DASHBOARD_HEAD_TTL_MS) || { checkpoint: {}, epoch: {} };
  const cachedActivity = peekTimedCache(dashboardActivityCache, DASHBOARD_ACTIVITY_TTL_MS) || { txRows: [], cpRows: [] };
  const cachedEpochTrends = peekTimedCache(dashboardEpochsCache, DASH_EPOCHS_TTL_MS) || null;
  const cachedStablecoinSupply = peekTimedCache(stablecoinCache, ECOSYSTEM_TTL) || null;
  const cachedEcosystemStats = peekTimedCache(ecosystemCache, ECOSYSTEM_TTL) || null;
  const cp = dashHead?.checkpoint || {};
  const ep = dashHead?.epoch || {};
  let lastHeadSeq = Number(cp?.sequenceNumber || 0);
  let activityInFlight = null;
  let latestCheckpointRows = cachedActivity.cpRows || [];
  const categoryColors = { "Lending": "var(--green)", "Dexes": "var(--blue)", "Dexs": "var(--blue)", "Liquid Staking": "var(--purple)", "CDP": "var(--yellow)", "Yield": "var(--accent)", "Other": "var(--text-dim)" };

  function dashGas(t) {
    const gs = t.effects?.gasEffects?.gasSummary;
    if (!gs) return "";
    const gas = Number(gs.computationCost) + Number(gs.storageCost) - Number(gs.storageRebate);
    if (gas <= 0) return "";
    return fmtSui(gas);
  }

  function checkpointTxDeltas(cps) {
    const deltas = [];
    for (let i = 1; i < cps.length; i += 1) {
      const prev = Number(cps[i - 1]?.networkTotalTransactions || 0);
      const cur = Number(cps[i]?.networkTotalTransactions || 0);
      if (Number.isFinite(prev) && Number.isFinite(cur) && cur >= prev) deltas.push(cur - prev);
    }
    return deltas;
  }

  function renderCpRows(cps) {
    if (!Array.isArray(cps) || !cps.length) {
      return `<tr><td colspan="4" class="u-fs12-dim">Loading checkpoint activity...</td></tr>`;
    }
    return cps.map((c, i) => {
      const prev = cps[i + 1];
      const txCount = prev ? (Number(c.networkTotalTransactions) - Number(prev.networkTotalTransactions)) : null;
      const gs = c.rollingGasSummary;
      const gasTotal = gs ? Number(gs.computationCost) + Number(gs.storageCost) - Number(gs.storageRebate) : 0;
      const prevGs = prev?.rollingGasSummary;
      const prevGasTotal = prevGs ? Number(prevGs.computationCost) + Number(prevGs.storageCost) - Number(prevGs.storageRebate) : 0;
      const gasUsed = prev ? gasTotal - prevGasTotal : 0;
      return `<tr>
        <td><a class="hash-link" href="#/checkpoint/${c.sequenceNumber}">${fmtNumber(c.sequenceNumber)}</a></td>
        <td style="font-family:var(--mono);font-size:12px;color:var(--text-dim)">${txCount != null ? txCount + " txns" : "—"}</td>
        <td class="u-mono-11-dim">${gasUsed > 0 ? fmtSui(gasUsed) : "—"}</td>
        <td>${timeTag(c.timestamp)}</td>
      </tr>`;
    }).slice(0, -1).join("");
  }

  function renderTxRows(txList) {
    if (!Array.isArray(txList) || !txList.length) {
      return `<tr><td colspan="6" class="u-fs12-dim">Loading transaction activity...</td></tr>`;
    }
    return txList.filter((t) => t.kind?.__typename !== "ConsensusCommitPrologueTransaction").slice(0, 8).map((t) => {
      const sender = t.sender?.address;
      const intent = analyzeTxIntent(t);
      return `<tr>
        <td>${hashLink(t.digest, "/tx/" + t.digest)}</td>
        <td class="u-fs12">${renderIntentChip(intent)}</td>
        <td>${sender ? hashLink(sender, "/address/" + sender) : '<span class="u-c-dim">system</span>'}</td>
        <td>${statusBadge(t.effects?.status)}</td>
        <td class="u-mono-11-dim">${dashGas(t)}</td>
        <td>${timeTag(t.effects?.timestamp)}</td>
      </tr>`;
    }).join("");
  }

  function applyDashboardActivity(txs, cpRows) {
    if (!isActiveRoute()) return;
    latestCheckpointRows = cpRows || [];
    const cpBody = document.getElementById("dash-cp-tbody");
    if (cpBody) cpBody.innerHTML = renderCpRows(cpRows);
    const txBody = document.getElementById("dash-tx-tbody");
    if (txBody) txBody.innerHTML = renderTxRows(txs);
    const sparkWrap = document.getElementById("dash-tx-delta-spark");
    if (sparkWrap) {
      const deltas = checkpointTxDeltas(cpRows || []);
      sparkWrap.innerHTML = deltas.length
        ? renderSparkline(deltas, { prefix: "Δ ", suffix: " tx/checkpoint", color: "var(--blue)" })
        : '<span class="u-fs11-dim">loading...</span>';
    }
    if (isActiveRoute()) scheduleVisibleRouteShellPrefetch(app);
  }

  async function loadDashboardActivity(force = false) {
    if (!force && activityInFlight) return activityInFlight;
    activityInFlight = (async () => {
      const snapshot = await fetchDashboardActivitySnapshot(force);
      applyDashboardActivity(snapshot?.txRows || [], snapshot?.cpRows || []);
    })().finally(() => { activityInFlight = null; });
    return activityInFlight;
  }

  function applyDashboardHead(headData) {
    if (!isActiveRoute()) return;
    const nextCp = headData?.checkpoint || {};
    const nextEp = headData?.epoch || {};
    const cpEl = document.querySelector('[data-stat="checkpoint"]');
    if (cpEl) cpEl.textContent = nextCp?.sequenceNumber ? fmtNumber(nextCp.sequenceNumber) : "...";
    const cpTimeEl = document.querySelector('[data-stat-sub="cp-time"]');
    if (cpTimeEl) {
      cpTimeEl.textContent = nextCp?.timestamp ? timeAgo(nextCp.timestamp) : "Loading...";
      cpTimeEl.title = nextCp?.timestamp ? fmtTime(nextCp.timestamp) : "";
    }
    const epochLinkEl = document.querySelector('[data-stat-link="epoch"]');
    if (epochLinkEl) epochLinkEl.setAttribute("href", nextEp?.epochId != null ? `#/epoch/${nextEp.epochId}` : "#/epoch/0");
    const epochEl = document.querySelector('[data-stat="epoch"]');
    if (epochEl) epochEl.textContent = nextEp?.epochId != null ? fmtNumber(nextEp.epochId) : "...";
    const epochStartEl = document.querySelector('[data-stat-sub="epoch-start"]');
    if (epochStartEl) epochStartEl.textContent = nextEp?.startTimestamp ? `Started ${fmtTime(nextEp.startTimestamp)}` : "Loading...";
    const totalTxEl = document.querySelector('[data-stat="total-txns"]');
    if (totalTxEl) totalTxEl.textContent = nextCp?.networkTotalTransactions ? fmtCompact(nextCp.networkTotalTransactions) : "...";
    const epochTxEl = document.querySelector('[data-stat-sub="epoch-txns"]');
    if (epochTxEl) epochTxEl.textContent = nextEp?.totalTransactions ? `Epoch: ${fmtCompact(nextEp.totalTransactions)}` : "Epoch: ...";
    const gasEl = document.querySelector('[data-stat="gas-price"]');
    if (gasEl) gasEl.textContent = nextEp?.referenceGasPrice != null ? fmtNumber(nextEp.referenceGasPrice) : "...";
    const checkpointsEl = document.querySelector('[data-stat-sub="gas-checkpoints"]');
    if (checkpointsEl) checkpointsEl.textContent = nextEp?.totalCheckpoints != null ? `${fmtNumber(nextEp.totalCheckpoints)} checkpoints` : "Loading...";
    const seq = Number(nextCp?.sequenceNumber || 0);
    if (Number.isFinite(seq) && seq > 0) lastHeadSeq = seq;
  }

  function applyDashboardEpochTrends(trendData) {
    const el = document.getElementById("epoch-trends-card");
    if (!el) return;
    const rowsAsc = trendData?.rows || [];
    if (!rowsAsc.length) {
      el.querySelector(".card-body").innerHTML = '<div class="empty">Epoch trend data unavailable</div>';
      return;
    }
    const rows = [...rowsAsc].sort((a, b) => b.epochId - a.epochId);
    const txSeries = rowsAsc.map((r) => r.txCount);
    const tpsSeries = rowsAsc.map((r) => r.avgTps);
    const latest = rows[0];
    const sourceTs = trendData?.sourceTimestamp || "";
    el.querySelector(".card-body").innerHTML = `
      <div style="padding:12px 16px 6px">
        <div class="u-fs12-dim">
          Epoch-level throughput and gas trend from on-chain epoch aggregates.
          ${sourceTs ? `Updated ${timeAgo(sourceTs)}.` : ""}
        </div>
        <div class="two-col" style="margin:8px 0 0">
          <div>
            <div class="u-fs11-dim">Transactions per Epoch</div>
            <div class="sparkline-wrap">${renderSparkline(txSeries, { prefix: "", suffix: " tx/epoch", color: "var(--accent)" })}</div>
          </div>
          <div>
            <div class="u-fs11-dim">Average TPS per Epoch</div>
            <div class="sparkline-wrap">${renderSparkline(tpsSeries, { prefix: "", suffix: " TPS", color: "var(--green)" })}</div>
          </div>
        </div>
      </div>
      <table>
        <thead><tr><th>Epoch</th><th class="u-ta-right">Txs</th><th class="u-ta-right">Avg TPS</th><th class="u-ta-right">Ref Gas (MIST)</th><th class="u-ta-right">Checkpoints</th><th>Duration</th><th>End</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td><a class="hash-link" href="#/epoch/${r.epochId}">${fmtNumber(r.epochId)}</a>${r.isLive ? ' <span class="badge badge-success">Live</span>' : ''}</td>
            <td class="u-ta-right-mono">${fmtNumber(r.txCount)}</td>
            <td class="u-ta-right-mono">${r.avgTps.toFixed(2)}</td>
            <td class="u-ta-right-mono">${fmtNumber(r.gasPrice)}</td>
            <td class="u-ta-right-mono">${fmtNumber(r.checkpointCount)}</td>
            <td>${fmtDurationCompact(r.durationMs)}</td>
            <td>${r.isLive ? '<span class="u-c-dim">in progress</span>' : timeTag(r.endMs)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <div class="u-fs12-dim u-p12-16">Latest epoch ${fmtNumber(latest.epochId)}: ${fmtNumber(latest.txCount)} tx, ${latest.avgTps.toFixed(2)} TPS, gas ${fmtNumber(latest.gasPrice)} MIST.</div>
    `;
  }

  function applyDashboardStablecoinSupply(data) {
    const el = document.getElementById("stablecoin-card");
    if (!el) return;
    if (!data || !data.coins?.length) {
      el.querySelector(".card-body").innerHTML = '<div class="empty">Supply data unavailable</div>';
      return;
    }
    el.querySelector(".card-body").innerHTML = `
      <div class="stablecoin-layout">
        ${renderDonutChart(data.coins, data.totalSupply)}
        <ul class="stablecoin-legend">
          ${data.coins.map((c) => `<li>
            <span class="dot" style="background:${c.color}"></span>
            <span>${c.symbol}</span>
            <span class="val">$${fmtCompact(c.supply)}</span>
            <span class="pct">${c.pct.toFixed(1)}%</span>
          </li>`).join("")}
        </ul>
      </div>`;
  }

  function applyDashboardEcosystemStats(stats) {
    const tvlBox = document.querySelector('[data-stat="tvl"]');
    if (tvlBox && stats) tvlBox.textContent = "$" + fmtCompact(stats.totalTvl);
    const tvlEl = document.getElementById("tvl-breakdown-card");
    if (tvlEl && stats) {
      const otherTvl = Math.max(0, stats.totalTvl - stats.lendingTvl - stats.dexTvl - stats.lstTvl);
      const pctL = stats.totalTvl > 0 ? (stats.lendingTvl / stats.totalTvl * 100) : 0;
      const pctD = stats.totalTvl > 0 ? (stats.dexTvl / stats.totalTvl * 100) : 0;
      const pctS = stats.totalTvl > 0 ? (stats.lstTvl / stats.totalTvl * 100) : 0;
      const pctO = Math.max(0, 100 - pctL - pctD - pctS);
      tvlEl.querySelector(".card-body").innerHTML = `
        <div style="padding:16px 16px 0">
          <div style="font-size:24px;font-weight:700">$${fmtCompact(stats.totalTvl)}</div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Total Value Locked</div>
          <div class="tvl-bar">
            <div style="width:${pctL.toFixed(1)}%;background:var(--green)" title="Lending ${pctL.toFixed(1)}%"></div>
            <div style="width:${pctD.toFixed(1)}%;background:var(--blue)" title="DEX ${pctD.toFixed(1)}%"></div>
            <div style="width:${pctS.toFixed(1)}%;background:var(--purple)" title="Liquid Staking ${pctS.toFixed(1)}%"></div>
            <div style="width:${pctO.toFixed(1)}%;background:var(--text-dim)" title="Other ${pctO.toFixed(1)}%"></div>
          </div>
        </div>
        <div style="padding:0 16px 12px">
          <div class="tvl-row"><span class="dot" style="background:var(--green)"></span> Lending <span class="tvl-val u-c-green">$${fmtCompact(stats.lendingTvl)} <span style="color:var(--text-dim);font-size:11px">${pctL.toFixed(1)}%</span></span></div>
          <div class="tvl-row"><span class="dot" style="background:var(--blue)"></span> DEX <span class="tvl-val u-c-blue">$${fmtCompact(stats.dexTvl)} <span style="color:var(--text-dim);font-size:11px">${pctD.toFixed(1)}%</span></span></div>
          <div class="tvl-row"><span class="dot" style="background:var(--purple)"></span> Liquid Staking <span class="tvl-val u-c-purple">$${fmtCompact(stats.lstTvl)} <span style="color:var(--text-dim);font-size:11px">${pctS.toFixed(1)}%</span></span></div>
          <div class="tvl-row"><span class="dot" style="background:var(--text-dim)"></span> Other <span class="tvl-val">$${fmtCompact(otherTvl)} <span style="color:var(--text-dim);font-size:11px">${pctO.toFixed(1)}%</span></span></div>
          <div class="tvl-row" style="border-top:1px solid var(--border);margin-top:4px;padding-top:8px"><span class="u-c-accent">24h DEX Volume</span> <span class="tvl-val u-c-accent">$${fmtCompact(stats.dexVolume24h)}</span></div>
        </div>`;
    }
    const prEl = document.getElementById("protocol-rankings");
    if (prEl && stats) {
      prEl.querySelector(".card-body").innerHTML = `<table>
        <thead><tr><th>#</th><th>Protocol</th><th>Category</th><th class="u-ta-right">TVL</th><th class="u-ta-right">24h Change</th></tr></thead>
        <tbody>
          ${stats.protocols.slice(0, 10).map((p, i) => {
            const catColor = categoryColors[p.category] || "var(--text-dim)";
            const changeStr = p.change24h != null ? `${p.change24h >= 0 ? "+" : ""}${p.change24h.toFixed(2)}%` : "—";
            const changeColor = p.change24h > 0 ? "var(--green)" : p.change24h < 0 ? "var(--red)" : "var(--text-dim)";
            return `<tr>
              <td style="color:var(--text-dim);font-size:12px">${i + 1}</td>
              <td style="font-weight:500">${p.name}</td>
              <td><span class="badge" style="background:${catColor};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px">${p.category}</span></td>
              <td class="u-ta-right-mono">$${fmtCompact(p.tvl)}</td>
              <td style="text-align:right;color:${changeColor};font-family:var(--mono)">${changeStr}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
    }
  }

  app.innerHTML = `
    <div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">Live dashboard snapshot · Source: Sui GraphQL Mainnet · Auto-refresh every 5s</div>
    <div class="card u-mb16">
      <div class="card-header">Start Here</div>
      <div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;padding:12px 16px">
        <a href="#/txs" class="hash-link u-panel-block">
          <div style="font-weight:600;color:var(--text);margin-bottom:4px">Track Network Activity</div>
          <div class="u-fs12-dim">Recent transactions, checkpoints, and validator health.</div>
        </a>
        <a href="#/defi-overview" class="hash-link u-panel-block">
          <div style="font-weight:600;color:var(--text);margin-bottom:4px">Analyze DeFi</div>
          <div class="u-fs12-dim">Rates, DEX activity, flows, and risk in one place.</div>
        </a>
      </div>
    </div>
    <div class="dash-grid-6">
      <div class="stat-box">
        <div class="stat-label">Latest Checkpoint</div>
        <div class="stat-value" data-stat="checkpoint">${cp?.sequenceNumber ? fmtNumber(cp.sequenceNumber) : "..."}</div>
        <div class="stat-sub" data-stat-sub="cp-time" title="${cp?.timestamp ? fmtTime(cp.timestamp) : ""}" style="cursor:help">${cp?.timestamp ? timeAgo(cp.timestamp) : "Loading..."}</div>
      </div>
      <a class="stat-box" data-stat-link="epoch" href="${ep?.epochId != null ? `#/epoch/${ep.epochId}` : '#/epoch/0'}" style="display:block;cursor:pointer;text-decoration:none;color:inherit">
        <div class="stat-label">Current Epoch</div>
        <div class="stat-value u-c-accent" data-stat="epoch">${ep?.epochId != null ? fmtNumber(ep.epochId) : "..."}</div>
        <div class="stat-sub" data-stat-sub="epoch-start">${ep?.startTimestamp ? `Started ${fmtTime(ep.startTimestamp)}` : "Loading..."}</div>
      </a>
      <div class="stat-box">
        <div class="stat-label">Total Transactions</div>
        <div class="stat-value" data-stat="total-txns">${cp?.networkTotalTransactions ? fmtCompact(cp.networkTotalTransactions) : "..."}</div>
        <div class="stat-sub" data-stat-sub="epoch-txns">${ep?.totalTransactions ? `Epoch: ${fmtCompact(ep.totalTransactions)}` : "Epoch: ..."}</div>
        <div class="sparkline-wrap" id="dash-tx-delta-spark">${(cachedActivity.cpRows || []).length
          ? renderSparkline(checkpointTxDeltas(cachedActivity.cpRows || []), { prefix: "Δ ", suffix: " tx/checkpoint", color: "var(--blue)" })
          : '<span class="u-fs11-dim">loading...</span>'}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Gas Price</div>
        <div class="stat-value"><span data-stat="gas-price">${ep?.referenceGasPrice != null ? fmtNumber(ep.referenceGasPrice) : "..."}</span> <span class="u-fs12-dim">MIST</span></div>
        <div class="stat-sub" data-stat-sub="gas-checkpoints">${ep?.totalCheckpoints != null ? `${fmtNumber(ep.totalCheckpoints)} checkpoints` : "Loading..."}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">SUI Price</div>
        <div class="stat-value u-c-green" data-stat="sui-price">...</div>
        <div class="stat-sub">DeepBook SUI/USDC</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Total TVL</div>
        <div class="stat-value" data-stat="tvl">...</div>
        <div class="stat-sub">DeFiLlama</div>
      </div>
    </div>

    <div class="card u-mb16" id="epoch-trends-card">
      <div class="card-header">
        <span>Epoch Trends</span>
        <span class="u-fs12-dim">GraphQL: epochs(last:8)</span>
      </div>
      <div class="card-body"><div class="loading u-p24">Loading epoch trends...</div></div>
    </div>

    <div class="two-col u-mb16">
      <div class="card" id="stablecoin-card">
        <div class="card-header">Stablecoin Supply</div>
        <div class="card-body"><div class="loading u-p24">Loading supply data...</div></div>
      </div>
      <div class="card" id="tvl-breakdown-card">
        <div class="card-header">DeFi TVL Breakdown</div>
        <div class="card-body"><div class="loading u-p24">Loading TVL data...</div></div>
      </div>
    </div>

    <div class="two-col u-mb16">
      <div class="card">
        <div class="card-header">Latest Checkpoints</div>
        <div class="card-body">
          <table>
            <thead><tr><th>Checkpoint</th><th>Txns</th><th>Gas</th><th>Time</th></tr></thead>
            <tbody id="dash-cp-tbody">${renderCpRows(cachedActivity.cpRows || [])}</tbody>
          </table>
          <a class="view-more" href="#/checkpoints">View all checkpoints</a>
        </div>
      </div>
      <div class="card">
        <div class="card-header">Recent Transactions</div>
        <div class="card-body">
          <table>
            <thead><tr><th>Digest</th><th>Action</th><th>Sender</th><th>Status</th><th>Gas</th><th>Time</th></tr></thead>
            <tbody id="dash-tx-tbody">${renderTxRows(cachedActivity.txRows || [])}</tbody>
          </table>
          <a class="view-more" href="#/txs">View all transactions</a>
        </div>
      </div>
    </div>

    <div class="card" id="protocol-rankings">
      <div class="card-header">Sui Protocol Rankings</div>
      <div class="card-body"><div class="loading" style="padding:16px">Loading protocols...</div></div>
    </div>
  `;

  if (dashHead?.checkpoint || dashHead?.epoch) applyDashboardHead(dashHead);
  if (cachedEpochTrends) applyDashboardEpochTrends(cachedEpochTrends);
  if (cachedStablecoinSupply) applyDashboardStablecoinSupply(cachedStablecoinSupply);
  if (cachedEcosystemStats) applyDashboardEcosystemStats(cachedEcosystemStats);
  const priceBox = document.querySelector('[data-stat="sui-price"]');
  if (priceBox && defiPrices.SUI) priceBox.textContent = "$" + defiPrices.SUI.toFixed(2);
  const loadDashboardExtraBundle = () => ensureExtraRoutesLoaded().catch(() => null);
  setTimeout(() => {
    if (!isActiveRoute()) return;
    fetchDashboardHead(false).then((head) => {
      if (!isActiveRoute()) return;
      applyDashboardHead(head);
    }).catch(() => null);
    loadDashboardActivity(false).catch(() => null);
  }, 0);

  runWhenVisible("epoch-trends-card", () => {
    return fetchDashboardEpochTrends().then((trendData) => {
      if (!isActiveRoute()) return;
      applyDashboardEpochTrends(trendData);
    });
  }, { rootMargin: "200px 0px", timeoutMs: 1800 });

  runWhenVisible("stablecoin-card", () => {
    return new Promise((resolve) => setTimeout(resolve, 900))
      .then(loadDashboardExtraBundle)
      .then(() => fetchStablecoinSupply())
      .then((data) => {
        if (!isActiveRoute()) return;
        applyDashboardStablecoinSupply(data);
      });
  }, { rootMargin: "240px 0px", timeoutMs: 2200 });

  runWhenVisible("protocol-rankings", () => {
    return new Promise((resolve) => setTimeout(resolve, 1100))
      .then(loadDashboardExtraBundle)
      .then(() => fetchEcosystemStats())
      .then((stats) => {
        if (!isActiveRoute()) return;
        applyDashboardEcosystemStats(stats);
      });
  }, { rootMargin: "260px 0px", timeoutMs: 2500 });

  setTimeout(() => {
    if (!isActiveRoute()) return;
    loadDashboardExtraBundle()
      .then(() => fetchDefiPrices())
      .then(() => {
        if (!isActiveRoute()) return;
        const nextPriceBox = document.querySelector('[data-stat="sui-price"]');
        if (nextPriceBox && defiPrices.SUI) nextPriceBox.textContent = "$" + defiPrices.SUI.toFixed(2);
      })
      .catch(() => null);
  }, 1200);

  if (dashboardTimer) clearInterval(dashboardTimer);
  dashboardTimer = setInterval(async () => {
    if (parseRoute(getRoute()).page !== "home") {
      clearInterval(dashboardTimer);
      dashboardTimer = null;
      return;
    }
    try {
      const freshHead = await fetchDashboardHead(true);
      if (!isActiveRoute()) return;
      const fcp = freshHead?.checkpoint || {};
      const prevSeq = lastHeadSeq;
      applyDashboardHead(freshHead);
      const seq = Number(fcp?.sequenceNumber || 0);
      if (Number.isFinite(seq) && seq > 0 && seq !== prevSeq) {
        lastHeadSeq = seq;
        loadDashboardActivity(true).catch(() => null);
      } else if (!latestCheckpointRows.length) {
        loadDashboardActivity(false).catch(() => null);
      }
    } catch (_) { /* ignore refresh errors */ }
  }, 5000);
}

// ── Checkpoints List ────────────────────────────────────────────────────
let checkpointsCursor = null;
async function renderCheckpoints(app, after = null) {
  const loadPage = () => gql(`query($after: String) {
    checkpoints(last: 25, before: $after) {
      pageInfo { hasPreviousPage startCursor hasNextPage endCursor }
      nodes {
        sequenceNumber digest timestamp
        networkTotalTransactions
        rollingGasSummary { computationCost storageCost }
      }
    }
  }`, { after }).then((data) => ({
    nodes: data?.checkpoints?.nodes || [],
    pageInfo: data?.checkpoints?.pageInfo || { hasPreviousPage: false, startCursor: "", hasNextPage: false, endCursor: "" },
  }));

  const page = after
    ? await loadPage()
    : await withTimedCache(checkpointsListCache, LIST_PAGE_TTL_MS, false, async () => {
        const result = await loadPage();
        writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.checkpointsListFirstPage, result, 18000);
        return result;
      });

  const cps = page.nodes.reverse();
  const pi = page.pageInfo;

  app.innerHTML = `
    <div class="page-title">Checkpoints</div>
    <div class="card">
      <div class="card-body">
        <table>
          <thead><tr>
            <th>Checkpoint</th><th>Digest</th><th>Timestamp</th><th>Gas (Per Checkpoint)</th>
          </tr></thead>
          <tbody>
            ${cps.map((c, i) => {
              const prev = cps[i + 1];
              const gs = c.rollingGasSummary;
              const gasTotal = gs ? Number(gs.computationCost) + Number(gs.storageCost) - Number(gs.storageRebate) : 0;
              const prevGs = prev?.rollingGasSummary;
              const prevGasTotal = prevGs ? Number(prevGs.computationCost) + Number(prevGs.storageCost) - Number(prevGs.storageRebate) : 0;
              const gasUsed = prev ? gasTotal - prevGasTotal : 0;
              return `<tr>
              <td><a class="hash-link" href="#/checkpoint/${c.sequenceNumber}">${fmtNumber(c.sequenceNumber)}</a></td>
              <td>${hashLink(c.digest, '/checkpoint/' + c.sequenceNumber)}</td>
              <td>${fmtTime(c.timestamp)}</td>
              <td>${gasUsed > 0 ? fmtSui(gasUsed) : '—'}</td>
            </tr>`;
            }).slice(0, -1).join("")}
          </tbody>
        </table>
        <div class="pagination">
          <button data-action="checkpoints-newer" data-cursor="${escapeAttr(pi.endCursor || "")}"
            ${!pi.hasNextPage ? "disabled" : ""}>Newer</button>
          <button data-action="checkpoints-older" data-cursor="${escapeAttr(pi.startCursor || "")}"
            ${!pi.hasPreviousPage ? "disabled" : ""}>Older</button>
        </div>
      </div>
    </div>
  `;
  if (app._checkpointsClickHandler) app.removeEventListener("click", app._checkpointsClickHandler);
  app._checkpointsClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (action !== "checkpoints-newer" && action !== "checkpoints-older") return;
    ev.preventDefault();
    if (trigger.hasAttribute("disabled")) return;
    const cursor = trigger.getAttribute("data-cursor") || "";
    await renderCheckpoints(app, cursor || null);
  };
  app.addEventListener("click", app._checkpointsClickHandler);
}

async function fetchCheckpointDetailShell(seqNum, force = false) {
  const seq = parseInt(seqNum);
  const checkpointStorageKey = persistedScalarCacheKey(PERSISTED_CACHE_KEYS.checkpointDetailPrefix, seq);
  const checkpointState = getKeyedCacheState(checkpointDetailCache, seq);
  hydratePersistedTimedCacheState(checkpointState, checkpointStorageKey, ENTITY_SHELL_TTL_MS);
  return withTimedCache(checkpointState, ENTITY_SHELL_TTL_MS, force, async () => {
    const result = await gql(`query($seq: UInt53!) {
      checkpoint(sequenceNumber: $seq) {
        sequenceNumber digest timestamp
        previousCheckpointDigest
        networkTotalTransactions
        epoch { epochId }
        rollingGasSummary { computationCost storageCost storageRebate }
        transactions(first: 20) {
          pageInfo { hasNextPage endCursor }
          nodes {
            digest
            sender { address }
            effects {
              status timestamp
              gasEffects { gasSummary { computationCost storageCost storageRebate } }
            }
          }
        }
      }
    }`, { seq });
    writePersistedTimedCacheRecord(checkpointStorageKey, result, 70000);
    return result;
  });
}

// ── Checkpoint Detail ───────────────────────────────────────────────────
async function renderCheckpointDetail(app, seqNum) {
  const routeParams = splitRouteAndParams(getRoute()).params;
  const useRootEffects = routeParams.get("effects") === "1";
  const data = await fetchCheckpointDetailShell(seqNum, false);

  const cp = data.checkpoint;
  if (!cp) { app.innerHTML = renderEmpty("Checkpoint not found."); return; }

  const txs = cp.transactions.nodes;
  const gas = cp.rollingGasSummary;
  let rootEffectsError = "";
  const rootEffectsByDigest = new Map();
  if (useRootEffects && txs.length) {
    try {
      const keys = txs.map((t) => t?.digest).filter(Boolean);
      const effectsList = await multiGetTransactionEffectsSummary(keys);
      for (const eff of effectsList) {
        if (eff?.digest) rootEffectsByDigest.set(eff.digest, eff);
      }
    } catch (e) {
      rootEffectsError = e?.message || "multiGetTransactionEffects failed";
    }
  }
  const txRows = txs.map((t) => {
    const rootEff = rootEffectsByDigest.get(t?.digest);
    const useRoot = useRootEffects && !!rootEff;
    return {
      tx: t,
      eff: useRoot ? rootEff : t?.effects,
      source: useRoot ? "root" : "embedded",
    };
  });
  const rootResolved = txRows.filter((r) => r.source === "root").length;

  app.innerHTML = `
    <div class="page-title">
      Checkpoint <span class="type-tag">#${fmtNumber(cp.sequenceNumber)}</span>
      ${copyLinkBtn()}${viewQueryBtn('checkpoint_detail', { seq: seqNum })}
    </div>
    <div class="card u-mb16">
      <div class="card-body">
        <div class="detail-row">
          <div class="detail-key">Checkpoint</div>
          <div class="detail-val">${fmtNumber(cp.sequenceNumber)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Digest</div>
          <div class="detail-val">${cp.digest} ${copyBtn(cp.digest)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Timestamp</div>
          <div class="detail-val normal-font">${fmtTime(cp.timestamp)} (${timeAgo(cp.timestamp)})</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Epoch</div>
          <div class="detail-val">${cp.epoch?.epochId != null ? `<a class="hash-link" href="#/epoch/${cp.epoch.epochId}">${cp.epoch.epochId}</a>` : "—"}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Network Total Txns</div>
          <div class="detail-val normal-font">${fmtNumber(cp.networkTotalTransactions)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Previous Digest</div>
          <div class="detail-val">${cp.previousCheckpointDigest || "—"}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Gas Summary</div>
          <div class="detail-val normal-font">
            Computation: ${fmtSui(gas?.computationCost)} |
            Storage: ${fmtSui(gas?.storageCost)} |
            Rebate: ${fmtSui(gas?.storageRebate)}
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span>Transactions (${txs.length}${cp.transactions.pageInfo.hasNextPage ? "+" : ""})</span>
        <button type="button" class="btn-surface-sm" data-action="checkpoint-toggle-effects-mode">${useRootEffects ? "Effects Source: Root" : "Effects Source: Embedded"}</button>
      </div>
      <div class="card-body">
        <div class="u-fs12-dim u-p12-16">
          ${useRootEffects
            ? `Effects mode: <span class="u-c-text">multiGetTransactionEffects</span> (${fmtNumber(rootResolved)}/${fmtNumber(txs.length)} resolved)`
            : 'Effects mode: <span class="u-c-text">checkpoint.transactions.effects</span>'}
          ${rootEffectsError ? ` · <span class="u-c-yellow">Root query failed (${escapeHtml(rootEffectsError)}), fallback used.</span>` : ""}
        </div>
        <table>
          <thead><tr><th>Digest</th><th>Sender</th><th>Status</th><th>Gas Used</th><th>Time</th><th class="u-ta-right">Effects</th></tr></thead>
          <tbody>
            ${txRows.map(({ tx: t, eff, source }) => {
              const gs = eff?.gasEffects?.gasSummary;
              const gasUsed = gs ? Number(gs.computationCost) + Number(gs.storageCost) - Number(gs.storageRebate) : 0;
              return `<tr>
                <td>${hashLink(t.digest, '/tx/' + t.digest)}</td>
                <td>${t.sender ? hashLink(t.sender.address, '/address/' + t.sender.address) : "—"}</td>
                <td>${statusBadge(eff?.status)}</td>
                <td>${fmtSui(gasUsed)}</td>
                <td>${timeTag(eff?.timestamp || t.effects?.timestamp)}</td>
                <td class="u-ta-right">${source === "root" ? '<span class="badge badge-success">root</span>' : '<span class="u-fs11-dim">embedded</span>'}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
  if (app._checkpointDetailClickHandler) app.removeEventListener("click", app._checkpointDetailClickHandler);
  app._checkpointDetailClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (action !== "checkpoint-toggle-effects-mode") return;
    ev.preventDefault();
    setRouteParams({ effects: useRootEffects ? null : "1" });
    await routeTo(getRoute());
  };
  app.addEventListener("click", app._checkpointDetailClickHandler);
}

const TX_LIST_PRESET_DAYS = { "7d": 7, "30d": 30 };
const TX_LIST_LATEST_CHECKPOINT_TTL_MS = 30000;
const TX_LIST_CHECKPOINT_PADDING = 2;
const txListCheckpointTsCache = {};
const txListCheckpointTsInFlight = {};
const txListCheckpointHints = [];
let latestCheckpointHeadCache = { seq: 0, tsMs: NaN, at: 0 };
let latestCheckpointHeadInFlight = null;

function txListNormalizeDateState(state = {}) {
  const rawPreset = String(state.preset || "all");
  const preset = (rawPreset === "7d" || rawPreset === "30d" || rawPreset === "custom") ? rawPreset : "all";
  return {
    preset,
    fromDate: String(state.fromDate || ""),
    toDate: String(state.toDate || ""),
  };
}

function txListDateInputFromMs(ms) {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function txListParseInputDateMs(value, endOfDay = false) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const ts = endOfDay
    ? Date.UTC(y, mo, d, 23, 59, 59, 999)
    : Date.UTC(y, mo, d, 0, 0, 0, 0);
  return Number.isFinite(ts) ? ts : NaN;
}

function txListFormatTokenAmount(v) {
  const raw = String(v ?? "").trim();
  const n = Math.abs(Number(raw || 0));
  if (!Number.isFinite(n)) {
    const m = raw.match(/^[-+]?(\d+)(?:\.(\d+))?$/);
    if (!m) return "0";
    const intPart = (m[1] || "0").replace(/^0+/, "") || "0";
    const fracPart = (m[2] || "").replace(/0+$/, "");
    const len = intPart.length;
    if (len > 12) return `${intPart.slice(0, len - 12)}.${intPart.slice(len - 12, len - 10)}T`;
    if (len > 9) return `${intPart.slice(0, len - 9)}.${intPart.slice(len - 9, len - 7)}B`;
    if (len > 6) return `${intPart.slice(0, len - 6)}.${intPart.slice(len - 6, len - 4)}M`;
    if (len > 3) return `${intPart.slice(0, len - 3)}.${intPart.slice(len - 3, len - 2)}K`;
    return fracPart ? `${intPart}.${fracPart.slice(0, 4)}` : intPart;
  }
  if (n >= 1000000) return fmtCompact(n);
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (n >= 0.0001) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return n.toExponential(2);
}

function parseBigIntSafe(v) {
  try {
    return BigInt(String(v ?? 0));
  } catch (e) {
    return 0n;
  }
}

function pow10BigInt(n) {
  const d = Math.max(0, Math.floor(Number(n || 0)));
  let out = 1n;
  for (let i = 0; i < d; i += 1) out *= 10n;
  return out;
}

function txListRawToApproxAbs(raw, decimals) {
  const bi = parseBigIntSafe(raw);
  const abs = bi < 0n ? -bi : bi;
  const d = Math.max(0, Math.floor(Number(decimals || 0)));
  const scale = pow10BigInt(d);
  const whole = abs / scale;
  const frac = abs % scale;
  let wholeNum = Number(whole);
  if (!Number.isFinite(wholeNum)) wholeNum = Number.MAX_SAFE_INTEGER;
  if (d <= 0) return wholeNum;
  const fracStr = frac.toString().padStart(d, "0").slice(0, 8);
  const fracNum = fracStr ? Number(`0.${fracStr}`) : 0;
  return wholeNum + (Number.isFinite(fracNum) ? fracNum : 0);
}

function txListRawToDecimalText(raw, decimals, maxFrac = 8) {
  const bi = parseBigIntSafe(raw);
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const d = Math.max(0, Math.floor(Number(decimals || 0)));
  const scale = pow10BigInt(d);
  const whole = abs / scale;
  const frac = abs % scale;
  if (d <= 0) return `${neg ? "-" : "+"}${whole.toString()}`;
  let fracStr = frac.toString().padStart(d, "0").slice(0, Math.max(0, maxFrac));
  fracStr = fracStr.replace(/0+$/, "");
  return `${neg ? "-" : "+"}${whole.toString()}${fracStr ? `.${fracStr}` : ""}`;
}

function txListRememberCheckpointHint(tsMs, seq) {
  if (!Number.isFinite(tsMs) || !Number.isFinite(seq)) return;
  const s = Math.max(0, Math.floor(seq));
  const existing = txListCheckpointHints.find((h) => h.seq === s);
  if (existing) {
    existing.tsMs = tsMs;
  } else {
    txListCheckpointHints.push({ tsMs, seq: s });
  }
  txListCheckpointHints.sort((a, b) => a.tsMs - b.tsMs);
  if (txListCheckpointHints.length > 256) txListCheckpointHints.splice(0, txListCheckpointHints.length - 256);
}

function txListSearchBoundsFromHints(targetMs, latestSeq) {
  if (!Number.isFinite(targetMs) || !Number.isFinite(latestSeq) || !txListCheckpointHints.length) {
    return { lo: 0, hi: Math.max(0, Math.floor(Number(latestSeq || 0))) };
  }
  let lower = null;
  let upper = null;
  for (const h of txListCheckpointHints) {
    if (h.tsMs <= targetMs) lower = h;
    if (h.tsMs >= targetMs) { upper = h; break; }
  }
  const lo = lower ? Math.max(0, lower.seq) : 0;
  const hiBase = upper ? upper.seq : Math.max(0, Math.floor(Number(latestSeq || 0)));
  const hi = Math.min(Math.max(0, Math.floor(Number(latestSeq || 0))), Math.max(lo, hiBase));
  return { lo, hi };
}

function txListBuildFlowSummary(balanceChanges, opts = {}) {
  const maxItems = Number.isFinite(opts?.maxItems) ? Math.max(1, Math.floor(opts.maxItems)) : 4;
  const senderScoped = Object.prototype.hasOwnProperty.call(opts || {}, "ownerAddress");
  const ownerNorm = normalizeSuiAddress(opts?.ownerAddress || "");
  const partial = !!opts?.partial;
  const byCoin = {};
  for (const bc of (balanceChanges || [])) {
    if (senderScoped) {
      const bcOwner = normalizeSuiAddress(bc?.owner?.address || "");
      if (!ownerNorm || bcOwner !== ownerNorm) continue;
    }
    const coinType = String(bc?.coinType?.repr || "");
    const raw = parseBigIntSafe(bc?.amount || 0);
    if (!coinType || raw === 0n) continue;
    const meta = resolveCoinType(coinType);
    const decimals = Number(meta?.decimals || 9);
    if (!byCoin[coinType]) {
      byCoin[coinType] = {
        coinType,
        symbol: meta?.symbol || shortType(coinType),
        decimals,
        raw: 0n,
      };
    }
    byCoin[coinType].raw += raw;
  }

  const rows = Object.values(byCoin)
    .map((r) => ({
      ...r,
      absApprox: txListRawToApproxAbs(r.raw, r.decimals),
    }))
    .filter((r) => r.raw !== 0n)
    .sort((a, b) => b.absApprox - a.absApprox);

  if (!rows.length) {
    return {
      hasFlows: false,
      text: senderScoped ? "No sender net token flows" : "No net token flows",
      csv: "",
      partial,
    };
  }

  const partsAll = rows.map((r) => {
    const signed = txListRawToDecimalText(r.raw, r.decimals, 8);
    const sign = signed.startsWith("-") ? "-" : "+";
    const absText = signed.replace(/^[-+]/, "");
    return `${sign}${txListFormatTokenAmount(absText)} ${r.symbol}`;
  });
  const partsShown = partsAll.slice(0, Math.max(1, maxItems));
  const more = partsAll.length > partsShown.length ? `, +${partsAll.length - partsShown.length} more` : "";
  const partialSuffix = partial ? " (partial window)" : "";
  return {
    hasFlows: true,
    text: partsShown.join(", ") + more + partialSuffix,
    csv: partsAll.join(" | ") + (partial ? " | [partial_window]" : ""),
    partial,
  };
}

function txListCsvCell(value) {
  const s = String(value ?? "");
  return `"${s.replace(/"/g, "\"\"")}"`;
}

function txListBuildCsv(rows) {
  const header = [
    "timestamp",
    "digest",
    "checkpoint",
    "sender",
    "status",
    "summary",
    "token_amounts",
    "partial_balance_window",
  ];
  const lines = [header.map(txListCsvCell).join(",")];
  for (const row of (rows || [])) {
    lines.push([
      row.tx?.effects?.timestamp || "",
      row.tx?.digest || "",
      row.tx?.effects?.checkpoint?.sequenceNumber ?? "",
      row.tx?.sender?.address || "",
      row.tx?.effects?.status || "",
      row.summary || "",
      row.flow?.csv || "",
      row.flow?.partial ? "true" : "false",
    ].map(txListCsvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

function txListDownloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function fetchLatestCheckpointHead(force = false) {
  const now = Date.now();
  if (!force
    && Number.isFinite(latestCheckpointHeadCache.seq)
    && Number.isFinite(latestCheckpointHeadCache.tsMs)
    && (now - latestCheckpointHeadCache.at) < TX_LIST_LATEST_CHECKPOINT_TTL_MS) {
    return { ...latestCheckpointHeadCache, fromCache: true };
  }
  if (latestCheckpointHeadInFlight) return latestCheckpointHeadInFlight;
  latestCheckpointHeadInFlight = (async () => {
    const data = await gql(GQL_Q_LATEST_CHECKPOINT);
    const seq = Number(data?.checkpoint?.sequenceNumber || 0);
    const tsMs = parseTsMs(data?.checkpoint?.timestamp);
    latestCheckpointHeadCache = {
      seq: Number.isFinite(seq) ? seq : 0,
      tsMs: Number.isFinite(tsMs) ? tsMs : NaN,
      at: Date.now(),
    };
    return { ...latestCheckpointHeadCache, fromCache: false };
  })().finally(() => { latestCheckpointHeadInFlight = null; });
  return latestCheckpointHeadInFlight;
}

async function txListFetchLatestCheckpointHead(force = false) {
  const head = await fetchLatestCheckpointHead(force);
  txListRememberCheckpointHint(head.tsMs, head.seq);
  return head;
}

async function txListFetchCheckpointTimestampMs(sequenceNumber) {
  const seq = Math.max(0, Math.floor(Number(sequenceNumber || 0)));
  const key = String(seq);
  if (Number.isFinite(txListCheckpointTsCache[key])) return txListCheckpointTsCache[key];
  if (txListCheckpointTsInFlight[key]) return txListCheckpointTsInFlight[key];
  txListCheckpointTsInFlight[key] = (async () => {
    const data = await gql(`query($seq: UInt53) {
      checkpoint(sequenceNumber: $seq) { sequenceNumber timestamp }
    }`, { seq });
    const tsMs = parseTsMs(data?.checkpoint?.timestamp);
    const resolved = Number.isFinite(tsMs) ? tsMs : NaN;
    // Cap cache at 512 entries to prevent unbounded growth during repeated date filter changes
    const cacheKeys = Object.keys(txListCheckpointTsCache);
    if (cacheKeys.length >= 512) { for (const k of cacheKeys.slice(0, 128)) delete txListCheckpointTsCache[k]; }
    txListCheckpointTsCache[key] = resolved;
    if (Number.isFinite(resolved)) txListRememberCheckpointHint(resolved, seq);
    return resolved;
  })().finally(() => {
    delete txListCheckpointTsInFlight[key];
  });
  return txListCheckpointTsInFlight[key];
}

function txListBuildRows(txs) {
  return (txs || []).map((tx) => {
    const intent = analyzeTxIntent(tx);
    const balanceConn = tx?.effects?.balanceChanges;
    const flow = txListBuildFlowSummary(balanceConn?.nodes || [], {
      ownerAddress: tx?.sender?.address || "",
      partial: !!balanceConn?.pageInfo?.hasNextPage,
    });
    return {
      tx,
      intent,
      flow,
      summary: flow.hasFlows ? flow.text : intent.label,
    };
  });
}

async function txListFindCheckpointAtOrAfterMs(targetMs, latestSeq) {
  const hinted = txListSearchBoundsFromHints(targetMs, latestSeq);
  let lo = hinted.lo;
  let hi = hinted.hi;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
    lo = 0;
    hi = Math.max(0, Math.floor(Number(latestSeq || 0)));
  }
  let steps = 0;
  while (lo < hi && steps < 32) {
    steps += 1;
    const mid = Math.floor((lo + hi) / 2);
    const midTs = await txListFetchCheckpointTimestampMs(mid);
    if (!Number.isFinite(midTs)) break;
    if (midTs < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function txListFindCheckpointAtOrBeforeMs(targetMs, latestSeq) {
  const hinted = txListSearchBoundsFromHints(targetMs, latestSeq);
  let lo = hinted.lo;
  let hi = hinted.hi;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
    lo = 0;
    hi = Math.max(0, Math.floor(Number(latestSeq || 0)));
  }
  let steps = 0;
  while (lo < hi && steps < 32) {
    steps += 1;
    const mid = Math.floor((lo + hi + 1) / 2);
    const midTs = await txListFetchCheckpointTimestampMs(mid);
    if (!Number.isFinite(midTs)) break;
    if (midTs <= targetMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function txListEstimateCheckpointForMs(targetMs, latestSeq, latestTsMs) {
  const seqMax = Math.max(0, Math.floor(Number(latestSeq || 0)));
  if (!Number.isFinite(targetMs) || !Number.isFinite(latestTsMs)) return NaN;
  const anchors = txListCheckpointHints
    .map((h) => ({ tsMs: Number(h?.tsMs), seq: Number(h?.seq) }))
    .filter((h) => Number.isFinite(h.tsMs) && Number.isFinite(h.seq))
    .map((h) => ({ tsMs: h.tsMs, seq: Math.max(0, Math.min(seqMax, Math.floor(h.seq))) }));
  anchors.push({ tsMs: latestTsMs, seq: seqMax });
  anchors.sort((a, b) => a.tsMs - b.tsMs);
  const deduped = [];
  for (const row of anchors) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.tsMs === row.tsMs) {
      if (row.seq > prev.seq) prev.seq = row.seq;
      continue;
    }
    deduped.push({ tsMs: row.tsMs, seq: row.seq });
  }
  if (!deduped.length) return NaN;
  const DEFAULT_CPS = 1 / 1000; // ~1 checkpoint per second
  const clampSeq = (v) => Math.max(0, Math.min(seqMax, Math.floor(Number(v) || 0)));
  if (deduped.length === 1) {
    const deltaMs = targetMs - latestTsMs;
    return clampSeq(seqMax + deltaMs * DEFAULT_CPS);
  }
  let left = deduped[0];
  let right = deduped[deduped.length - 1];
  for (let i = 0; i < deduped.length - 1; i += 1) {
    const a = deduped[i];
    const b = deduped[i + 1];
    if (targetMs >= a.tsMs && targetMs <= b.tsMs) {
      left = a;
      right = b;
      break;
    }
    if (targetMs < deduped[0].tsMs) {
      left = deduped[0];
      right = deduped[1];
      break;
    }
    if (targetMs > deduped[deduped.length - 1].tsMs) {
      left = deduped[deduped.length - 2];
      right = deduped[deduped.length - 1];
      break;
    }
  }
  const dt = Number(right.tsMs - left.tsMs);
  if (!Number.isFinite(dt) || dt <= 0) {
    const fallbackDeltaMs = targetMs - latestTsMs;
    return clampSeq(seqMax + fallbackDeltaMs * DEFAULT_CPS);
  }
  const slope = (Number(right.seq) - Number(left.seq)) / dt;
  const estimate = Number(left.seq) + (targetMs - Number(left.tsMs)) * slope;
  return clampSeq(estimate);
}

async function txListResolveDateFilter(state) {
  const normalized = txListNormalizeDateState(state);
  if (normalized.preset === "all") {
    return { filter: null, fromMs: NaN, toMs: NaN, note: "", error: "" };
  }

  let fromMs = NaN;
  let toMs = NaN;
  if (normalized.preset === "custom") {
    if (!normalized.fromDate || !normalized.toDate) {
      return { filter: null, fromMs: NaN, toMs: NaN, note: "", error: "Select both start and end date." };
    }
    fromMs = txListParseInputDateMs(normalized.fromDate, false);
    toMs = txListParseInputDateMs(normalized.toDate, true);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      return { filter: null, fromMs: NaN, toMs: NaN, note: "", error: "Invalid custom date range." };
    }
  } else {
    const days = Number(TX_LIST_PRESET_DAYS[normalized.preset] || 0);
    const now = Date.now();
    toMs = now;
    fromMs = now - (days * 24 * 60 * 60 * 1000);
  }

  const latest = await txListFetchLatestCheckpointHead();
  if (!Number.isFinite(latest.seq) || !Number.isFinite(latest.tsMs) || latest.seq < 0) {
    return { filter: null, fromMs: NaN, toMs: NaN, note: "", error: "Could not resolve latest checkpoint for date filter." };
  }

  const clampedToMs = Math.min(toMs, latest.tsMs);
  const clampedFromMs = Math.min(fromMs, clampedToMs);
  if (normalized.preset === "custom") {
    const [startSeq, endSeq] = await Promise.all([
      txListFindCheckpointAtOrAfterMs(clampedFromMs, latest.seq),
      txListFindCheckpointAtOrBeforeMs(clampedToMs, latest.seq),
    ]);
    const lo = Math.max(0, Math.min(startSeq, endSeq) - TX_LIST_CHECKPOINT_PADDING);
    const hi = Math.min(latest.seq, Math.max(startSeq, endSeq) + TX_LIST_CHECKPOINT_PADDING);
    const note = `Timestamp range mapped to checkpoint bounds ~${fmtNumber(lo)} to ~${fmtNumber(hi)}.`;
    return {
      filter: { afterCheckpoint: lo, beforeCheckpoint: hi },
      fromMs: clampedFromMs,
      toMs: clampedToMs,
      note,
      error: "",
    };
  }

  const estStart = txListEstimateCheckpointForMs(clampedFromMs, latest.seq, latest.tsMs);
  const estEnd = txListEstimateCheckpointForMs(clampedToMs, latest.seq, latest.tsMs);
  if (!Number.isFinite(estStart) || !Number.isFinite(estEnd)) {
    return {
      filter: null,
      fromMs: clampedFromMs,
      toMs: clampedToMs,
      note: "Using client-side timestamp filter (checkpoint estimate unavailable).",
      error: "",
    };
  }
  const pad = TX_LIST_CHECKPOINT_PADDING * 16;
  const lo = Math.max(0, Math.min(estStart, estEnd) - pad);
  const hi = Math.min(latest.seq, Math.max(estStart, estEnd) + pad);
  const note = `Estimated checkpoint window ~${fmtNumber(lo)} to ~${fmtNumber(hi)} from cached timestamp hints.`;
  return {
    filter: { afterCheckpoint: lo, beforeCheckpoint: hi },
    fromMs: clampedFromMs,
    toMs: clampedToMs,
    note,
    error: "",
  };
}

function txListWithinRange(tx, fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return true;
  const ts = parseTsMs(tx?.effects?.timestamp);
  if (!Number.isFinite(ts)) return false;
  return ts >= fromMs && ts <= toMs;
}

// ── Transactions List ───────────────────────────────────────────────────
async function renderTransactions(app, before = null, dateState = null) {
  const state = txListNormalizeDateState(dateState || {});
  const dateFilter = await txListResolveDateFilter(state);

  let txs = [];
  let txLoadError = dateFilter.error || "";
  let pi = { hasPreviousPage: false, startCursor: "", hasNextPage: false, endCursor: "" };
  if (!txLoadError) {
    try {
      const loadPage = () => gql(`query($before: String, $filter: TransactionFilter) {
        transactions(last: 25, before: $before, filter: $filter) {
          pageInfo { hasPreviousPage startCursor hasNextPage endCursor }
          nodes {
            digest
            sender { address }
            kind {
              __typename
              ... on ProgrammableTransaction {
                commands(first: 3) { nodes { __typename ... on MoveCallCommand { function { name module { name package { address } } } } } }
              }
            }
            effects {
              status timestamp
              checkpoint { sequenceNumber }
              gasEffects { gasSummary { computationCost storageCost storageRebate } }
              balanceChanges(first: 50) {
                pageInfo { hasNextPage }
                nodes { ${GQL_F_BAL_NODE} }
              }
              events(first: 3) { nodes { contents { type { repr } } } }
            }
          }
        }
      }`, { before, filter: dateFilter.filter }).then((data) => ({
        nodes: data?.transactions?.nodes || [],
        pageInfo: data?.transactions?.pageInfo || pi,
      }));

      const useCachedFirstPage = !before && state.preset === "all" && !dateFilter.filter;
      const page = useCachedFirstPage
        ? await withTimedCache(transactionsListCache, LIST_PAGE_TTL_MS, false, async () => {
            const result = await loadPage();
            writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.transactionsListFirstPage, result, 90000);
            return result;
          })
        : await loadPage();

      txs = page.nodes.reverse().filter((t) => txListWithinRange(t, dateFilter.fromMs, dateFilter.toMs));
      for (const tx of txs) {
        const seq = Number(tx?.effects?.checkpoint?.sequenceNumber);
        const tsMs = parseTsMs(tx?.effects?.timestamp);
        if (Number.isFinite(seq) && Number.isFinite(tsMs)) txListRememberCheckpointHint(tsMs, seq);
      }
      pi = page.pageInfo || pi;
    } catch (e) {
      txLoadError = e?.message || "Failed to load transactions.";
    }
  }

  const txRows = txListBuildRows(txs);

  const emptyMsg = state.preset === "all"
    ? "No transactions found."
    : "No transactions matched this timestamp range.";
  const tableContent = txLoadError
    ? renderEmpty(`Failed to load transactions: ${escapeHtml(txLoadError)}`)
    : (!txRows.length
      ? renderEmpty(emptyMsg)
      : `<table>
          <thead><tr>
            <th>Digest</th><th>Summary</th><th>Sender</th><th>Checkpoint</th><th>Status</th><th>Time</th>
          </tr></thead>
          <tbody>
            ${txRows.map((row) => `<tr>
              <td>${hashLink(row.tx.digest, '/tx/' + row.tx.digest)}</td>
              <td class="tx-flow-cell">
                <div class="tx-flow-main${row.flow.hasFlows ? "" : " tx-flow-empty"}">${escapeHtml(row.summary)}</div>
                <div class="u-fs11-dim">${renderIntentChip(row.intent)}${row.flow.partial ? ' <span class="tx-flow-partial">partial</span>' : ''}</div>
              </td>
              <td>${row.tx.sender ? hashLink(row.tx.sender.address, '/address/' + row.tx.sender.address) : "—"}</td>
              <td><a class="hash-link" href="#/checkpoint/${row.tx.effects?.checkpoint?.sequenceNumber}">${fmtNumber(row.tx.effects?.checkpoint?.sequenceNumber)}</a></td>
              <td>${statusBadge(row.tx.effects?.status)}</td>
              <td>${timeTag(row.tx.effects?.timestamp)}</td>
            </tr>`).join("")}
          </tbody>
        </table>`);

  app.innerHTML = `
    <div class="page-title">Transactions</div>
    <div class="card">
      <div class="tx-list-toolbar">
        <div class="tx-list-toolbar-left">
          <span class="u-fs12-dim">Timestamp filter</span>
          <select id="tx-list-date-preset" class="ui-control">
            <option value="all" ${state.preset === "all" ? "selected" : ""}>All time</option>
            <option value="7d" ${state.preset === "7d" ? "selected" : ""}>Last 7 days</option>
            <option value="30d" ${state.preset === "30d" ? "selected" : ""}>Last 30 days</option>
            <option value="custom" ${state.preset === "custom" ? "selected" : ""}>Custom</option>
          </select>
          ${state.preset === "custom" ? `<div class="tx-date-custom">
            <input type="date" id="tx-list-date-from" class="ui-control" value="${escapeAttr(state.fromDate)}">
            <span class="u-c-dim">to</span>
            <input type="date" id="tx-list-date-to" class="ui-control" value="${escapeAttr(state.toDate)}">
            <button data-action="tx-list-date-apply" class="btn-surface-sm">Apply</button>
          </div>` : ""}
        </div>
        <div class="tx-list-toolbar-right">
          <button data-action="tx-list-export-csv" class="btn-surface-sm" ${txRows.length ? "" : "disabled"}>Download CSV</button>
        </div>
      </div>
      ${dateFilter.note ? `<div class="tx-filter-note">${escapeHtml(dateFilter.note)}</div>` : ""}
      <div class="card-body">
        ${tableContent}
        ${txLoadError ? "" : `<div class="pagination">
          <button data-action="txs-newer" data-cursor="${escapeAttr(pi.endCursor || "")}"
            ${!pi.hasNextPage ? "disabled" : ""}>Newer</button>
          <button data-action="txs-older" data-cursor="${escapeAttr(pi.startCursor || "")}"
            ${!pi.hasPreviousPage ? "disabled" : ""}>Older</button>
        </div>`}
      </div>
    </div>
  `;

  const presetEl = document.getElementById("tx-list-date-preset");
  if (presetEl) {
    presetEl.onchange = async () => {
      const next = txListNormalizeDateState({
        preset: presetEl.value,
        fromDate: document.getElementById("tx-list-date-from")?.value || state.fromDate,
        toDate: document.getElementById("tx-list-date-to")?.value || state.toDate,
      });
      if (next.preset !== "custom") {
        next.fromDate = "";
        next.toDate = "";
      } else if (!next.fromDate && !next.toDate) {
        const now = Date.now();
        next.toDate = txListDateInputFromMs(now);
        next.fromDate = txListDateInputFromMs(now - 7 * 24 * 60 * 60 * 1000);
      }
      await renderTransactions(app, null, next);
    };
  }

  if (app._txsClickHandler) app.removeEventListener("click", app._txsClickHandler);
  app._txsClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (!action) return;
    ev.preventDefault();
    if (action === "tx-list-export-csv") {
      if (!txRows.length) return;
      const stamp = new Date().toISOString().slice(0, 10);
      txListDownloadCsv(`suigraph-transactions-${stamp}.csv`, txListBuildCsv(txRows));
      return;
    }
    if (action === "tx-list-date-apply") {
      const next = txListNormalizeDateState({
        preset: "custom",
        fromDate: document.getElementById("tx-list-date-from")?.value || "",
        toDate: document.getElementById("tx-list-date-to")?.value || "",
      });
      await renderTransactions(app, null, next);
      return;
    }
    if (action !== "txs-newer" && action !== "txs-older") return;
    if (trigger.hasAttribute("disabled")) return;
    const cursor = trigger.getAttribute("data-cursor") || "";
    await renderTransactions(app, cursor || null, state);
  };
  app.addEventListener("click", app._txsClickHandler);
}

// ── Transaction Detail ──────────────────────────────────────────────────

// Extract the last segment of a type like "0xabc::module::Type<0xdef::m2::T>"
function coinName(repr) {
  if (!repr) return "?";
  // Match the outermost type name
  const m = repr.match(/::(\w+)>*$/);
  return m ? m[1] : shortType(repr);
}

function fmtCoinAmount(amount, coinRepr) {
  const amt = Number(amount);
  // SUI uses 9 decimals, USDC/USDT use 6 — approximate by checking common names
  const name = coinName(coinRepr);
  const isSui = coinRepr?.includes("sui::SUI");
  const decimals = isSui ? 9 : 6; // best guess for non-SUI
  const val = amt / Math.pow(10, decimals);
  const abs = Math.abs(val);
  const formatted = abs < 0.001 ? abs.toExponential(2) : abs.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return { val, abs: formatted, name, sign: amt >= 0 ? "+" : "-", raw: amt };
}

async function fetchTxShell(digest, force = false) {
  const txShellState = getKeyedCacheState(txShellCache, digest);
  return withTimedCache(txShellState, ENTITY_SHELL_TTL_MS, force, async () => gql(`query($digest: String!) {
    transaction(digest: $digest) {
      digest
      sender { address }
      gasInput {
        gasPrice gasBudget
        gasPayment { nodes { address } }
        gasSponsor { address }
      }
      expiration { epochId }
      kind {
        ... on ProgrammableTransaction {
          inputs(first: 30) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on Pure { bytes }
              ... on OwnedOrImmutable { object { address } }
              ... on SharedInput { address initialSharedVersion mutable }
              ... on Receiving { object { address } }
            }
          }
          commands(first: 30) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on MoveCallCommand { function { module { name package { address } } name } }
              ... on TransferObjectsCommand { __typename }
              ... on SplitCoinsCommand { __typename }
              ... on MergeCoinsCommand { __typename }
              ... on PublishCommand { __typename }
              ... on UpgradeCommand { currentPackage }
              ... on MakeMoveVecCommand { __typename }
            }
          }
        }
        ... on ConsensusCommitPrologueTransaction { __typename }
        ... on GenesisTransaction { __typename }
        ... on EndOfEpochTransaction { __typename }
      }
      effects {
        status timestamp
        executionError { message abortCode sourceLineNumber instructionOffset identifier module { name package { address } } function { name } }
        checkpoint { sequenceNumber }
        epoch { epochId }
        gasEffects {
          gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee }
          gasObject { address }
        }
      }
    }
  }`, { digest }));
}

async function fetchObjectShell(idNorm, force = false) {
  const objectShellState = getKeyedCacheState(objectShellCache, idNorm);
  return withTimedCache(objectShellState, ENTITY_SHELL_TTL_MS, force, async () => gql(`query($id: SuiAddress!) {
    object(address: $id) {
      address version digest storageRebate
      owner {
        ${GQL_F_OWNER}
      }
      previousTransaction { digest }
      asMoveObject {
        hasPublicTransfer
        ${GQL_F_CONTENTS_TYPE_JSON}
      }
      asMovePackage {
        modules(first: 1) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }
  }`, { id: idNorm }));
}

async function renderTxDetail(app, digest) {
  const localRouteToken = routeRenderToken;
  const shellData = await fetchTxShell(digest, false);

  let tx = shellData.transaction;
  if (!tx) { app.innerHTML = renderEmpty("Transaction not found."); return; }

  const routeParams = splitRouteAndParams(getRoute()).params;
  let showIntentOverlay = routeParams.get("intent") === "1";
  const useRootEffects = routeParams.get("effects") === "1";
  let effectsSource = useRootEffects ? "root transactionEffects (loading detail)" : "embedded transaction.effects (loading detail)";
  let effectsSourceError = "";
  let detailLoadError = "";
  let effectsDetailState = "loading";
  let detailHydrating = false;
  let eff = tx.effects;

  async function loadEmbeddedEffectsDetail() {
    const data = await gql(`query($digest: String!) {
      transaction(digest: $digest) {
        effects {
          balanceChanges(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              ${GQL_F_BAL_NODE}
            }
          }
          objectChanges(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              address idCreated idDeleted
              inputState { version digest ${GQL_F_MOVE_TYPE} }
              outputState { version digest owner {
                ${GQL_F_OWNER}
              } ${GQL_F_MOVE_TYPE} }
            }
          }
          events(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              ${GQL_F_EVENT_NODE}
            }
          }
        }
      }
    }`, { digest });
    return data?.transaction?.effects || null;
  }

  async function hydrateTxEffectsDetail() {
    try {
      let nextEff = null;
      if (useRootEffects) {
        try {
          const effData = await gql(`query($digest: String!) {
            transactionEffects(digest: $digest) {
              status
              timestamp
              executionError { message abortCode sourceLineNumber instructionOffset identifier module { name package { address } } function { name } }
              checkpoint { sequenceNumber }
              epoch { epochId }
              gasEffects {
                gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee }
                gasObject { address }
              }
              balanceChanges(first: 50) {
                pageInfo { hasNextPage }
                nodes {
                  ${GQL_F_BAL_NODE}
                }
              }
              objectChanges(first: 50) {
                pageInfo { hasNextPage }
                nodes {
                  address idCreated idDeleted
                  inputState { version digest ${GQL_F_MOVE_TYPE} }
                  outputState { version digest owner {
                    ${GQL_F_OWNER}
                  } ${GQL_F_MOVE_TYPE} }
                }
              }
              events(first: 50) {
                pageInfo { hasNextPage }
                nodes {
                  ${GQL_F_EVENT_NODE}
                }
              }
            }
          }`, { digest });
          if (!effData?.transactionEffects) throw new Error("transactionEffects returned null");
          nextEff = effData.transactionEffects;
          effectsSource = "root transactionEffects";
          effectsSourceError = "";
        } catch (e) {
          effectsSourceError = e?.message || "transactionEffects query failed";
          nextEff = await loadEmbeddedEffectsDetail();
          effectsSource = "embedded transaction.effects";
        }
      } else {
        nextEff = await loadEmbeddedEffectsDetail();
        effectsSource = "embedded transaction.effects";
        effectsSourceError = "";
      }
      if (!nextEff) throw new Error("Detailed effects payload unavailable");
      eff = { ...eff, ...nextEff };
      tx = { ...tx, effects: eff };
      effectsDetailState = "loaded";
      detailLoadError = "";

      const coinTypes = (eff?.balanceChanges?.nodes || []).map((b) => b?.coinType?.repr).filter(Boolean);
      const moveCallPkgs = (tx?.kind?.commands?.nodes || [])
        .filter((c) => c.__typename === "MoveCallCommand")
        .map((c) => c.function?.module?.package?.address)
        .filter(Boolean);
      const eventPkgs = (eff?.events?.nodes || []).map((e) => e?.transactionModule?.package?.address).filter(Boolean);
      const allPkgs = [...new Set([...moveCallPkgs, ...eventPkgs])];
      await Promise.allSettled([
        coinTypes.length ? prefetchCoinMeta(coinTypes) : Promise.resolve(),
        allPkgs.length ? resolvePackageNames(allPkgs) : Promise.resolve(),
      ]);
    } catch (e) {
      if (isAbortError(e)) return;
      detailLoadError = e?.message || "Detailed effect query failed";
      effectsDetailState = "error";
      if (!effectsSourceError) effectsSourceError = detailLoadError;
      if (!useRootEffects) effectsSource = "embedded transaction.effects";
    }
    if (!app.isConnected || localRouteToken !== routeRenderToken) return;
    renderTxView();
    setRouteViewCacheEntry(routeCacheKey(getRoute()), app.innerHTML);
    scheduleUiEnhancements();
    scheduleVisibleRouteShellPrefetch(app);
    scheduleVisibleObjectShellPrefetch(app);
  }

  function renderTxView() {
    const detailLoaded = effectsDetailState === "loaded";
    const detailError = effectsDetailState === "error" ? detailLoadError : "";
    const gs = eff?.gasEffects?.gasSummary;
    const gasUsed = gs ? Number(gs.computationCost) + Number(gs.storageCost) - Number(gs.storageRebate) : 0;
    const kind = tx.kind;
    const isPTB = !!(kind?.commands);
    const commandsConn = kind?.commands;
    const inputsConn = kind?.inputs;
    const balancesConn = eff?.balanceChanges;
    const objChangesConn = eff?.objectChanges;
    const eventsConn = eff?.events;
    const commands = commandsConn?.nodes || [];
    const inputs = inputsConn?.nodes || [];
    const balances = balancesConn?.nodes || [];
    const objChanges = objChangesConn?.nodes || [];
    const events = eventsConn?.nodes || [];
    const commandsTruncated = !!commandsConn?.pageInfo?.hasNextPage;
    const inputsTruncated = !!inputsConn?.pageInfo?.hasNextPage;
    const balancesTruncated = !!balancesConn?.pageInfo?.hasNextPage;
    const objectsTruncated = !!objChangesConn?.pageInfo?.hasNextPage;
    const eventsTruncated = !!eventsConn?.pageInfo?.hasNextPage;

    let kindLabel = "System Transaction";
    if (isPTB) kindLabel = "Programmable Transaction";
    else if (kind?.__typename === "ConsensusCommitPrologueTransaction") kindLabel = "Consensus Commit";
    else if (kind?.__typename === "EndOfEpochTransaction") kindLabel = "End of Epoch";

    const moveCalls = commands.filter((c) => c.__typename === "MoveCallCommand");
    const uniqueMovePackages = [...new Set(moveCalls.map((c) => normalizeSuiAddress(c.function?.module?.package?.address || "")).filter(Boolean))];
    const uniqueMoveModules = [...new Set(moveCalls.map((c) => `${normalizeSuiAddress(c.function?.module?.package?.address || "")}::${c.function?.module?.name || ""}`).filter((s) => !s.endsWith("::")))];
    const uniqueMoveFunctions = [...new Set(moveCalls.map((c) => `${normalizeSuiAddress(c.function?.module?.package?.address || "")}::${c.function?.module?.name || ""}::${c.function?.name || ""}`).filter((s) => !s.endsWith("::")))];
    const uniqueEventTypes = [...new Set(events.map((e) => e?.contents?.type?.repr).filter(Boolean))].length;

    const txIntent = analyzeTxIntent(tx);

    function deriveStructuralSummary() {
      if (!isPTB) return kindLabel;
      const packages = new Set(moveCalls.map((c) => normalizeSuiAddress(c.function?.module?.package?.address || "")).filter(Boolean));
      if (!detailLoaded) {
        return `${commands.length} commands · ${moveCalls.length} move calls · ${packages.size} packages`;
      }
      return `${commands.length} commands · ${moveCalls.length} move calls · ${packages.size} packages · ${objChanges.length} object changes · ${events.length} events`;
    }

    function deriveIntentSummary() {
      if (!isPTB) return kindLabel;
      const transfers = commands.filter((c) => c.__typename === "TransferObjectsCommand");
      const splits = commands.filter((c) => c.__typename === "SplitCoinsCommand");
      const merges = commands.filter((c) => c.__typename === "MergeCoinsCommand");
      const publishes = commands.filter((c) => c.__typename === "PublishCommand");
      const modules = [...new Set(moveCalls.map((c) => c.function?.module?.name).filter(Boolean))];
      const funcs = [...new Set(moveCalls.map((c) => c.function?.name).filter(Boolean))];
      if (publishes.length) return `Published ${publishes.length} package${publishes.length > 1 ? "s" : ""}`;
      if (moveCalls.length === 0 && transfers.length) return `Transferred objects to ${transfers.length} recipient${transfers.length > 1 ? "s" : ""}`;
      if (moveCalls.length === 0 && splits.length) return "Split coins";
      if (moveCalls.length === 0 && merges.length) return "Merged coins";
      if (moveCalls.length === 1) {
        const pkg = moveCalls[0].function?.module?.package?.address;
        const mvrPkg = pkg && mvrNameCache[pkg] ? `@${mvrNameCache[pkg]}` : "";
        return `Called ${mvrPkg ? mvrPkg + "::" : ""}${modules[0]}::${funcs[0]}`;
      }
      if (modules.length === 1) {
        const pkg = moveCalls[0].function?.module?.package?.address;
        const mvrPkg = pkg && mvrNameCache[pkg] ? `@${mvrNameCache[pkg]}` : "";
        return `${moveCalls.length} calls to ${mvrPkg ? mvrPkg + "::" : ""}${modules[0]} (${funcs.slice(0, 3).join(", ")}${funcs.length > 3 ? "..." : ""})`;
      }
      return `${commands.length} commands across ${modules.length} modules`;
    }

    const created = objChanges.filter((o) => o.idCreated);
    const mutated = objChanges.filter((o) => !o.idCreated && !o.idDeleted);
    const deleted = objChanges.filter((o) => o.idDeleted);
    const commandMix = isPTB ? (() => {
      const counts = {};
      for (const c of commands) {
        const key = String(c?.__typename || "Other").replace("Command", "");
        counts[key] = (counts[key] || 0) + 1;
      }
      return Object.entries(counts).map(([label, value], i) => ({
        label,
        value,
        color: ["var(--accent)", "var(--green)", "var(--blue)", "var(--purple)", "var(--yellow)", "var(--red)"][i % 6],
      }));
    })() : [];
    const objectMix = [
      { label: "Created", value: created.length, color: "var(--green)" },
      { label: "Mutated", value: mutated.length, color: "var(--accent)" },
      { label: "Deleted", value: deleted.length, color: "var(--red)" },
    ];
    const truncatedNotes = [
      commandsTruncated ? "commands" : "",
      inputsTruncated ? "inputs" : "",
      detailLoaded && balancesTruncated ? "balance changes" : "",
      detailLoaded && objectsTruncated ? "object changes" : "",
      detailLoaded && eventsTruncated ? "events" : "",
    ].filter(Boolean);

    function isSuiCoinType(coinType) {
      return String(coinType || "").toLowerCase().includes("::sui::sui");
    }

    function resolveCoinMetaForTx(coinType) {
      const meta = coinType ? coinMetaCache[coinType] : null;
      if (meta && Number.isFinite(Number(meta.decimals))) {
        return {
          symbol: String(meta.symbol || coinName(coinType) || "?"),
          decimals: Number(meta.decimals),
          source: "coinMetadata",
        };
      }
      const known = coinType ? KNOWN_COIN_TYPES[coinType] : null;
      if (known) {
        return {
          symbol: String(known.symbol || coinName(coinType) || "?"),
          decimals: Number(known.decimals || 9),
          source: "knownRegistry",
        };
      }
      const sym = coinType ? (coinType.split("::").pop() || "?") : "?";
      return {
        symbol: sym,
        decimals: COMMON_DECIMALS[sym] || 9,
        source: "fallbackGuess",
      };
    }

    function decimalsSourceLabel(source) {
      if (source === "coinMetadata") return "on-chain";
      if (source === "knownRegistry") return "known";
      return "fallback";
    }

    function fmtRawCoinValue(raw, coinType, opts = {}) {
      const signed = !!opts.signed;
      const resolved = resolveCoinMetaForTx(coinType);
      const decimals = resolved.decimals || 9;
      const n = Number(raw || 0) / Math.pow(10, decimals);
      const abs = Math.abs(n);
      const text = abs < 0.001 && abs > 0
        ? abs.toExponential(2)
        : abs.toLocaleString(undefined, { maximumFractionDigits: 6 });
      const sign = signed ? (n >= 0 ? "+" : "-") : "";
      return `${sign}${text} ${resolved.symbol}`;
    }

    function ownerLinkOrText(owner) {
      if (!owner || owner === "unknown") return '<span class="u-c-dim">unknown</span>';
      return hashLink(owner, '/address/' + owner);
    }

    function ownerStateLabel(owner) {
      if (!owner) return '<span class="u-c-dim">—</span>';
      if (owner?.address?.address) return hashLink(owner.address.address, '/address/' + owner.address.address);
      if (owner?.initialSharedVersion != null) return '<span class="u-c-dim">Shared</span>';
      if (owner?.__typename === "Immutable") return '<span class="u-c-dim">Immutable</span>';
      return '<span class="u-c-dim">—</span>';
    }

    const ownersImpactedSet = new Set();
    for (const b of balances) {
      const owner = normalizeSuiAddress(b?.owner?.address || "");
      if (owner) ownersImpactedSet.add(owner);
    }
    for (const o of objChanges) {
      const owner = normalizeSuiAddress(o?.outputState?.owner?.address?.address || "");
      if (owner) ownersImpactedSet.add(owner);
    }
    const ownersImpacted = ownersImpactedSet.size;

    const moveTargetMap = {};
    for (const c of moveCalls) {
      const pkg = normalizeSuiAddress(c.function?.module?.package?.address || "");
      const mod = String(c.function?.module?.name || "");
      const fn = String(c.function?.name || "");
      const key = `${pkg}|${mod}|${fn}`;
      if (!moveTargetMap[key]) moveTargetMap[key] = { pkg, mod, fn, count: 0 };
      moveTargetMap[key].count++;
    }
    const moveTargetRows = Object.values(moveTargetMap).sort((a, b) => b.count - a.count);

    const eventSummaryMap = {};
    for (const ev of events) {
      const typeRepr = String(ev?.contents?.type?.repr || "");
      const modPkg = normalizeSuiAddress(ev?.transactionModule?.package?.address || "");
      const modName = String(ev?.transactionModule?.name || "");
      const key = `${typeRepr}|${modPkg}|${modName}`;
      if (!eventSummaryMap[key]) {
        eventSummaryMap[key] = { typeRepr, modPkg, modName, count: 0, keyCounts: {} };
      }
      const row = eventSummaryMap[key];
      row.count++;
      const j = ev?.contents?.json;
      if (j && typeof j === "object" && !Array.isArray(j)) {
        for (const k of Object.keys(j)) row.keyCounts[k] = (row.keyCounts[k] || 0) + 1;
      }
    }
    const eventSummaryRows = Object.values(eventSummaryMap)
      .map((r) => ({
        ...r,
        keyFields: Object.entries(r.keyCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k),
      }))
      .sort((a, b) => b.count - a.count);

    const balanceFlowMap = {};
    for (const b of balances) {
      const coinType = b?.coinType?.repr;
      const amountRaw = Number(b?.amount || 0);
      if (!coinType || !Number.isFinite(amountRaw) || amountRaw === 0) continue;
      if (!balanceFlowMap[coinType]) {
        balanceFlowMap[coinType] = {
          coinType,
          inRaw: 0,
          outRaw: 0,
          netRaw: 0,
          toOwners: {},
          fromOwners: {},
        };
      }
      const row = balanceFlowMap[coinType];
      const owner = normalizeSuiAddress(b?.owner?.address || "") || "unknown";
      row.netRaw += amountRaw;
      if (amountRaw > 0) {
        row.inRaw += amountRaw;
        row.toOwners[owner] = (row.toOwners[owner] || 0) + amountRaw;
      } else {
        const outRaw = Math.abs(amountRaw);
        row.outRaw += outRaw;
        row.fromOwners[owner] = (row.fromOwners[owner] || 0) + outRaw;
      }
    }
    const balanceFlowRows = Object.values(balanceFlowMap).sort((a, b) => Math.max(b.inRaw, b.outRaw) - Math.max(a.inRaw, a.outRaw));
    const flowMetaCoverage = { total: 0, coinMetadata: 0, knownRegistry: 0, fallbackGuess: 0 };
    for (const r of balanceFlowRows) {
      const meta = resolveCoinMetaForTx(r.coinType);
      flowMetaCoverage.total++;
      flowMetaCoverage[meta.source] = (flowMetaCoverage[meta.source] || 0) + 1;
    }
    const senderAddr = normalizeSuiAddress(tx?.sender?.address || "");
    const gasPayerAddr = normalizeSuiAddress(tx?.gasInput?.gasSponsor?.address || tx?.sender?.address || "");
    const hasSuiFlow = balanceFlowRows.some((r) => isSuiCoinType(r.coinType));
    const gasAdjApplied = hasSuiFlow && Number(gasUsed) > 0 && !!gasPayerAddr;

    function adjustedFlowRow(row) {
      const outRaw = Number(row?.outRaw || 0);
      const inRaw = Number(row?.inRaw || 0);
      const netRaw = Number(row?.netRaw || 0);
      let outTransferRaw = outRaw;
      let netTransferRaw = netRaw;
      const fromOwnersTransfer = { ...(row?.fromOwners || {}) };
      if (isSuiCoinType(row?.coinType) && gasAdjApplied) {
        outTransferRaw = Math.max(0, outRaw - gasUsed);
        netTransferRaw = netRaw + gasUsed;
        if (gasPayerAddr && fromOwnersTransfer[gasPayerAddr] != null) {
          fromOwnersTransfer[gasPayerAddr] = Math.max(0, Number(fromOwnersTransfer[gasPayerAddr] || 0) - gasUsed);
          if (fromOwnersTransfer[gasPayerAddr] === 0) delete fromOwnersTransfer[gasPayerAddr];
        }
      }
      return {
        outRaw,
        inRaw,
        netRaw,
        outTransferRaw,
        netTransferRaw,
        fromOwnersTransfer,
        toOwnersTransfer: { ...(row?.toOwners || {}) },
      };
    }

    function topOwnerFlowTags(ownerMap, coinType) {
      const rows = Object.entries(ownerMap || {}).sort((a, b) => b[1] - a[1]).slice(0, 2);
      if (!rows.length) return '<span class="tx-label-dim">—</span>';
      return rows.map(([owner, raw]) => `
        <div class="tx-owner-flow-row">
          ${ownerLinkOrText(owner)}
          <span class="tx-owner-flow-amt">(${fmtRawCoinValue(raw, coinType)})</span>
        </div>
      `).join("");
    }

    const objectLifecycleRows = objChanges.map((o) => {
      const typeRepr = o?.outputState?.asMoveObject?.contents?.type?.repr || o?.inputState?.asMoveObject?.contents?.type?.repr || "";
      const change = o?.idCreated ? "Created" : (o?.idDeleted ? "Deleted" : "Mutated");
      return {
        address: o?.address || o?.idCreated || o?.idDeleted || "",
        change,
        typeRepr,
        versionIn: o?.inputState?.version,
        versionOut: o?.outputState?.version,
        ownerAfter: o?.outputState?.owner || null,
      };
    });

    let senderSuiDeltaRaw = 0;
    let gasPayerSuiDeltaRaw = 0;
    for (const b of balances) {
      if (!isSuiCoinType(b?.coinType?.repr)) continue;
      const owner = normalizeSuiAddress(b?.owner?.address || "");
      const amt = Number(b?.amount || 0);
      if (!Number.isFinite(amt) || !owner) continue;
      if (owner === senderAddr) senderSuiDeltaRaw += amt;
      if (owner === gasPayerAddr) gasPayerSuiDeltaRaw += amt;
    }
    const senderSuiDeltaExGasRaw = (senderAddr && gasPayerAddr === senderAddr)
      ? senderSuiDeltaRaw + gasUsed
      : senderSuiDeltaRaw;
    const gasPayerSuiDeltaExGasRaw = gasPayerAddr
      ? (gasPayerSuiDeltaRaw + gasUsed)
      : 0;

    function renderDeferredTxCard(title) {
      const msg = detailError
        ? `Detailed effect sections unavailable: ${escapeHtml(detailError)}`
        : "Loading balance, object, and event detail...";
      return `
        <div class="card tx-card">
          <div class="card-header">${title} <span class="type-tag">${detailError ? "Unavailable" : "Hydrating"}</span></div>
          <div class="card-body">${detailError ? renderEmpty(msg) : renderLoading()}</div>
        </div>
      `;
    }

    function renderDeferredSectionContent(label) {
      if (detailError) return renderEmpty(`Failed to load ${label}: ${escapeHtml(detailError)}`);
      return renderLoading();
    }

    function renderExecutionOverviewCard() {
      if (!detailLoaded) return renderDeferredTxCard("Execution Overview");
      return `
        <div class="card tx-card">
          <div class="card-header">Execution Overview <span class="type-tag">Deterministic</span></div>
          <div class="card-body tx-card-body-pad">
            <div class="tx-overview-help">Tap any count card to expand the matching detail section.</div>
            <div class="stats-grid tx-overview-grid">
              <div class="stat-box stat-box-action">
                <div class="stat-label">Commands</div>
                <div class="stat-value">${fmtNumber(commands.length)}</div>
                <div class="stat-sub">${isPTB ? "programmable tx" : "system tx"}</div>
                <button type="button" class="stat-action-btn" data-action="tx-drill" data-section="sec-commands" ${!isPTB ? "disabled" : ""}>Expand</button>
              </div>
              <div class="stat-box stat-box-action">
                <div class="stat-label">Move Calls</div>
                <div class="stat-value">${fmtNumber(moveCalls.length)}</div>
                <div class="stat-sub">${fmtNumber(uniqueMoveFunctions.length)} unique functions</div>
                <button type="button" class="stat-action-btn" data-action="tx-drill" data-section="sec-commands" ${!moveCalls.length ? "disabled" : ""}>Expand</button>
              </div>
              <div class="stat-box stat-box-action">
                <div class="stat-label">Packages Touched</div>
                <div class="stat-value">${fmtNumber(uniqueMovePackages.length)}</div>
                <div class="stat-sub">${fmtNumber(uniqueMoveModules.length)} modules</div>
                <button type="button" class="stat-action-btn" data-action="tx-drill" data-section="sec-commands" data-overview="tx-ov-move-targets" ${!uniqueMovePackages.length ? "disabled" : ""}>Expand</button>
              </div>
              <div class="stat-box stat-box-action">
                <div class="stat-label">Objects Changed</div>
                <div class="stat-value">${fmtNumber(objChanges.length)}</div>
                <div class="stat-sub">${fmtNumber(created.length)} created · ${fmtNumber(mutated.length)} mutated · ${fmtNumber(deleted.length)} deleted</div>
                <button type="button" class="stat-action-btn" data-action="tx-drill" data-section="sec-objects" ${!objChanges.length ? "disabled" : ""}>Expand</button>
              </div>
              <div class="stat-box stat-box-action">
                <div class="stat-label">Events</div>
                <div class="stat-value">${fmtNumber(events.length)}</div>
                <div class="stat-sub">${fmtNumber(uniqueEventTypes)} unique event types</div>
                <button type="button" class="stat-action-btn" data-action="tx-drill" data-section="sec-events" ${!events.length ? "disabled" : ""}>Expand</button>
              </div>
              <div class="stat-box stat-box-action">
                <div class="stat-label">Owners Impacted</div>
                <div class="stat-value">${fmtNumber(ownersImpacted)}</div>
                <div class="stat-sub">from balances + object owners</div>
                <button type="button" class="stat-action-btn" data-action="tx-drill" data-section="sec-balances" ${!ownersImpacted ? "disabled" : ""}>Expand</button>
              </div>
            </div>
            ${moveTargetRows.length ? `<details class="tx-overview-detail" id="tx-ov-move-targets">
              <summary>Move Target Breakdown <span class="tx-section-count">${fmtNumber(moveTargetRows.length)} targets</span></summary>
              <div class="tx-overview-detail-body">
                <table>
                  <thead><tr><th>Move Target</th><th>Package</th><th class="tx-cell-mono-right">Calls</th></tr></thead>
                  <tbody>
                    ${moveTargetRows.slice(0, 10).map((r) => {
                      const pkgName = mvrNameCache[r.pkg] ? '@' + mvrNameCache[r.pkg] : "";
                      return `<tr>
                        <td class="tx-cell-mono-left-small">${escapeHtml(r.mod)}::${escapeHtml(r.fn)}</td>
                        <td>${pkgName ? `<span class="tx-pkg-name">${escapeHtml(pkgName)}</span> ` : ""}${r.pkg ? hashLink(r.pkg, '/object/' + r.pkg) : '<span class="tx-label-dim">—</span>'}</td>
                        <td class="tx-cell-mono-right">${fmtNumber(r.count)}</td>
                      </tr>`;
                    }).join("")}
                  </tbody>
                </table>
              </div>
            </details>` : '<div class="tx-overview-no-data">No move-call targets in this transaction.</div>'}
          </div>
        </div>
      `;
    }

    function renderBalanceFlowMatrixCard() {
      if (!detailLoaded) return renderDeferredTxCard("Balance Flow Matrix");
      return `
        <div class="card tx-card">
          <div class="card-header">Balance Flow Matrix <span class="type-tag">By Coin</span></div>
          <div class="card-body">
            <div class="tx-balance-note">
              Decimal normalization: ${fmtNumber(flowMetaCoverage.coinMetadata || 0)}/${fmtNumber(flowMetaCoverage.total || 0)} coin types from on-chain metadata, ${fmtNumber(flowMetaCoverage.knownRegistry || 0)} known mappings, ${fmtNumber(flowMetaCoverage.fallbackGuess || 0)} fallback guesses.
              ${gasAdjApplied ? ` SUI transfer columns exclude gas burn (${fmtSui(gasUsed)}) for payer ${ownerLinkOrText(gasPayerAddr)}.` : ""}
            </div>
            ${balanceFlowRows.length ? `<table>
              <thead><tr><th>Coin</th><th class="tx-cell-mono-right">Decimals</th><th class="tx-cell-mono-right">Outflow (Transfer)</th><th class="tx-cell-mono-right">Inflow</th><th class="tx-cell-mono-right">Net (Transfer)</th><th class="tx-cell-mono-right">Net (Raw)</th><th>Top Senders (Transfer)</th><th>Top Receivers</th></tr></thead>
              <tbody>
                ${balanceFlowRows.map((r) => {
                  const resolved = resolveCoinMetaForTx(r.coinType);
                  const adj = adjustedFlowRow(r);
                  const transferNetColor = adj.netTransferRaw > 0 ? "var(--green)" : (adj.netTransferRaw < 0 ? "var(--red)" : "var(--text)");
                  const rawNetColor = adj.netRaw > 0 ? "var(--green)" : (adj.netRaw < 0 ? "var(--red)" : "var(--text)");
                  return `<tr>
                    <td><span class="u-fw-600">${escapeHtml(resolved.symbol)}</span></td>
                    <td class="tx-cell-mono-right">${fmtNumber(resolved.decimals)}<div class="tx-cell-mono-dim">${decimalsSourceLabel(resolved.source)}</div></td>
                    <td class="tx-cell-mono-right">${fmtRawCoinValue(adj.outTransferRaw, r.coinType)}</td>
                    <td class="tx-cell-mono-right">${fmtRawCoinValue(adj.inRaw, r.coinType)}</td>
                    <td class="tx-cell-mono-right" style="color:${transferNetColor}">${fmtRawCoinValue(adj.netTransferRaw, r.coinType, { signed: true })}</td>
                    <td class="tx-cell-mono-right" style="color:${rawNetColor}">${fmtRawCoinValue(adj.netRaw, r.coinType, { signed: true })}</td>
                    <td>${topOwnerFlowTags(adj.fromOwnersTransfer, r.coinType)}</td>
                    <td>${topOwnerFlowTags(adj.toOwnersTransfer, r.coinType)}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>` : renderEmpty("No balance changes to summarize.")}
          </div>
        </div>
      `;
    }

    function renderObjectLifecycleCard() {
      if (!detailLoaded) return renderDeferredTxCard("Object Lifecycle");
      return `
        <div class="card tx-card">
          <div class="card-header">Object Lifecycle <span class="type-tag">Version + Owner</span></div>
          <div class="card-body">
            ${objectLifecycleRows.length ? `<table>
              <thead><tr><th>Object</th><th>Change</th><th>Type</th><th>Version</th><th>Owner After</th></tr></thead>
              <tbody>
                ${objectLifecycleRows.slice(0, 80).map((r) => {
                  const badge = r.change === "Created" ? '<span class="badge badge-success">Created</span>'
                    : (r.change === "Deleted" ? '<span class="badge badge-fail">Deleted</span>' : '<span class="badge">Mutated</span>');
                  const ver = (r.versionIn != null || r.versionOut != null)
                    ? `v${r.versionIn ?? "?"} -> v${r.versionOut ?? "?"}`
                    : "—";
                  return `<tr>
                    <td>${r.address ? hashLink(r.address, '/object/' + r.address) : '<span class="tx-label-dim">—</span>'}</td>
                    <td>${badge}</td>
                    <td class="tx-cell-type-dim">${escapeHtml(shortType(r.typeRepr || "")) || "—"}</td>
                    <td class="tx-cell-mono-left-small">${ver}</td>
                    <td>${ownerStateLabel(r.ownerAfter)}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>` : renderEmpty("No object lifecycle changes in this transaction.")}
          </div>
        </div>
      `;
    }

    function renderEventOutcomeCard() {
      if (!detailLoaded) return renderDeferredTxCard("Event Outcomes");
      return `
        <div class="card tx-card">
          <div class="card-header">Event Outcomes <span class="type-tag">Grouped</span></div>
          <div class="card-body">
            ${eventSummaryRows.length ? `<table>
              <thead><tr><th>Event Type</th><th>Module</th><th class="tx-cell-mono-right">Count</th><th>Top JSON Keys</th></tr></thead>
              <tbody>
                ${eventSummaryRows.slice(0, 50).map((r) => {
                  const modPkgName = r.modPkg && mvrNameCache[r.modPkg] ? '@' + mvrNameCache[r.modPkg] : "";
                  const modLabel = r.modName ? `${modPkgName ? modPkgName + "::" : ""}${r.modName}` : (modPkgName || "—");
                  return `<tr>
                    <td class="tx-cell-type-dim">${escapeHtml(shortType(r.typeRepr || "") || r.typeRepr || "—")}</td>
                    <td>${r.modPkg ? `${r.modPkg ? hashLink(r.modPkg, '/object/' + r.modPkg) : ""}<div class="tx-cell-mono-dim">${escapeHtml(modLabel)}</div>` : `<span class="tx-label-dim">${escapeHtml(modLabel)}</span>`}</td>
                    <td class="tx-cell-mono-right">${fmtNumber(r.count)}</td>
                    <td class="tx-cell-mono-dim">${r.keyFields.length ? escapeHtml(r.keyFields.join(", ")) : "—"}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>` : renderEmpty("No events emitted in this transaction.")}
          </div>
        </div>
      `;
    }

    const failed = eff?.status !== "SUCCESS";
    const statusColor = failed ? "var(--red)" : "var(--green)";
    const statusIcon = failed ? "&#x2717;" : "&#x2713;";
    const effectsModeLabel = effectsSource.startsWith("root") ? "root" : "embedded";
    const effectsSourceSummary = detailLoaded
      ? `Effects source: ${escapeHtml(effectsSource)}${effectsSourceError ? ` · ${escapeHtml(effectsSourceError)} (fallback active)` : ""}`
      : (detailError
        ? `Effects source: ${escapeHtml(effectsSource)}${effectsSourceError ? ` · ${escapeHtml(effectsSourceError)} (fallback active)` : ""} · detailed sections unavailable: ${escapeHtml(detailError)}`
        : `Effects source: ${escapeHtml(effectsSource)} · loading balance, object, and event detail`);

    function section(id, title, count, defaultOpen, content, opts = {}) {
      const open = defaultOpen ? "open" : "";
      return `<details class="tx-section" id="${id}" ${open}>
        <summary class="tx-section-head">
          <span>${title}${opts.truncated ? '<span class="trunc-note">Partial</span>' : ""}</span>
          ${count != null ? `<span class="tx-section-count">${count}</span>` : ""}
        </summary>
        <div class="tx-section-body">${content}</div>
      </details>`;
    }

    function renderCommands() {
      if (!commands.length) return '<div class="empty">System transaction — no PTB commands</div>';
      return commands.map((cmd, i) => {
        const tn = cmd.__typename;
        if (tn === "MoveCallCommand") {
          const fn = cmd.function;
          const pkg = fn?.module?.package?.address || "";
          const mod = fn?.module?.name || "";
          const fname = fn?.name || "";
          const mvrName = mvrNameCache[pkg];
          const pkgDisplay = mvrName
            ? `<a href="#/object/${pkg}" class="hash-link" title="${pkg}" style="color:var(--accent);font-weight:500">@${mvrName}</a>`
            : hashLink(pkg, '/object/' + pkg);
          return `<div class="cmd-card cmd-movecall">
            <div class="cmd-index">${i}</div>
            <div class="cmd-body">
              <div class="cmd-type">MoveCall</div>
              <div class="cmd-target">${pkgDisplay}<span class="cmd-sep">::</span>${mod}<span class="cmd-sep">::</span><span class="cmd-fn">${fname}</span></div>
            </div>
          </div>`;
        }
        const labels = {
          TransferObjectsCommand: "TransferObjects",
          SplitCoinsCommand: "SplitCoins",
          MergeCoinsCommand: "MergeCoins",
          PublishCommand: "Publish",
          UpgradeCommand: "Upgrade",
          MakeMoveVecCommand: "MakeMoveVec",
        };
        const label = labels[tn] || tn?.replace("Command", "") || "Unknown";
        let extra = "";
        if (tn === "UpgradeCommand" && cmd.currentPackage) {
          extra = `<div class="cmd-target">Package: ${hashLink(cmd.currentPackage, '/object/' + cmd.currentPackage)}</div>`;
        }
        return `<div class="cmd-card cmd-other">
          <div class="cmd-index">${i}</div>
          <div class="cmd-body">
            <div class="cmd-type">${label}</div>
            ${extra}
          </div>
        </div>`;
      }).join("");
    }

    function renderInputs() {
      if (!inputs.length) return '<div class="empty">No inputs</div>';
      return `<div class="inputs-grid">${inputs.map((inp, i) => {
        const tn = inp.__typename;
        if (tn === "Pure") {
          return `<div class="input-chip" title="${inp.bytes}"><span class="input-idx">${i}</span> <span class="input-type">Pure</span> <span class="input-val">${truncHash(inp.bytes, 6)}</span></div>`;
        }
        if (tn === "OwnedOrImmutable") {
          const addr = inp.object?.address || "";
          return `<div class="input-chip"><span class="input-idx">${i}</span> <span class="input-type">Object</span> ${hashLink(addr, '/object/' + addr)}</div>`;
        }
        if (tn === "SharedInput") {
          return `<div class="input-chip"><span class="input-idx">${i}</span> <span class="input-type">Shared${inp.mutable ? "" : " (ro)"}</span> ${hashLink(inp.address, '/object/' + inp.address)}</div>`;
        }
        if (tn === "Receiving") {
          const addr = inp.object?.address || "";
          return `<div class="input-chip"><span class="input-idx">${i}</span> <span class="input-type">Receiving</span> ${hashLink(addr, '/object/' + addr)}</div>`;
        }
        if (tn === "MoveValue") {
          return `<div class="input-chip"><span class="input-idx">${i}</span> <span class="input-type">MoveValue</span></div>`;
        }
        return `<div class="input-chip"><span class="input-idx">${i}</span> ${tn || "?"}</div>`;
      }).join("")}</div>`;
    }

    function renderBalances() {
      if (!detailLoaded) return renderDeferredSectionContent("balance changes");
      if (!balances.length) return '<div class="empty">No balance changes</div>';
      const byOwner = {};
      balances.forEach((b) => {
        const owner = b.owner?.address || "unknown";
        if (!byOwner[owner]) byOwner[owner] = [];
        byOwner[owner].push(b);
      });
      return Object.entries(byOwner).map(([owner, bals]) => {
        const isSender = owner === tx.sender?.address;
        return `<div class="bal-group">
          <div class="bal-owner">${ownerLinkOrText(owner)}${isSender ? ' <span class="bal-sender-tag">sender</span>' : ""}</div>
          ${bals.map((b) => {
            const c = fmtCoinWithMeta(b.amount, b.coinType?.repr);
            const color = c.raw >= 0 ? "var(--green)" : "var(--red)";
            return `<div class="bal-row">
              <span class="bal-amount" style="color:${color}">${c.sign}${c.abs}</span>
              <span class="bal-coin">${c.name}</span>
            </div>`;
          }).join("")}
        </div>`;
      }).join("");
    }

    function renderObjectGroup(items, label, badgeClass) {
      if (!items.length) return "";
      return `<div class="obj-group">
        <div class="obj-group-label"><span class="badge ${badgeClass}">${label}</span> <span class="tx-section-count">${items.length}</span></div>
        ${items.map((o) => {
          const type = o.outputState?.asMoveObject?.contents?.type?.repr
            || o.inputState?.asMoveObject?.contents?.type?.repr || "";
          const vIn = o.inputState?.version;
          const vOut = o.outputState?.version;
          const ownerOut = o.outputState?.owner;
          let ownerStr = "";
          if (ownerOut?.address?.address) ownerStr = truncHash(ownerOut.address.address, 6);
          else if (ownerOut?.initialSharedVersion != null) ownerStr = "Shared";
          else if (ownerOut?.__typename === "Immutable") ownerStr = "Immutable";
          return `<div class="obj-change-row">
            <div class="obj-change-id">${hashLink(o.address, '/object/' + o.address)}</div>
            <div class="obj-change-type">${shortType(type)}</div>
            ${vIn || vOut ? `<div class="obj-change-ver">v${vIn ?? "?"} &rarr; v${vOut ?? "?"}</div>` : ""}
            ${ownerStr ? `<div class="obj-change-owner">${ownerStr}</div>` : ""}
          </div>`;
        }).join("")}
      </div>`;
    }

    function renderObjects() {
      if (!detailLoaded) return renderDeferredSectionContent("object changes");
      if (!objChanges.length) return '<div class="empty">No object changes</div>';
      return renderObjectGroup(created, "Created", "badge-success")
        + renderObjectGroup(mutated, "Mutated", "")
        + renderObjectGroup(deleted, "Deleted", "badge-fail");
    }

    function renderEvents() {
      if (!detailLoaded) return renderDeferredSectionContent("events");
      if (!events.length) return '<div class="empty">No events emitted</div>';
      return events.map((ev, i) => {
        const etype = shortType(ev.contents?.type?.repr);
        const mod = ev.transactionModule;
        const modPkg = mod?.package?.address;
        const modLabel = mod ? `${mvrNameCache[modPkg] ? '@' + mvrNameCache[modPkg] : truncHash(modPkg)}::${mod.name}` : "";
        return `<details class="event-item">
          <summary class="event-head">
            <span class="event-idx">${i}</span>
            <span class="event-type">${etype}</span>
            ${modLabel ? `<span class="tx-event-mod-label">${modLabel}</span>` : ""}
          </summary>
          <div class="tx-event-json-wrap">${ev.contents?.json ? jsonTreeBlock(ev.contents.json, 300) : '<span class="jtree-null">null</span>'}</div>
        </details>`;
      }).join("");
    }

    app.innerHTML = `
      <div class="tx-banner-controls">
        ${copyLinkBtn()}${viewQueryBtn('transaction', { digest })}
        <button id="tx-effects-mode-toggle" class="tx-intent-toggle-btn" data-action="tx-toggle-effects-mode">${useRootEffects ? "Effects Source: Root" : "Effects Source: Embedded"}</button>
        <button id="tx-intent-toggle" class="tx-intent-toggle-btn" data-action="tx-toggle-intent">${showIntentOverlay ? "Intent Overlay: On" : "Intent Overlay: Off"}</button>
      </div>
      <div class="tx-banner tx-banner-shadow${failed ? ' tx-failed' : ''}">
        <div class="tx-status-icon" style="background:${failed ? 'rgba(248,81,73,0.15)' : 'rgba(63,185,80,0.15)'}; color:${statusColor}">
          ${statusIcon}
        </div>
        <div class="tx-banner-info">
          <div class="tx-banner-summary tx-banner-summary-row">
            <span>${deriveStructuralSummary()}</span>
            <span id="tx-intent-chip-wrap" style="display:${showIntentOverlay ? "inline-flex" : "none"}">${renderIntentChip(txIntent)}</span>
          </div>
          <div id="tx-intent-evidence" class="tx-intent-evidence" style="display:${showIntentOverlay && txIntent.evidence?.length ? "block" : "none"}">Best-effort intent: ${escapeHtml(deriveIntentSummary())}${txIntent.evidence?.length ? ` · Why: ${escapeHtml(txIntent.evidence.slice(0, 3).join(" • "))}` : ""}</div>
          ${eff?.executionError ? (() => {
            const err = eff.executionError;
            const parts = [];
            if (err.module?.name) parts.push(`<span class="tx-label-dim">Module:</span> ${err.module.package?.address ? hashLink(truncHash(err.module.package.address), '/object/' + err.module.package.address) + '::' : ''}${err.module.name}`);
            if (err.function?.name) parts.push(`<span class="tx-label-dim">Function:</span> ${err.function.name}`);
            if (err.abortCode != null) parts.push(`<span class="tx-label-dim">Abort Code:</span> <span class="tx-gas-popover-mono">${err.abortCode}</span>`);
            if (err.sourceLineNumber != null) parts.push(`<span class="tx-label-dim">Line:</span> ${err.sourceLineNumber}`);
            if (err.instructionOffset != null) parts.push(`<span class="tx-label-dim">Instruction:</span> ${err.instructionOffset}`);
            return `<div class="tx-error-msg">${err.message}</div>${parts.length ? `<div class="tx-error-details">${parts.join('')}</div>` : ''}`;
          })() : ""}
          <div class="tx-banner-meta">
            <span>${statusBadge(eff?.status)}</span>
            <span title="${fmtTime(eff?.timestamp)}" class="tx-status-time">${fmtTime(eff?.timestamp)} (${timeAgo(eff?.timestamp)})</span>
            <span>Epoch <a class="hash-link" href="#/epoch/${eff?.epoch?.epochId}">${eff?.epoch?.epochId ?? "?"}</a></span>
            <span>Checkpoint <a class="hash-link" href="#/checkpoint/${eff?.checkpoint?.sequenceNumber}">${fmtNumber(eff?.checkpoint?.sequenceNumber)}</a></span>
            <span>Effects <span class="u-mono">${escapeHtml(effectsModeLabel)}</span></span>
            <span class="tx-gas-pill">Gas: <details>
              <summary>${fmtSui(gasUsed)}</summary>
              <div class="tx-gas-popover">
                <div class="tx-gas-popover-mono">Compute ${fmtSui(gs?.computationCost)} | Storage ${fmtSui(gs?.storageCost)} | Rebate ${fmtSui(gs?.storageRebate)}</div>
                <div class="tx-gas-popover-row">Payer: ${ownerLinkOrText(gasPayerAddr)} (${gasPayerAddr && senderAddr && gasPayerAddr !== senderAddr ? "sponsored" : "sender paid"})</div>
                <div>Sender net: <span class="tx-gas-popover-mono">${fmtRawCoinValue(senderSuiDeltaRaw, "0x2::sui::SUI", { signed: true })}</span>${senderAddr && gasPayerAddr === senderAddr ? ` · ex-gas <span class="tx-gas-popover-mono">${fmtRawCoinValue(senderSuiDeltaExGasRaw, "0x2::sui::SUI", { signed: true })}</span>` : ""}</div>
                ${gasPayerAddr && senderAddr && gasPayerAddr !== senderAddr ? `<div>Gas payer net: <span class="tx-gas-popover-mono">${fmtRawCoinValue(gasPayerSuiDeltaRaw, "0x2::sui::SUI", { signed: true })}</span> · ex-gas <span class="tx-gas-popover-mono">${fmtRawCoinValue(gasPayerSuiDeltaExGasRaw, "0x2::sui::SUI", { signed: true })}</span></div>` : ""}
              </div>
            </details></span>
          </div>
          <div class="tx-intent-evidence">${effectsSourceSummary}</div>
          <div class="tx-digest-line">
            ${tx.digest} ${copyBtn(tx.digest)}
            &nbsp; from ${tx.sender ? fullHashLink(tx.sender.address, '/address/' + tx.sender.address) : "---"}
          </div>
          ${detailLoaded && balances.length ? `<div class="bal-summary">${balances.map((b) => {
            const c = fmtCoinWithMeta(b.amount, b.coinType?.repr);
            const color = c.raw >= 0 ? "var(--green)" : "var(--red)";
            return `<span class="bal-summary-item" style="color:${color}">${c.sign}${c.abs} ${c.name}</span>`;
          }).join("")}</div>` : ""}
          ${isPTB ? `<div class="tx-stack-wrap">
            <div class="tx-stack-title">PTB Command Mix</div>
            ${renderStackBar(commandMix, { empty: '<div class="u-fs12-dim">No command mix.</div>' })}
          </div>` : ""}
          ${detailLoaded ? `<div class="tx-stack-wrap">
            <div class="tx-stack-title">Object Change Mix</div>
            ${renderStackBar(objectMix, { empty: '<div class="u-fs12-dim">No object changes.</div>' })}
          </div>` : ""}
          ${detailLoaded && truncatedNotes.length ? `<div class="tx-partial-window">Partial response window: ${escapeHtml(truncatedNotes.join(", "))}. Open Query and paginate for full detail.</div>` : ""}
        </div>
      </div>

      ${renderExecutionOverviewCard()}
      ${renderBalanceFlowMatrixCard()}
      ${renderObjectLifecycleCard()}
      ${renderEventOutcomeCard()}

      <div class="tx-sections-toolbar">
        <button data-action="tx-toggle-sections">Expand / Collapse all</button>
      </div>
      ${isPTB ? section("sec-commands", "Commands", `${commands.length}${commandsTruncated ? "+" : ""}`, true, renderCommands(), { truncated: commandsTruncated }) : ""}
      ${isPTB ? section("sec-inputs", "Inputs", `${inputs.length}${inputsTruncated ? "+" : ""}`, inputs.length > 0, renderInputs(), { truncated: inputsTruncated }) : ""}
      ${section("sec-balances", "Balance Changes", detailLoaded ? `${balances.length}${balancesTruncated ? "+" : ""}` : "loading", false, renderBalances(), { truncated: detailLoaded && balancesTruncated })}
      ${section("sec-objects", "Object Changes", detailLoaded ? `${objChanges.length}${objectsTruncated ? "+" : ""}` : "loading", detailLoaded && objChanges.length > 0, renderObjects(), { truncated: detailLoaded && objectsTruncated })}
      ${section("sec-events", "Events", detailLoaded ? `${events.length}${eventsTruncated ? "+" : ""}` : "loading", false, renderEvents(), { truncated: detailLoaded && eventsTruncated })}
    `;

    const toggleTxIntentOverlay = () => {
      showIntentOverlay = !showIntentOverlay;
      setRouteParams({ intent: showIntentOverlay ? "1" : null });
      const chip = document.getElementById("tx-intent-chip-wrap");
      const why = document.getElementById("tx-intent-evidence");
      const btn = document.getElementById("tx-intent-toggle");
      if (chip) chip.style.display = showIntentOverlay ? "inline-flex" : "none";
      if (why) why.style.display = showIntentOverlay && txIntent.evidence?.length ? "block" : "none";
      if (btn) btn.textContent = showIntentOverlay ? "Intent Overlay: On" : "Intent Overlay: Off";
    };
    const txOverviewDrill = (sectionId, overviewDetailId = "") => {
      if (overviewDetailId) {
        const ov = document.getElementById(overviewDetailId);
        if (ov && ov.tagName === "DETAILS") ov.open = true;
      }
      const sec = sectionId ? document.getElementById(sectionId) : null;
      if (!sec) return;
      if (sec.tagName === "DETAILS") sec.open = true;
      sec.scrollIntoView({ behavior: "smooth", block: "start" });
      sec.classList.add("tx-jump-highlight");
      setTimeout(() => sec.classList.remove("tx-jump-highlight"), 900);
    };
    if (app._txDetailClickHandler) app.removeEventListener("click", app._txDetailClickHandler);
    app._txDetailClickHandler = (ev) => {
      const trigger = ev.target?.closest?.("[data-action]");
      if (!trigger || !app.contains(trigger)) return;
      const action = trigger.getAttribute("data-action");
      if (!action) return;
      if (action === "tx-toggle-intent") {
        ev.preventDefault();
        toggleTxIntentOverlay();
        return;
      }
      if (action === "tx-toggle-effects-mode") {
        ev.preventDefault();
        setRouteParams({ effects: useRootEffects ? null : "1" });
        routeTo(getRoute());
        return;
      }
      if (action === "tx-drill") {
        ev.preventDefault();
        txOverviewDrill(trigger.getAttribute("data-section") || "", trigger.getAttribute("data-overview") || "");
        return;
      }
      if (action === "tx-toggle-sections") {
        ev.preventDefault();
        const hasOpen = !!app.querySelector(".tx-section[open]");
        app.querySelectorAll(".tx-section").forEach((d) => { d.open = !hasOpen; });
      }
    };
    app.addEventListener("click", app._txDetailClickHandler);
  }

  renderTxView();
  setTimeout(() => {
    if (!app.isConnected || localRouteToken !== routeRenderToken || detailHydrating) return;
    detailHydrating = true;
    hydrateTxEffectsDetail().finally(() => { detailHydrating = false; });
  }, 0);
}

// ── DeepBook Margin Constants ───────────────────────────────────────────
const DEEPBOOK_PKG = "0x97d9473771b01f77b0940c589484184b49f6444627ec121314fae6a6d36fb86b";
const MARGIN_MANAGERS_TABLE = "0x092e684ffea68219f928b02b5888883a6214a5f689833cb78cd304a17477d195";
const POOL_REGISTRY_TABLE = "0x09649d4bd62fcac10f6d4ff14716f0658456a7c33a74a04052e3e4027a646958";
const KNOWN_POOLS = {
  "0x53041c6f86c4782aabbfc1d4fe234a6d37160310c7ee740c915f0a01b7127344": { symbol: "SUI", decimals: 9 },
  "0xba473d9ae278f10af75c50a8fa341e9c6a1c087dc91a3f23e8048baf67d0754f": { symbol: "USDC", decimals: 6 },
  "0x38decd3dbb62bd4723144349bf57bc403b393aee86a51596846a824a1e0c2c01": { symbol: "WAL", decimals: 9 },
  "0x1d723c5cd113296868b55208f2ab5a905184950dd59c48eb7345607d6b5e6af7": { symbol: "DEEP", decimals: 6 },
  "0xbb990ca04a774326c3bf589e4bc67904ea076e3df7b85a7b81e2ca8a94b18253": { symbol: "SUI_USDE", decimals: 6 },
};
const SCALE = 1_000_000_000;

function addressToBcs(addr) {
  const hex = addr.startsWith("0x") ? addr.slice(2) : addr;
  const padded = hex.padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(padded.substr(i * 2, 2), 16);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── DeFi Helpers ───────────────────────────────────────────────────────
function getDecimals(sym) { return COMMON_DECIMALS[sym] || 9; }

function fmtUsdFromFloat(val) {
  if (val >= 1_000_000) return "$" + (val / 1_000_000).toFixed(2) + "M";
  if (val >= 1_000) return "$" + (val / 1_000).toFixed(2) + "K";
  if (val >= 1) return "$" + val.toFixed(2);
  return "$" + val.toFixed(4);
}

function fmtAmountDefi(raw, decimals) {
  const val = Number(raw) / Math.pow(10, decimals);
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(2) + "M";
  if (val >= 1_000) return (val / 1_000).toFixed(2) + "K";
  if (val >= 0.01) return val.toFixed(2);
  if (val > 0) return val.toFixed(6);
  return "0";
}

function deepBookEventPrice(ev) {
  const typeRepr = ev?.contents?.type?.repr || "";
  const json = ev?.contents?.json || {};
  if (!typeRepr.startsWith(DEEPBOOK_SPOT_PACKAGE + "::")) return null;
  if (json.pool_id !== DEEPBOOK_SUI_USDC_POOL) return null;
  if (typeRepr.endsWith("::order_info::OrderFilled")) {
    const baseQty = Number(json.base_quantity || 0);
    const quoteQty = Number(json.quote_quantity || 0);
    if (baseQty > 0 && quoteQty > 0) {
      const base = baseQty / Math.pow(10, DEEPBOOK_BASE_DECIMALS);
      const quote = quoteQty / Math.pow(10, DEEPBOOK_QUOTE_DECIMALS);
      const px = quote / base;
      if (Number.isFinite(px) && px > 0) return px;
    }
  }
  const rawPrice = Number(json.price || 0);
  if (rawPrice > 0) return rawPrice / Math.pow(10, DEEPBOOK_QUOTE_DECIMALS);
  return null;
}

async function fetchSuiPriceFromDeepBook() {
  const data = await gql(`{
    object(address: "${DEEPBOOK_SUI_USDC_POOL}") {
      objectVersionsBefore(last: ${DEEPBOOK_PRICE_LOOKBACK_VERSIONS}) {
        nodes {
          previousTransaction {
            effects {
              status
              events(first: ${DEEPBOOK_PRICE_EVENTS_PER_TX}) {
                nodes { ${GQL_F_CONTENTS_TYPE_JSON} }
              }
            }
          }
        }
      }
    }
  }`);
  const versions = data?.object?.objectVersionsBefore?.nodes || [];
  let bidPx = null, askPx = null;
  for (let i = versions.length - 1; i >= 0; i--) {
    const eff = versions[i]?.previousTransaction?.effects;
    if (!eff || eff.status !== "SUCCESS") continue;
    const events = eff.events?.nodes || [];
    for (let k = events.length - 1; k >= 0; k--) {
      const ev = events[k];
      const typeRepr = ev?.contents?.type?.repr || "";
      if (!typeRepr.startsWith(DEEPBOOK_SPOT_PACKAGE + "::")) continue;
      const px = deepBookEventPrice(ev);
      if (!(px > 0)) continue;
      if (typeRepr.endsWith("::order_info::OrderFilled")) return px;
      const isBidRaw = ev?.contents?.json?.is_bid;
      const isBid = isBidRaw === true || isBidRaw === "true";
      const isAsk = isBidRaw === false || isBidRaw === "false";
      if (isBid && bidPx == null) bidPx = px;
      if (isAsk && askPx == null) askPx = px;
      if (bidPx != null && askPx != null) return (bidPx + askPx) / 2;
    }
  }
  if (bidPx != null && askPx != null) return (bidPx + askPx) / 2;
  return bidPx != null ? bidPx : askPx;
}

// ── Pool Oracle: on-chain pricing via Cetus + Bluefin CLMM pools ──────
async function _discoverPoolsForDex(needed, prefix, dex, suiType, usdcType) {
  const aliases = [];
  const aliasMeta = [];
  for (const ct of needed) {
    if (ct === suiType || ct === usdcType) continue;
    // TOKEN/SUI
    aliases.push(`a${aliases.length}: objects(filter: { type: "${prefix}<${ct}, ${suiType}>" }, first: 3) { nodes { address ${GQL_F_MOVE_TYPE_JSON} } }`);
    aliasMeta.push({ coinType: ct, dex, quoteSymbol: "SUI", isTokenA: true });
    // SUI/TOKEN
    aliases.push(`a${aliases.length}: objects(filter: { type: "${prefix}<${suiType}, ${ct}>" }, first: 3) { nodes { address ${GQL_F_MOVE_TYPE_JSON} } }`);
    aliasMeta.push({ coinType: ct, dex, quoteSymbol: "SUI", isTokenA: false });
    // TOKEN/USDC
    aliases.push(`a${aliases.length}: objects(filter: { type: "${prefix}<${ct}, ${usdcType}>" }, first: 3) { nodes { address ${GQL_F_MOVE_TYPE_JSON} } }`);
    aliasMeta.push({ coinType: ct, dex, quoteSymbol: "USDC", isTokenA: true });
    // USDC/TOKEN
    aliases.push(`a${aliases.length}: objects(filter: { type: "${prefix}<${usdcType}, ${ct}>" }, first: 3) { nodes { address ${GQL_F_MOVE_TYPE_JSON} } }`);
    aliasMeta.push({ coinType: ct, dex, quoteSymbol: "USDC", isTokenA: false });
  }
  if (!aliases.length) return;
  const chunks = chunkArray(aliases.map((a, i) => ({ alias: a, meta: aliasMeta[i] })), 6);
  const CONCURRENCY = 10;
  for (let start = 0; start < chunks.length; start += CONCURRENCY) {
    const batch = chunks.slice(start, start + CONCURRENCY);
    await Promise.all(batch.map(async (chunk) => {
      try {
        const q = `{ ${chunk.map(c => c.alias).join("\n")} }`;
        const data = await gql(q);
        for (let i = 0; i < chunk.length; i++) {
          const aliasKey = chunk[i].alias.split(":")[0];
          const poolNodes = data?.[aliasKey]?.nodes || [];
          const meta = chunk[i].meta;
          if (!poolAddressCache[meta.coinType]) poolAddressCache[meta.coinType] = { pools: [], ts: 0 };
          for (const node of poolNodes) {
            const json = node.asMoveObject?.contents?.json;
            const liq = Number(json?.liquidity || 0);
            if (liq <= 0) continue;
            poolAddressCache[meta.coinType].pools.push({
              address: node.address, dex: meta.dex,
              quoteSymbol: meta.quoteSymbol, isTokenA: meta.isTokenA,
              typeRepr: node.asMoveObject?.contents?.type?.repr || "",
            });
          }
        }
      } catch (e) { console.warn(`[pool-oracle] ${dex} discovery error:`, e?.message || e); }
    }));
  }
}

async function discoverPoolAddresses(coinTypes) {
  const now = Date.now();
  const needed = coinTypes.filter(ct => {
    const c = poolAddressCache[ct];
    return !c || (now - c.ts > POOL_ORACLE_DISCOVERY_TTL_MS);
  });
  if (!needed.length) return;

  const suiType = QUOTE_COINS.SUI.type;
  const usdcType = QUOTE_COINS.USDC.type;

  // Reset stale entries before re-populating
  for (const ct of needed) poolAddressCache[ct] = { pools: [], ts: 0 };

  // Pass 1: Cetus pools (primary — most tokens have Cetus liquidity)
  await _discoverPoolsForDex(needed, CETUS_POOL_TYPE_PREFIX, "cetus", suiType, usdcType);

  // Pass 2: Bluefin pools (fallback — only for tokens with no Cetus pools)
  const needBluefin = needed.filter(ct => {
    const cached = poolAddressCache[ct];
    return !cached || !cached.pools.length;
  });
  if (needBluefin.length) {
    await _discoverPoolsForDex(needBluefin, BLUEFIN_POOL_TYPE_PREFIX, "bluefin", suiType, usdcType);
  }

  // Update timestamps
  for (const ct of needed) poolAddressCache[ct].ts = now;
}

async function readPoolPrices(coinTypesBySymbol) {
  // Collect all pool addresses we need to read
  const addrToMeta = {}; // address → { coinType, symbol, dex, quoteSymbol, isTokenA }
  for (const [sym, ct] of Object.entries(coinTypesBySymbol)) {
    const cached = poolAddressCache[ct];
    if (!cached) continue;
    for (const pool of cached.pools) {
      addrToMeta[pool.address] = { coinType: ct, symbol: sym, dex: pool.dex, quoteSymbol: pool.quoteSymbol, isTokenA: pool.isTokenA, typeRepr: pool.typeRepr };
    }
  }
  const addresses = Object.keys(addrToMeta);
  if (!addresses.length) return {};

  const poolById = await multiGetObjectsTypeJsonByAddress(addresses);

  // Compute prices per symbol, weighted by liquidity
  const accum = {}; // symbol → { weightedSum, liqSum }
  for (const addr of addresses) {
    const obj = poolById[addr];
    if (!obj) continue;
    const contents = obj.asMoveObject?.contents;
    const json = contents?.json;
    const typeRepr = contents?.type?.repr || addrToMeta[addr].typeRepr;
    if (!json || !typeRepr) continue;

    const sqrtPrice = json.current_sqrt_price;
    const liquidity = Number(json.liquidity || 0);
    if (!sqrtPrice || liquidity <= 0) continue;

    const meta = addrToMeta[addr];

    // Extract coin types from type repr: Pool<TypeA, TypeB>
    const typeMatch = typeRepr.match(/Pool<(.+),\s*(.+)>/);
    if (!typeMatch) continue;
    const coinTypeA = typeMatch[1].trim();
    const coinTypeB = typeMatch[2].trim();

    // Resolve decimals
    const resolvedA = resolveCoinType(coinTypeA);
    const resolvedB = resolveCoinType(coinTypeB);

    // sqrtPriceToHumanPrice gives price of A in terms of B
    const priceAinB = sqrtPriceToHumanPrice(sqrtPrice, resolvedA.decimals, resolvedB.decimals);
    if (!priceAinB || !Number.isFinite(priceAinB)) continue;

    // Determine the USD price of our target token
    let tokenPriceUsd;
    if (meta.isTokenA) {
      // Our token is A, quote is B → price = priceAinB * quoteUsdPrice
      if (meta.quoteSymbol === "USDC") tokenPriceUsd = priceAinB;
      else if (meta.quoteSymbol === "SUI") tokenPriceUsd = priceAinB * (defiPrices.SUI || 0);
    } else {
      // Our token is B, quote is A → price = (1/priceAinB) * quoteUsdPrice
      if (priceAinB <= 0) continue;
      const priceBinA = 1 / priceAinB;
      if (meta.quoteSymbol === "USDC") tokenPriceUsd = priceBinA;
      else if (meta.quoteSymbol === "SUI") tokenPriceUsd = priceBinA * (defiPrices.SUI || 0);
    }

    if (!tokenPriceUsd || !Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0) continue;

    if (!accum[meta.symbol]) accum[meta.symbol] = { weightedSum: 0, liqSum: 0 };
    accum[meta.symbol].weightedSum += tokenPriceUsd * liquidity;
    accum[meta.symbol].liqSum += liquidity;
  }

  const result = {};
  for (const [sym, { weightedSum, liqSum }] of Object.entries(accum)) {
    if (liqSum > 0) result[sym] = weightedSum / liqSum;
  }
  return result;
}

async function fetchPoolOraclePrices(specificCoinTypes) {
  // Resolve which coin types to price
  const entries = []; // { coinType, symbol, decimals }
  const source = specificCoinTypes
    ? specificCoinTypes
    : Object.keys(KNOWN_COIN_TYPES);
  for (const ct of source) {
    const resolved = resolveCoinType(ct);
    if (POOL_ORACLE_SKIP.has(resolved.symbol)) continue;
    if (SUI_PEGGED_SYMBOLS.has(resolved.symbol)) continue;
    if (BTC_PEGGED_SYMBOLS.has(resolved.symbol)) continue;
    entries.push({ coinType: ct, symbol: resolved.symbol, decimals: resolved.decimals });
  }
  if (!entries.length) return;

  // Prefetch metadata for any unknown decimals
  const unknownMeta = entries.filter(e => e.decimals === 9 && !COMMON_DECIMALS[e.symbol] && !KNOWN_COIN_TYPES[e.coinType]).map(e => e.coinType);
  if (unknownMeta.length) await prefetchCoinMeta(unknownMeta);

  // Discover pool addresses for any uncached coin types
  const coinTypesToDiscover = entries.map(e => e.coinType);
  await discoverPoolAddresses(coinTypesToDiscover);

  // Read fresh prices from pools
  const coinTypesBySymbol = {};
  for (const e of entries) coinTypesBySymbol[e.symbol] = e.coinType;
  const prices = await readPoolPrices(coinTypesBySymbol);

  // Write into defiPrices
  for (const [sym, usd] of Object.entries(prices)) {
    if (usd > 0) defiPrices[sym] = usd;
  }
  oraclePricesTs = Date.now();
  persistDefiPriceState();
}

async function ensurePrices(coinTypes) {
  if (!coinTypes || !coinTypes.length) return;
  // Ensure SUI price exists first (needed for SUI-quoted pool conversions)
  if (!defiPrices.SUI) {
    try { const p = await fetchSuiPriceFromDeepBook(); if (p) { defiPrices.SUI = p; deepbookSuiPriceTs = Date.now(); } } catch (_) {}
  }
  // Only attempt pool discovery for known coin types — random memecoins
  // won't have meaningful DEX liquidity and their long type strings can
  // exceed GQL payload limits
  const needed = [];
  for (const ct of coinTypes) {
    const norm = normalizeCoinType(ct);
    if (!KNOWN_COIN_TYPES[ct] && !KNOWN_COIN_TYPES[norm]) continue;
    const resolved = resolveCoinType(ct);
    if (POOL_ORACLE_SKIP.has(resolved.symbol)) continue;
    if (SUI_PEGGED_SYMBOLS.has(resolved.symbol)) {
      if (defiPrices.SUI) defiPrices[resolved.symbol] = defiPrices.SUI;
      continue;
    }
    if (BTC_PEGGED_SYMBOLS.has(resolved.symbol)) {
      if (defiPrices[BTC_PRICE_SOURCE]) defiPrices[resolved.symbol] = defiPrices[BTC_PRICE_SOURCE];
      continue;
    }
    if (defiPrices[resolved.symbol] > 0) continue;
    needed.push(ct);
  }
  if (!needed.length) return;
  await fetchPoolOraclePrices(needed);
  persistDefiPriceState();
}

function syncPeggedPrices() {
  if (defiPrices.SUI) { for (const sym of SUI_PEGGED_SYMBOLS) defiPrices[sym] = defiPrices.SUI; }
  defiPrices.USDC = 1; defiPrices.USDT = 1; defiPrices.wUSDC = 1;
  defiPrices.BUCK = 1; defiPrices.AUSD = 1; defiPrices.FDUSD = 1;
  defiPrices.USDY = 1; defiPrices.SUI_USDE = 1; defiPrices.suiUSDe = 1;
  if (defiPrices[BTC_PRICE_SOURCE]) { for (const sym of BTC_PEGGED_SYMBOLS) defiPrices[sym] = defiPrices[BTC_PRICE_SOURCE]; }
}

function persistDefiPriceState() {
  writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.defiPrices, {
    prices: defiPrices,
    deepbookSuiPriceTs,
    oraclePricesTs,
  }, 50000);
}

function hydratePersistedDefiPriceState() {
  const row = readPersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.defiPrices, DEFI_PRICE_PERSIST_TTL_MS);
  const persisted = row?.data;
  if (!persisted || typeof persisted !== "object") return;
  if (persisted.prices && typeof persisted.prices === "object") {
    defiPrices = { ...defiPrices, ...persisted.prices };
  }
  deepbookSuiPriceTs = Number(persisted.deepbookSuiPriceTs || deepbookSuiPriceTs || 0);
  oraclePricesTs = Number(persisted.oraclePricesTs || oraclePricesTs || 0);
  syncPeggedPrices();
}

hydratePersistedDefiPriceState();

async function fetchDefiPrices(force = false, { skipOracle = false } = {}) {
  const now = Date.now();
  const needSui = force || !defiPrices.SUI || (now - deepbookSuiPriceTs > DEEPBOOK_SUI_PRICE_TTL_MS);
  const needOracle = !skipOracle && (force || (now - oraclePricesTs > POOL_ORACLE_PRICE_TTL_MS));
  if (!needSui && !needOracle) {
    notePerfCache(true);
    return;
  }
  if (defiPricesInFlight) return defiPricesInFlight;
  notePerfCache(false);

  defiPricesInFlight = (async () => {
    // DeepBook SUI price must resolve first (needed for SUI-quoted pool conversions)
    const deepBookSuiPrice = needSui
      ? await fetchSuiPriceFromDeepBook().catch(() => null)
      : (defiPrices.SUI || null);

    if (deepBookSuiPrice && Number.isFinite(deepBookSuiPrice)) {
      defiPrices.SUI = deepBookSuiPrice;
      deepbookSuiPriceTs = Date.now();
    }

    // Pool oracle: price all known tokens from on-chain CLMM pools
    if (needOracle && defiPrices.SUI) {
      await fetchPoolOraclePrices().catch(() => null);
    }

    syncPeggedPrices();
    persistDefiPriceState();
  })().finally(() => { defiPricesInFlight = null; });

  return defiPricesInFlight;
}

// ── DeFi Ecosystem Stats (DeFiLlama) ──────────────────────────────────
async function fetchEcosystemStats(force = false) {
  return withTimedCache(ecosystemCache, ECOSYSTEM_TTL, force, async () => {
    const [protocolsRes, dexRes, chainsRes] = await Promise.all([
      fetch("https://api.llama.fi/protocols"),
      fetch("https://api.llama.fi/overview/dexs/Sui"),
      fetch("https://api.llama.fi/v2/chains"),
    ]);
    if (!protocolsRes.ok) return null;
    const allProtocols = await protocolsRes.json();
    const dexData = dexRes.ok ? await dexRes.json() : null;
    const chainsData = chainsRes.ok ? await chainsRes.json() : null;

    // Get official deduplicated Sui TVL from chains endpoint
    const suiChain = (chainsData || []).find(c => c.name === "Sui");
    const totalTvl = suiChain?.tvl || 0;

    // Filter for Sui protocols with TVL (for protocol ranking list)
    const suiProtocols = allProtocols
      .filter(p => (p.chains || []).includes("Sui") && (p.chainTvls?.Sui || p.tvl) > 0)
      .map(p => ({
        name: p.name,
        slug: p.slug,
        category: p.category || "Other",
        tvl: p.chainTvls?.Sui || 0,
        change24h: p.change_1d ?? null,
        logo: p.logo,
      }))
      .sort((a, b) => b.tvl - a.tvl);

    // Aggregate by category
    const lendingTvl = suiProtocols.filter(p => p.category === "Lending").reduce((s, p) => s + p.tvl, 0);
    const dexTvl = suiProtocols.filter(p => ["Dexes", "Dexs"].includes(p.category)).reduce((s, p) => s + p.tvl, 0);
    const lstTvl = suiProtocols.filter(p => p.category === "Liquid Staking").reduce((s, p) => s + p.tvl, 0);

    // DEX 24h volume
    const dexVolume24h = dexData?.total24h ?? 0;

    const result = { totalTvl, lendingTvl, dexTvl, lstTvl, dexVolume24h, protocols: suiProtocols.slice(0, 15) };
    writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.ecosystemStats, result, 40000);
    return result;
  }).catch(() => null);
}

// ── Stablecoin Supply (all via GraphQL) ──────────────────────────────
async function fetchStablecoinSupply(force = false) {
  return withTimedCache(stablecoinCache, ECOSYSTEM_TTL, force, async () => {
    const coins = [];
    const pushCoin = (symbol, supply, color) => {
      if (!(Number.isFinite(supply) && supply > 0)) return;
      coins.push({ symbol, supply, color });
    };

    const [metadataRows, wormholeRows, protocolRows] = await Promise.all([
      Promise.all(chunkArray(STABLECOINS_METADATA, 3).map(async (batch) => {
        try {
          const aliases = batch.map((s, j) => `s${j}: coinMetadata(coinType: "${s.type}") { supply }`);
          const data = await gql(`{ ${aliases.join("\n")} }`);
          return batch.map((s, j) => {
            const raw = data?.[`s${j}`]?.supply;
            if (!raw) return null;
            return {
              symbol: s.symbol,
              supply: Number(raw) / Math.pow(10, s.decimals),
              color: s.color,
            };
          }).filter(Boolean);
        } catch (_) {
          return [];
        }
      })),
      (async () => {
        if (!STABLECOINS_WORMHOLE.length) return [];
        try {
          const fields = STABLECOINS_WORMHOLE.map((wh, i) => {
            const keyType = `${WORMHOLE_KEY_PKG}::token_registry::Key<${wh.type}>`;
            return `w${i}: dynamicField(name: { type: "${keyType}", bcs: "AA==" }) { value { ... on MoveValue { json } } }`;
          });
          const data = await gql(`{ address(address: "${WORMHOLE_REGISTRY}") { ${fields.join("\n")} } }`);
          const registry = data?.address || {};
          return STABLECOINS_WORMHOLE.map((wh, i) => {
            const j = registry?.[`w${i}`]?.value?.json;
            if (!j?.treasury_cap?.total_supply?.value) return null;
            return {
              symbol: wh.symbol,
              supply: Number(j.treasury_cap.total_supply.value) / Math.pow(10, j.decimals || wh.decimals),
              color: wh.color,
            };
          }).filter(Boolean);
        } catch (_) {
          return [];
        }
      })(),
      (async () => {
        if (!STABLECOINS_PROTOCOL.length) return [];
        try {
          const fields = STABLECOINS_PROTOCOL.map((p, i) => `p${i}: object(address: "${p.objAddr}") { ${GQL_F_MOVE_JSON} }`);
          const data = await gql(`{ ${fields.join("\n")} }`);
          return STABLECOINS_PROTOCOL.map((p, i) => {
            const json = data?.[`p${i}`]?.asMoveObject?.contents?.json;
            if (!json) return null;
            const val = p.supplyPath.split(".").reduce((o, k) => o?.[k], json);
            if (!val) return null;
            return {
              symbol: p.symbol,
              supply: Number(val) / Math.pow(10, p.decimals),
              color: p.color,
            };
          }).filter(Boolean);
        } catch (_) {
          return [];
        }
      })(),
    ]);

    for (const rows of metadataRows) {
      for (const row of rows) pushCoin(row.symbol, row.supply, row.color);
    }
    for (const row of wormholeRows) pushCoin(row.symbol, row.supply, row.color);
    for (const row of protocolRows) pushCoin(row.symbol, row.supply, row.color);

    coins.sort((a, b) => b.supply - a.supply);
    const totalSupply = coins.reduce((sum, c) => sum + c.supply, 0);
    coins.forEach(c => c.pct = totalSupply > 0 ? (c.supply / totalSupply * 100) : 0);
    const result = { coins, totalSupply };
    writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.stablecoinSupply, result, 18000);
    return result;
  }).catch(() => null);
}

function renderDonutChart(coins, totalSupply) {
  const R = 70, CX = 100, CY = 100, SW = 28;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const circles = coins.filter(c => c.pct > 0.3).map(c => {
    const len = (c.pct / 100) * C;
    const label = `${c.symbol}: $${c.supply.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${c.pct.toFixed(2)}%)`;
    const svg = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${c.color}" stroke-width="${SW}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" data-chart-tooltip="${escapeAttr(label)}"/>`;
    offset += len;
    return svg;
  }).join("");
  return `<svg viewBox="0 0 200 200" width="160" height="160" style="transform:rotate(-90deg);flex-shrink:0">
    <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--border)" stroke-width="${SW}"/>
    ${circles}
    <text x="${CX}" y="${CY - 6}" text-anchor="middle" fill="var(--text-dim)" font-size="10" transform="rotate(90 ${CX} ${CY})">Stablecoin Supply</text>
    <text x="${CX}" y="${CY + 14}" text-anchor="middle" fill="var(--text)" font-size="18" font-weight="600" transform="rotate(90 ${CX} ${CY})">$${fmtCompact(totalSupply)}</text>
  </svg>`;
}

const CORE_LENDING_TOKENS = new Set(["SUI", "USDC", "USDT", "ETH", "WETH", "BTC", "WBTC", "LBTC", "stBTC", "enzoBTC", "MBTC", "YBTC", "xBTC", "XBTC", "WAL", "DEEP", "XAUM", "SOL"]);
function isCoreToken(sym) { return CORE_LENDING_TOKENS.has(sym); }

// ── Protocol Fetchers ──────────────────────────────────────────────────
function buildRateRow(protocol, token, borrowBps, supplyBps, utilization, sourceId, sourceLabel, note = "", totalSupplyHuman = 0, totalBorrowHuman = 0) {
  return {
    protocol,
    token,
    borrowBps: Number.isFinite(borrowBps) ? borrowBps : null,
    supplyBps: Number.isFinite(supplyBps) ? supplyBps : null,
    utilization: Number.isFinite(utilization) ? clamp01(utilization) : null,
    sourceId: sourceId || "",
    sourceLabel: sourceLabel || "",
    note,
    totalSupplyHuman,
    totalBorrowHuman,
    error: "",
  };
}

function emptyRateRow(protocol, token, sourceId, sourceLabel, error = "") {
  return {
    protocol,
    token,
    borrowBps: null,
    supplyBps: null,
    utilization: null,
    sourceId: sourceId || "",
    sourceLabel: sourceLabel || "",
    note: "",
    totalSupplyHuman: 0,
    totalBorrowHuman: 0,
    error: error || "Unavailable",
  };
}

async function fetchNaviLendingRates() {
  const rows = {};
  const data = await gql(`{
    address(address: "${NAVI_RESERVES_TABLE}") {
      dynamicFields(first: 50) { nodes { value { ... on MoveValue { json } } } }
    }
  }`);
  for (const n of (data?.address?.dynamicFields?.nodes || [])) {
    const rv = n?.value?.json || {};
    const token = tokenFromCoinType(rv.coin_type);
    if (!token || rows[token]) continue;
    const supplyRate = numOrZero(rv.current_supply_rate) / NAVI_RAY;
    const borrowRate = numOrZero(rv.current_borrow_rate) / NAVI_RAY;
    const supplyBps = supplyRate * 10000;
    const borrowBps = borrowRate * 10000;
    const supplyShares = numOrZero(rv.supply_balance?.total_supply);
    const borrowShares = numOrZero(rv.borrow_balance?.total_supply);
    const supplyIdx = numOrZero(rv.current_supply_index) / NAVI_RAY;
    const borrowIdx = numOrZero(rv.current_borrow_index) / NAVI_RAY;
    const totalSupply = supplyShares * supplyIdx;
    const totalBorrow = borrowShares * borrowIdx;
    const util = totalSupply > 0 ? totalBorrow / totalSupply : 0;
    const dec = getDecimals(token);
    const supplyHuman = totalSupply / Math.pow(10, dec);
    const borrowHuman = totalBorrow / Math.pow(10, dec);
    rows[token] = buildRateRow("NAVI", token, borrowBps, supplyBps, util, NAVI_RESERVES_TABLE, "Reserves Table", "", supplyHuman, borrowHuman);
  }
  return rows;
}

async function fetchSuilendLendingRates() {
  const rows = {};
  const data = await gql(`{
    object(address: "${SUILEND_MAIN_POOL_OBJECT}") {
      ${GQL_F_MOVE_JSON}
    }
  }`);
  const reserves = data?.object?.asMoveObject?.contents?.json?.reserves || [];
  for (const reserve of reserves) {
    const token = tokenFromCoinType(reserve?.coin_type?.name);
    if (!token || rows[token]) continue;
    // available_amount is in native token decimals (raw units).
    // borrowed_amount.value is stored as native_amount * 1e18 (WAD precision),
    // so dividing by 1e18 yields the same native units as available_amount.
    // Both values are in the same scale, suitable for utilization and human conversion.
    const available = numOrZero(reserve.available_amount);
    const borrowed = numOrZero(reserve.borrowed_amount?.value) / 1e18;
    const util = (available + borrowed) > 0 ? borrowed / (available + borrowed) : 0;
    const kinks = decodeB64U8Array(reserve?.config?.element?.interest_rate_utils);
    const aprs = reserve?.config?.element?.interest_rate_aprs || [];
    const borrowBps = interpolateRateBps(util * 100, kinks, aprs);
    const spreadBps = numOrZero(reserve?.config?.element?.spread_fee_bps);
    const supplyBps = borrowBps * util * (1 - clamp01(spreadBps / 10000));
    const coinType = reserve?.coin_type?.name;
    const { decimals: suilendDec } = resolveCoinType(coinType ? (coinType.startsWith("0x") ? coinType : "0x" + coinType) : "");
    const supplyHuman = (available + borrowed) / Math.pow(10, suilendDec);
    const borrowHuman = borrowed / Math.pow(10, suilendDec);
    rows[token] = buildRateRow("Suilend", token, borrowBps, supplyBps, util, SUILEND_MAIN_POOL_OBJECT, "Main Pool Object", "", supplyHuman, borrowHuman);
  }
  return rows;
}

async function fetchAlphaLendingRates() {
  const rows = {};
  // Fetch all markets from Alpha's dynamic field table via dynamicFields
  const data = await gql(`{
    address(address: "${ALPHA_MARKETS_TABLE}") {
      dynamicFields(first: 50) { nodes { name { json } value { ... on MoveValue { json } } } }
    }
  }`);
  for (const n of (data?.address?.dynamicFields?.nodes || [])) {
    const marketId = Number(n?.name?.json);
    const market = n?.value?.json;
    if (!market || !Number.isFinite(marketId)) continue;
    const token = ALPHA_MARKETS[marketId] || `Market${marketId}`;
    if (rows[token]) continue;
    const borrowed = numOrZero(market.borrowed_amount);
    const cash = numOrZero(market.balance_holding);
    const util = (borrowed + cash) > 0 ? borrowed / (borrowed + cash) : 0;
    const kinks = decodeB64U8Array(market?.config?.interest_rate_kinks);
    const rates = market?.config?.interest_rates || [];
    const borrowBps = interpolateRateBps(util * 100, kinks, rates);
    const spreadBps = numOrZero(market?.config?.spread_fee_bps);
    const supplyBps = borrowBps * util * (1 - clamp01(spreadBps / 10000));
    const alphaDec = getDecimals(token);
    const supplyHuman = (cash + borrowed) / Math.pow(10, alphaDec);
    const borrowHuman = borrowed / Math.pow(10, alphaDec);
    rows[token] = buildRateRow("Alpha", token, borrowBps, supplyBps, util, ALPHA_MARKETS_TABLE, "Markets Table", "", supplyHuman, borrowHuman);
  }
  return rows;
}

async function fetchScallopLendingRates() {
  const rows = {};
  const data = await gql(`{
    borrowDynamics: address(address: "${SCALLOP_BORROW_DYNAMICS_TABLE}") {
      dynamicFields(first: 50) { nodes { name { json } value { ... on MoveValue { json } } } }
    }
    balanceSheets: address(address: "${SCALLOP_BALANCE_SHEETS_TABLE}") {
      dynamicFields(first: 50) { nodes { name { json } value { ... on MoveValue { json } } } }
    }
    interestModels: address(address: "${SCALLOP_INTEREST_MODELS_TABLE}") {
      dynamicFields(first: 50) { nodes { name { json } value { ... on MoveValue { json } } } }
    }
  }`);

  const bdByToken = {};
  for (const n of (data?.borrowDynamics?.dynamicFields?.nodes || [])) {
    const token = tokenFromCoinType(n?.name?.json?.name);
    if (token && !bdByToken[token]) bdByToken[token] = n?.value?.json || {};
  }
  const bsByToken = {};
  for (const n of (data?.balanceSheets?.dynamicFields?.nodes || [])) {
    const token = tokenFromCoinType(n?.name?.json?.name);
    if (token && !bsByToken[token]) bsByToken[token] = n?.value?.json || {};
  }
  const imByToken = {};
  for (const n of (data?.interestModels?.dynamicFields?.nodes || [])) {
    const token = tokenFromCoinType(n?.name?.json?.name);
    if (token && !imByToken[token]) imByToken[token] = n?.value?.json || {};
  }

  // Iterate all tokens that have borrow dynamics + balance sheets + interest models
  const allTokens = new Set([...Object.keys(bdByToken), ...Object.keys(bsByToken), ...Object.keys(imByToken)]);
  for (const token of allTokens) {
    if (!token) continue;
    const bd = bdByToken[token];
    const bs = bsByToken[token];
    const im = imByToken[token];
    if (!bd || !bs || !im) continue;
    const borrowBps = fixed32ToFloat(bd?.interest_rate?.value || bd?.interest_rate) * 10000;
    const cash = numOrZero(bs.cash);
    const debt = numOrZero(bs.debt);
    const revenue = numOrZero(bs.revenue);
    const denom = debt + cash - revenue;
    const util = denom > 0 ? debt / denom : 0;
    const revenueFactor = clamp01(fixed32ToFloat(im?.revenue_factor?.value || im?.revenue_factor));
    const supplyBps = borrowBps * util * (1 - revenueFactor);
    const scallopDec = getDecimals(token);
    const supplyHuman = (cash + debt) / Math.pow(10, scallopDec);
    const borrowHuman = debt / Math.pow(10, scallopDec);
    rows[token] = buildRateRow("Scallop", token, borrowBps, supplyBps, util, SCALLOP_MARKET_OBJECT, "Market Object", "", supplyHuman, borrowHuman);
  }
  return rows;
}

async function fetchLendingRatesOverview(force = false) {
  const now = Date.now();
  if (!force && lendingRatesCache.data && (now - lendingRatesCache.ts) < LENDING_RATES_TTL_MS) {
    notePerfCache(true);
    return lendingRatesCache.data;
  }
  notePerfCache(false);
  if (lendingRatesInFlight) return lendingRatesInFlight;

  const protocolMeta = [
    { name: "Suilend", sourceId: SUILEND_MAIN_POOL_OBJECT, sourceLabel: "Main Pool Object", fetcher: fetchSuilendLendingRates },
    { name: "NAVI", sourceId: NAVI_RESERVES_TABLE, sourceLabel: "Reserves Table", fetcher: fetchNaviLendingRates },
    { name: "Alpha", sourceId: ALPHA_MARKETS_TABLE, sourceLabel: "Markets Table", fetcher: fetchAlphaLendingRates },
    { name: "Scallop", sourceId: SCALLOP_MARKET_OBJECT, sourceLabel: "Market Object", fetcher: fetchScallopLendingRates },
  ];

  lendingRatesInFlight = (async () => {
    const settled = await Promise.all(protocolMeta.map(async (p) => {
      try {
        const rows = await p.fetcher();
        return { name: p.name, rows, error: "" };
      } catch (e) {
        return { name: p.name, rows: {}, error: e?.message || "Failed to fetch rates" };
      }
    }));
    const byProtocol = {};
    for (const s of settled) byProtocol[s.name] = s;

    // Collect all token symbols from all protocols
    const allTokenSymbols = new Set();
    for (const s of settled) {
      for (const sym of Object.keys(s.rows || {})) allTokenSymbols.add(sym);
    }
    // Ensure SUI and USDC are always present, sorted with majors first
    const majorOrder = ["SUI", "USDC", "USDT", "ETH", "BTC", "WETH", "WBTC", "SOL", "DEEP", "WAL", "CETUS", "NAVX"];
    const sortedTokens = [...allTokenSymbols].sort((a, b) => {
      const ai = majorOrder.indexOf(a), bi = majorOrder.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b);
    });
    const byToken = {};
    for (const token of sortedTokens) {
      byToken[token] = [];
      for (const p of protocolMeta) {
        const out = byProtocol[p.name];
        const row = out?.rows?.[token];
        if (row) byToken[token].push(row);
        else byToken[token].push(emptyRateRow(p.name, token, p.sourceId, p.sourceLabel, out?.error || "Not listed"));
      }
    }

    const result = { fetchedAt: new Date().toISOString(), byToken };
    lendingRatesCache = { data: result, ts: Date.now() };
    writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.lendingRates, result, 160000);
    return result;
  })().finally(() => { lendingRatesInFlight = null; });

  return lendingRatesInFlight;
}

function txMovePackages(tx) {
  const cmds = tx?.kind?.commands?.nodes || [];
  return [...new Set(
    cmds
      .filter(c => c?.__typename === "MoveCallCommand")
      .map(c => c?.function?.module?.package?.address)
      .filter(Boolean)
  )];
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

function packageFromTypeRepr(repr) {
  const r = String(repr || "");
  if (!r) return "";
  const m = r.match(/0x[0-9a-fA-F]+/);
  return m ? normalizeSuiAddress(m[0]) : "";
}

function bumpCount(map, key, inc = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + inc;
}

function topCountRows(map, limit = 6) {
  return Object.entries(map || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function stableSymbolKey(sym) {
  return String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function stableSymbolDisplay(sym) {
  const key = stableSymbolKey(sym);
  if (key === "SUIUSDE") return "suiUSDe";
  if (key === "WUSDT") return "wUSDT";
  if (key === "WUSDC") return "wUSDC";
  if (key === "FDUSD") return "FDUSD";
  if (key === "AUSD") return "AUSD";
  if (key === "USDY") return "USDY";
  if (key === "BUCK") return "BUCK";
  if (key === "USDT") return "USDT";
  if (key === "USDC") return "USDC";
  return String(sym || "");
}

let stableSymbolKeyCache = null;
function getStableSymbolKeys() {
  if (stableSymbolKeyCache) return stableSymbolKeyCache;
  const out = new Set();
  for (const c of STABLECOINS_METADATA) out.add(stableSymbolKey(c.symbol));
  for (const c of STABLECOINS_WORMHOLE) out.add(stableSymbolKey(c.symbol));
  for (const c of STABLECOINS_PROTOCOL) out.add(stableSymbolKey(c.symbol));
  out.add(stableSymbolKey("USDC"));
  out.add(stableSymbolKey("USDT"));
  out.add(stableSymbolKey("wUSDC"));
  out.add(stableSymbolKey("wUSDT"));
  out.add(stableSymbolKey("suiUSDe"));
  out.add(stableSymbolKey("SUI_USDE"));
  out.add(stableSymbolKey("BUCK"));
  out.add(stableSymbolKey("AUSD"));
  out.add(stableSymbolKey("FDUSD"));
  out.add(stableSymbolKey("USDY"));
  stableSymbolKeyCache = out;
  return out;
}

function parseTsMs(ts) {
  const n = new Date(ts || "").getTime();
  return Number.isFinite(n) ? n : NaN;
}

async function fetchDeterministicDefiWindowSample(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false, projectionMaybe = "full") {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  const projectionKey = normalizeDefiWindowProjection(projectionMaybe);
  const projection = DEFI_WINDOW_SAMPLE_PROJECTIONS[projectionKey];
  const preset = DEFI_WINDOW_PRESETS[windowKey] || DEFI_WINDOW_PRESETS[DEFI_WINDOW_DEFAULT_KEY];
  const cacheState = getKeyedCacheState(defiWindowSampleCacheByProjection[projectionKey], windowKey);

  return withTimedCache(cacheState, DEFI_WINDOW_SAMPLE_TTL_MS, force, async () => {
    const t0 = performance.now();
    const latestHead = await fetchLatestCheckpointHead(force);
    const latestCheckpoint = Number(latestHead?.seq || 0);
    const latestTsMs = Number(latestHead?.tsMs);
    if (!latestCheckpoint || !Number.isFinite(latestTsMs)) throw new Error("Could not read latest checkpoint for DeFi window sampling.");

    const windowStartMs = latestTsMs - (preset.hours * 60 * 60 * 1000);
    const windowStartIso = new Date(windowStartMs).toISOString();
    let before = null;
    let callsUsed = latestHead?.fromCache ? 0 : 1;
    const seenDigests = new Set();
    const fetchedTxs = [];
    let hasOlder = true;
    let reachedWindowStart = false;

    while (hasOlder && callsUsed < preset.maxCalls && (performance.now() - t0) < preset.maxMs) {
      const effectFields = [
        "status",
        "timestamp",
        "checkpoint { sequenceNumber }",
      ];
      if (projection.includeGasEffects) {
        effectFields.push("gasEffects { gasSummary { computationCost storageCost storageRebate } }");
      }
      if (projection.includeBalanceChanges) {
        effectFields.push(`balanceChanges(first: 40) { nodes { ${GQL_F_BAL_NODE} } }`);
      }
      if (projection.includeObjectChanges) {
        effectFields.push(`objectChanges(first: 10) {
          nodes {
            address
            idCreated
            idDeleted
            inputState { ${GQL_F_MOVE_TYPE} }
            outputState { ${GQL_F_MOVE_TYPE} }
          }
        }`);
      }
      if (projection.includeEvents) {
        effectFields.push(`events(first: 10) {
          nodes {
            contents { type { repr } }
            sender { address }
            timestamp
          }
        }`);
      }
      const q = `query($before: String) {
        transactions(last: ${preset.pageSize}, before: $before, filter: { kind: PROGRAMMABLE_TX }) {
          pageInfo { hasPreviousPage startCursor }
          nodes {
            digest
            sender { address }
            effects {
              ${effectFields.join("\n")}
            }
            kind {
              __typename
              ... on ProgrammableTransaction {
                commands(first: 12) {
                  nodes {
                    __typename
                    ... on MoveCallCommand {
                      function { name module { name package { address } } }
                    }
                  }
                }
              }
            }
          }
        }
      }`;
      const data = await gql(q, { before });
      callsUsed++;
      const conn = data?.transactions || {};
      const nodes = conn?.nodes || [];
      if (!nodes.length) {
        hasOlder = false;
        break;
      }
      let pageMinTs = Number.POSITIVE_INFINITY;
      for (const tx of nodes) {
        if (tx?.digest && !seenDigests.has(tx.digest)) {
          seenDigests.add(tx.digest);
          fetchedTxs.push(tx);
        }
        const ts = parseTsMs(tx?.effects?.timestamp);
        if (Number.isFinite(ts) && ts < pageMinTs) pageMinTs = ts;
      }
      if (Number.isFinite(pageMinTs) && pageMinTs <= windowStartMs) reachedWindowStart = true;
      hasOlder = !!conn?.pageInfo?.hasPreviousPage;
      const nextBefore = conn?.pageInfo?.startCursor || null;
      if (!hasOlder || !nextBefore || reachedWindowStart) break;
      before = nextBefore;
    }

    const elapsedMs = performance.now() - t0;
    const inWindow = fetchedTxs.filter(tx => {
      const ts = parseTsMs(tx?.effects?.timestamp);
      return Number.isFinite(ts) && ts >= windowStartMs;
    });

    const pkgSet = new Set();
    const cpSeen = new Set();
    const cpIncluded = new Set();
    const tsIncluded = [];
    for (const tx of fetchedTxs) {
      const cp = Number(tx?.effects?.checkpoint?.sequenceNumber);
      if (Number.isFinite(cp)) cpSeen.add(cp);
    }
    for (const tx of inWindow) {
      for (const p of txMovePackages(tx)) pkgSet.add(normalizeSuiAddress(p));
      const cp = Number(tx?.effects?.checkpoint?.sequenceNumber);
      if (Number.isFinite(cp)) cpIncluded.add(cp);
      const ts = parseTsMs(tx?.effects?.timestamp);
      if (Number.isFinite(ts)) tsIncluded.push(ts);
    }
    if (pkgSet.size) await resolvePackageNames([...pkgSet]);
    const resolvedPackages = [...pkgSet].filter(p => !!mvrNameCache[p]).length;
    const latestSeenCp = cpSeen.size ? Math.max(...cpSeen) : null;
    const oldestSeenCp = cpSeen.size ? Math.min(...cpSeen) : null;
    const latestIncludedCp = cpIncluded.size ? Math.max(...cpIncluded) : null;
    const oldestIncludedCp = cpIncluded.size ? Math.min(...cpIncluded) : null;
    const newestIncludedTs = tsIncluded.length ? new Date(Math.max(...tsIncluded)).toISOString() : "";
    const oldestIncludedTs = tsIncluded.length ? new Date(Math.min(...tsIncluded)).toISOString() : "";
    const maxCallsHit = hasOlder && callsUsed >= preset.maxCalls;
    const maxMsHit = hasOlder && elapsedMs >= preset.maxMs;
    const budgetLimited = !!(maxCallsHit || maxMsHit);
    const budgetReason = maxCallsHit ? "max calls reached" : (maxMsHit ? "max time reached" : "");
    const completeWindow = reachedWindowStart || !hasOlder;

    return {
      fetchedAt: new Date().toISOString(),
      txs: inWindow,
      coverage: {
        projection: projectionKey,
        windowKey,
        windowLabel: preset.label,
        windowHours: preset.hours,
        windowStartTs: windowStartIso,
        latestCheckpointTarget: latestCheckpoint,
        latestTimestampTarget: new Date(latestTsMs).toISOString(),
        callsUsed,
        maxCalls: preset.maxCalls,
        elapsedMs,
        maxMs: preset.maxMs,
        budgetLimited,
        budgetReason,
        completeWindow,
        txFetched: fetchedTxs.length,
        txInWindow: inWindow.length,
        checkpointsScanned: cpSeen.size,
        latestCheckpointSeen: latestSeenCp,
        oldestCheckpointSeen: oldestSeenCp,
        firstCheckpointIncluded: latestIncludedCp,
        lastCheckpointIncluded: oldestIncludedCp,
        newestIncludedTs,
        oldestIncludedTs,
        uniquePackages: pkgSet.size,
        resolvedPackages,
        unresolvedPackages: Math.max(0, pkgSet.size - resolvedPackages),
      },
    };
  });
}

function buildDefiActivityFromTxs(txs = [], sharedCoverage = {}) {
  const byProtocol = {};
  const txRows = [];
  const txConfidence = { high: 0, medium: 0, low: 0 };
  let unknownCategoryTx = 0;
  for (const tx of (txs || [])) {
    const protos = {};
    for (const pkg of txMovePackages(tx)) {
      const info = protocolInfoFromPackage(normalizeSuiAddress(pkg));
      if (info.category === "system") continue;
      const key = info.canonical || info.rawName || info.pkgAddr;
      if (!key || protos[key]) continue;
      protos[key] = info;
    }
    const txProtocols = Object.values(protos);
    if (!txProtocols.length) continue;
    const hasHigh = txProtocols.some(p => p.confidence === "high");
    const hasMedium = txProtocols.some(p => p.confidence === "medium");
    if (hasHigh) txConfidence.high++;
    else if (hasMedium) txConfidence.medium++;
    else txConfidence.low++;
    if (txProtocols.every(p => p.category === "other")) unknownCategoryTx++;
    txRows.push({
      digest: tx.digest,
      sender: tx.sender?.address || "",
      status: tx.effects?.status || "",
      timestamp: tx.effects?.timestamp || "",
      protocols: txProtocols,
    });
    for (const p of txProtocols) {
      const key = p.canonical || p.pkgAddr;
      if (!byProtocol[key]) {
        byProtocol[key] = {
          key,
          display: p.display,
          canonical: p.canonical,
          category: p.category,
          confidence: p.confidence,
          package: p.pkgAddr,
          txCount: 0,
          successCount: 0,
          latestTx: "",
          latestTs: "",
        };
      }
      byProtocol[key].txCount++;
      if (tx.effects?.status === "SUCCESS") byProtocol[key].successCount++;
      const ts = tx.effects?.timestamp || "";
      const currentTs = byProtocol[key].latestTs || "";
      if (!currentTs || (ts && parseTsMs(ts) > parseTsMs(currentTs))) {
        byProtocol[key].latestTs = ts;
        byProtocol[key].latestTx = tx.digest;
      }
    }
  }
  const protocols = Object.values(byProtocol).sort((a, b) => (b.txCount - a.txCount) || (b.successCount - a.successCount));
  const categories = {};
  for (const p of protocols) categories[p.category] = (categories[p.category] || 0) + p.txCount;
  const successTxs = txRows.filter(t => t.status === "SUCCESS").length;
  const protocolConfidenceTx = { high: 0, medium: 0, low: 0 };
  for (const p of protocols) {
    const key = p.confidence === "high" || p.confidence === "medium" ? p.confidence : "low";
    protocolConfidenceTx[key] += p.txCount;
  }
  return {
    txRows,
    protocols,
    categories,
    successRate: txRows.length ? (successTxs / txRows.length) : 0,
    coverage: {
      resolvedPackages: sharedCoverage.resolvedPackages || 0,
      unresolvedPackages: sharedCoverage.unresolvedPackages || 0,
      trackedTxs: txRows.length,
      highConfidenceTx: txConfidence.high,
      mediumConfidenceTx: txConfidence.medium,
      lowConfidenceTx: txConfidence.low,
      unknownCategoryTx,
      highConfidenceProtocolTx: protocolConfidenceTx.high,
      mediumConfidenceProtocolTx: protocolConfidenceTx.medium,
      lowConfidenceProtocolTx: protocolConfidenceTx.low,
      completeWindow: !!sharedCoverage.completeWindow,
      budgetLimited: !!sharedCoverage.budgetLimited,
    },
  };
}

function buildPackageActivityFromTxs(txs = [], sharedCoverage = {}) {
  const byPkg = {};
  const coverage = {
    txWithAnyPackage: 0,
    txWithResolvedPackage: 0,
    txUnknownOnly: 0,
    txSystemOnly: 0,
  };

  for (const tx of (txs || [])) {
    const moveCalls = (tx?.kind?.commands?.nodes || []).filter(c => c?.__typename === "MoveCallCommand");
    const txPkgMap = {};
    for (const c of moveCalls) {
      const pkg = normalizeSuiAddress(c?.function?.module?.package?.address);
      if (!pkg) continue;
      const mod = String(c?.function?.module?.name || "");
      const fn = String(c?.function?.name || "");
      const info = protocolInfoFromPackage(pkg);
      const source = info.rawName ? "mvr" : (PACKAGE_PROTOCOL_OVERRIDES[pkg] ? "override" : "unknown");
      if (!byPkg[pkg]) {
        byPkg[pkg] = {
          package: pkg,
          display: info.display,
          rawName: info.rawName,
          canonical: info.canonical,
          category: info.category,
          confidence: info.confidence,
          source,
          txCount: 0,
          callCount: 0,
          successCount: 0,
          latestTs: "",
          latestTx: "",
          moduleCounts: {},
          functionCounts: {},
          eventTypeCounts: {},
          objectCounts: {},
          objectTypeCounts: {},
          senderSet: new Set(),
          recentTxs: [],
          totalGas: 0,
          gasTxCount: 0,
        };
      }
      const row = byPkg[pkg];
      row.callCount++;
      if (mod) bumpCount(row.moduleCounts, mod, 1);
      if (mod && fn) bumpCount(row.functionCounts, `${mod}::${fn}`, 1);
      if (!txPkgMap[pkg]) txPkgMap[pkg] = { callCount: 0, modules: new Set(), functions: new Set() };
      txPkgMap[pkg].callCount++;
      if (mod) txPkgMap[pkg].modules.add(mod);
      if (mod && fn) txPkgMap[pkg].functions.add(`${mod}::${fn}`);
    }

    for (const ev of (tx?.effects?.events?.nodes || [])) {
      const evType = String(ev?.contents?.type?.repr || "");
      const pkg = packageFromTypeRepr(evType);
      if (!pkg || !byPkg[pkg]) continue;
      bumpCount(byPkg[pkg].eventTypeCounts, shortType(evType) || evType, 1);
    }

    for (const oc of (tx?.effects?.objectChanges?.nodes || [])) {
      const inType = oc?.inputState?.asMoveObject?.contents?.type?.repr || "";
      const outType = oc?.outputState?.asMoveObject?.contents?.type?.repr || "";
      const pkgList = [...new Set([packageFromTypeRepr(inType), packageFromTypeRepr(outType)].filter(Boolean))];
      if (!pkgList.length) continue;
      const objAddr = normalizeSuiAddress(oc?.address || oc?.idCreated || oc?.idDeleted || "");
      const objLabel = objAddr || shortType(outType || inType) || "unknown";
      const objTypeLabel = shortType(outType || inType) || "unknown";
      for (const pkg of pkgList) {
        if (!byPkg[pkg]) continue;
        bumpCount(byPkg[pkg].objectCounts, objLabel, 1);
        bumpCount(byPkg[pkg].objectTypeCounts, objTypeLabel, 1);
      }
    }

    // Per-tx gas cost
    const txGs = tx?.effects?.gasEffects?.gasSummary;
    const txGasCost = txGs ? Number(txGs.computationCost) + Number(txGs.storageCost) - Number(txGs.storageRebate) : 0;

    const pkgKeys = Object.keys(txPkgMap);
    if (!pkgKeys.length) continue;
    coverage.txWithAnyPackage++;
    let hasResolved = false;
    let hasNonSystem = false;
    const txStatus = tx?.effects?.status || "";
    const txTs = tx?.effects?.timestamp || "";
    const txSender = normalizeSuiAddress(tx?.sender?.address || "");
    for (const pkg of pkgKeys) {
      const row = byPkg[pkg];
      row.txCount++;
      if (txGasCost > 0) { row.totalGas += txGasCost; row.gasTxCount++; }
      if (txStatus === "SUCCESS") row.successCount++;
      if (!row.latestTs || (txTs && parseTsMs(txTs) > parseTsMs(row.latestTs))) {
        row.latestTs = txTs;
        row.latestTx = tx.digest;
      }
      if (txSender) row.senderSet.add(txSender);
      const txPkg = txPkgMap[pkg];
      row.recentTxs.push({
        digest: tx.digest,
        status: txStatus,
        timestamp: txTs,
        sender: txSender,
        callCount: txPkg.callCount,
        modules: [...txPkg.modules],
        functions: [...txPkg.functions],
      });
      if (row.source !== "unknown") hasResolved = true;
      if (row.category !== "system") hasNonSystem = true;
    }
    if (!hasNonSystem) coverage.txSystemOnly++;
    else if (hasResolved) coverage.txWithResolvedPackage++;
    else coverage.txUnknownOnly++;
  }

  let rows = Object.values(byPkg).filter(r => r.category !== "system");
  for (const r of rows) {
    r.uniqueSenders = r.senderSet.size;
    r.successRate = r.txCount ? (r.successCount / r.txCount) : 0;
    r.topModules = topCountRows(r.moduleCounts, 6);
    r.topFunctions = topCountRows(r.functionCounts, 8);
    r.topEventTypes = topCountRows(r.eventTypeCounts, 8);
    r.topObjects = topCountRows(r.objectCounts, 8);
    r.topObjectTypes = topCountRows(r.objectTypeCounts, 8);
    r.avgGas = r.gasTxCount > 0 ? r.totalGas / r.gasTxCount : 0;
    r.recentTxs = r.recentTxs
      .sort((a, b) => parseTsMs(b.timestamp) - parseTsMs(a.timestamp))
      .slice(0, 8);
    delete r.senderSet;
  }
  rows.sort((a, b) => (b.txCount - a.txCount) || (b.callCount - a.callCount));

  const bySource = {
    mvr: rows.filter(r => r.source === "mvr").length,
    override: rows.filter(r => r.source === "override").length,
    unknown: rows.filter(r => r.source === "unknown").length,
  };
  const unresolved = rows
    .filter(r => r.source === "unknown")
    .sort((a, b) => (b.txCount - a.txCount) || (b.callCount - a.callCount))
    .slice(0, 20)
    .map(r => ({ package: r.package, display: r.display, txCount: r.txCount, callCount: r.callCount }));

  return {
    packages: rows,
    coverage: {
      ...coverage,
      uniquePackages: rows.length,
      resolvedPackages: bySource.mvr + bySource.override,
      mvrResolvedPackages: bySource.mvr,
      overrideResolvedPackages: bySource.override,
      unresolvedPackages: bySource.unknown,
      txResolvedPct: coverage.txWithAnyPackage ? (coverage.txWithResolvedPackage / coverage.txWithAnyPackage * 100) : 0,
      completeWindow: !!sharedCoverage.completeWindow,
      budgetLimited: !!sharedCoverage.budgetLimited,
    },
    unresolvedPackages: unresolved,
  };
}

function buildDefiDexFromActivity(activity, sharedCoverage = {}) {
  const dexProtocols = (activity?.protocols || []).filter(p => p.category === "dex");
  const dexTxRows = (activity?.txRows || []).filter(tx => tx.protocols.some(p => p.category === "dex"));
  const successRate = dexTxRows.length ? (dexTxRows.filter(t => t.status === "SUCCESS").length / dexTxRows.length) : 0;
  const txConfidence = { high: 0, medium: 0, low: 0 };
  for (const tx of dexTxRows) {
    const protos = tx.protocols.filter(p => p.category === "dex");
    if (!protos.length) continue;
    if (protos.some(p => p.confidence === "high")) txConfidence.high++;
    else if (protos.some(p => p.confidence === "medium")) txConfidence.medium++;
    else txConfidence.low++;
  }
  const resolvedProtocols = dexProtocols.filter(p => p.confidence !== "low").length;
  return {
    dexProtocols: dexProtocols.slice(0, 20),
    dexTxRows: dexTxRows.slice(0, 100),
    dexTxCount: dexTxRows.length,
    successRate,
    coverage: {
      trackedTxs: dexTxRows.length,
      highConfidenceTx: txConfidence.high,
      mediumConfidenceTx: txConfidence.medium,
      lowConfidenceTx: txConfidence.low,
      resolvedProtocols,
      unresolvedProtocols: Math.max(0, dexProtocols.length - resolvedProtocols),
      completeWindow: !!sharedCoverage.completeWindow,
      budgetLimited: !!sharedCoverage.budgetLimited,
    },
  };
}

function buildDefiFlowFromTxs(txs = [], sharedCoverage = {}) {
  const rows = [];
  let coinBucketsSeen = 0;
  let unpricedCoinBuckets = 0;
  for (const tx of (txs || [])) {
    const proto = (txMovePackages(tx).map(p => protocolInfoFromPackage(normalizeSuiAddress(p))).find(p => p.category !== "system" && p.category !== "other"))
      || (txMovePackages(tx).map(p => protocolInfoFromPackage(normalizeSuiAddress(p))).find(p => p.category !== "system"))
      || { display: "Unknown", category: "other" };
    const protoConfidence = proto.confidence === "high" || proto.confidence === "medium" ? proto.confidence : "low";
    const bcs = tx?.effects?.balanceChanges?.nodes || [];
    const byCoin = {};
    for (const bc of bcs) {
      const ct = bc?.coinType?.repr;
      if (!ct) continue;
      if (!byCoin[ct]) byCoin[ct] = [];
      byCoin[ct].push(bc);
    }
    for (const [ct, changes] of Object.entries(byCoin)) {
      coinBucketsSeen++;
      const resolved = resolveCoinType(ct);
      const price = Number(defiPrices[resolved.symbol] || 0);
      if (!(price > 0)) {
        unpricedCoinBuckets++;
        continue;
      }
      const senders = changes.filter(c => Number(c.amount) < 0);
      const receivers = changes.filter(c => Number(c.amount) > 0);
      const totalSent = senders.reduce((s, c) => s + Math.abs(Number(c.amount || 0)), 0);
      if (!(totalSent > 0)) continue;
      const amount = totalSent / Math.pow(10, resolved.decimals || 9);
      const usdValue = amount * price;
      rows.push({
        protocol: proto.display,
        category: proto.category,
        symbol: resolved.symbol,
        amount,
        usdValue,
        from: senders[0]?.owner?.address || tx?.sender?.address || "",
        to: receivers[0]?.owner?.address || "",
        digest: tx.digest,
        status: tx?.effects?.status || "",
        timestamp: tx?.effects?.timestamp || "",
        protocolConfidence: protoConfidence,
      });
    }
  }
  rows.sort((a, b) => b.usdValue - a.usdValue);
  const totalUsd = rows.reduce((s, r) => s + r.usdValue, 0);
  const confidenceCounts = { high: 0, medium: 0, low: 0 };
  for (const r of rows) {
    const ck = r.protocolConfidence === "high" || r.protocolConfidence === "medium" ? r.protocolConfidence : "low";
    confidenceCounts[ck]++;
  }
  return {
    rows,
    totalUsd,
    protocols: [...new Set(rows.map(r => r.protocol))],
    coverage: {
      sampleTxs: txs.length,
      flowRows: rows.length,
      highConfidenceRows: confidenceCounts.high,
      mediumConfidenceRows: confidenceCounts.medium,
      lowConfidenceRows: confidenceCounts.low,
      unknownProtocolRows: rows.filter(r => r.protocolConfidence === "low" || r.protocol === "Unknown").length,
      coinBucketsSeen,
      unpricedCoinBuckets,
      resolvedPackages: sharedCoverage.resolvedPackages || 0,
      unresolvedPackages: sharedCoverage.unresolvedPackages || 0,
      completeWindow: !!sharedCoverage.completeWindow,
      budgetLimited: !!sharedCoverage.budgetLimited,
    },
  };
}

async function fetchGraphqlServiceConfig(force = false) {
  return withTimedCache(gqlServiceConfigCache, GQL_SERVICE_CONFIG_TTL_MS, force, async () => {
    const data = await gql(`{ serviceConfig { maxMultiGetSize queryTimeoutMs maxQueryDepth maxQueryNodes maxQueryPayloadSize } }`);
    const sc = data?.serviceConfig || {};
    return {
      maxMultiGetSize: Number(sc.maxMultiGetSize || 200),
      queryTimeoutMs: Number(sc.queryTimeoutMs || 40000),
      maxQueryDepth: Number(sc.maxQueryDepth || 20),
      maxQueryNodes: Number(sc.maxQueryNodes || 300),
      maxQueryPayloadSize: Number(sc.maxQueryPayloadSize || 5000),
    };
  });
}

async function buildHistoricalCheckpointPlan(days, segmentDays = 5) {
  const t0 = performance.now();
  const latestHead = await fetchLatestCheckpointHead(false);
  const latestCp = Number(latestHead?.seq || 0);
  const latestTs = Number(latestHead?.tsMs);
  if (!latestCp || !Number.isFinite(latestTs)) throw new Error("Could not load latest checkpoint for history.");

  let queryCount = latestHead?.fromCache ? 0 : 1;
  const bootstrapCp = Math.max(1, latestCp - DEFI_HISTORY_BOOTSTRAP_CP_DELTA);
  let cpPerDay = 330000;
  if (bootstrapCp < latestCp) {
    const boot = await gql(`query($cp: UInt53!){ checkpoint(sequenceNumber: $cp) { sequenceNumber timestamp } }`, { cp: bootstrapCp });
    queryCount++;
    const bootTs = new Date(boot?.checkpoint?.timestamp || "").getTime();
    if (Number.isFinite(bootTs) && latestTs > bootTs) {
      cpPerDay = (latestCp - bootstrapCp) / ((latestTs - bootTs) / DEFI_HISTORY_DAY_MS);
    }
  }

  const points = [{ daysAgo: 0, targetTs: latestTs, checkpoint: latestCp }];
  let cpCursor = latestCp;
  let tsCursor = latestTs;
  let daysDone = 0;
  while (daysDone < days && cpCursor > 1) {
    const segDays = Math.min(segmentDays, days - daysDone);
    let segCp = Math.max(1, Math.round(cpCursor - (cpPerDay * segDays)));
    if (segCp >= cpCursor) segCp = Math.max(1, cpCursor - 1);

    const segData = await gql(`query($cp: UInt53!){ checkpoint(sequenceNumber: $cp) { sequenceNumber timestamp } }`, { cp: segCp });
    queryCount++;
    const segNode = segData?.checkpoint;
    if (!segNode) break;
    const segTs = new Date(segNode.timestamp || "").getTime();

    const actualDays = (Number.isFinite(segTs) && tsCursor > segTs)
      ? ((tsCursor - segTs) / DEFI_HISTORY_DAY_MS)
      : segDays;
    const spanCp = cpCursor - segCp;
    const spanTs = (Number.isFinite(segTs) && tsCursor > segTs)
      ? (tsCursor - segTs)
      : (segDays * DEFI_HISTORY_DAY_MS);
    const segCpPerDay = actualDays > 0 ? (spanCp / actualDays) : cpPerDay;
    for (let i = 1; i <= segDays; i++) {
      const d = daysDone + i;
      const targetTs = latestTs - (d * DEFI_HISTORY_DAY_MS);
      let ratio = i / segDays;
      if (spanTs > 0) ratio = (tsCursor - targetTs) / spanTs;
      if (!Number.isFinite(ratio)) ratio = i / segDays;
      ratio = Math.max(-0.15, Math.min(1.25, ratio));
      points.push({
        daysAgo: d,
        targetTs,
        checkpoint: Math.max(1, Math.round(cpCursor - (spanCp * ratio))),
      });
    }

    cpCursor = segCp;
    tsCursor = Number.isFinite(segTs) ? segTs : (tsCursor - segDays * DEFI_HISTORY_DAY_MS);
    cpPerDay = segCpPerDay > 0 ? segCpPerDay : cpPerDay;
    daysDone += segDays;
  }

  const byDay = {};
  for (const p of points) if (!(p.daysAgo in byDay)) byDay[p.daysAgo] = p;
  const ordered = Object.values(byDay).sort((a, b) => b.daysAgo - a.daysAgo); // oldest -> newest
  return {
    latestCheckpoint: latestCp,
    latestTimestamp: new Date(latestTs).toISOString(),
    cpPerDayEstimate: cpPerDay,
    segmentDays,
    queryCount,
    mappingMs: performance.now() - t0,
    points: ordered,
  };
}

async function fetchHistoricalNetworkTxSeries(plan, batchSize = 200) {
  const t0 = performance.now();
  const uniqueKeys = [...new Set((plan?.points || []).map(p => p.checkpoint).filter(Boolean))];
  const rowsByCp = {};
  let queryCount = 0;
  for (const keys of chunkArray(uniqueKeys, Math.max(1, batchSize))) {
    const data = await gql(
      `query($keys:[UInt53!]!){
        multiGetCheckpoints(keys:$keys){
          sequenceNumber
          timestamp
          networkTotalTransactions
        }
      }`,
      { keys }
    );
    queryCount++;
    for (const row of (data?.multiGetCheckpoints || [])) rowsByCp[row.sequenceNumber] = row;
  }

  const resolved = (plan?.points || []).map(p => {
    const row = rowsByCp[p.checkpoint];
    return {
      checkpoint: p.checkpoint,
      daysAgo: p.daysAgo,
      targetTs: p.targetTs,
      ts: row?.timestamp || "",
      tsMs: row?.timestamp ? new Date(row.timestamp).getTime() : NaN,
      cumulative: Number(row?.networkTotalTransactions),
    };
  });

  const driftMinutes = resolved
    .filter(r => Number.isFinite(r.tsMs))
    .map(r => Math.abs(r.tsMs - r.targetTs) / 60000);

  const daily = [];
  for (let i = 1; i < resolved.length; i++) {
    const prev = resolved[i - 1];
    const cur = resolved[i];
    let value = null;
    if (Number.isFinite(cur.cumulative) && Number.isFinite(prev.cumulative)) {
      value = Math.max(0, cur.cumulative - prev.cumulative);
    }
    daily.push({
      checkpoint: cur.checkpoint,
      ts: cur.ts,
      label: fmtDayShort(cur.ts),
      value,
    });
  }

  return {
    mode: "network",
    series: daily,
    coverage: {
      requestedPoints: plan?.points?.length || 0,
      resolvedPoints: resolved.filter(r => Number.isFinite(r.cumulative)).length,
      validValues: daily.filter(d => Number.isFinite(d.value)).length,
      driftAvgMin: driftMinutes.length ? (driftMinutes.reduce((s, v) => s + v, 0) / driftMinutes.length) : null,
      driftP95Min: quantile(driftMinutes, 0.95),
      driftMaxMin: driftMinutes.length ? Math.max(...driftMinutes) : null,
    },
    queryCount,
    dataMs: performance.now() - t0,
  };
}

async function fetchHistoricalObjectSeries(plan, objectId, formatExpr, batchSize = 200) {
  const t0 = performance.now();
  const uniqueKeys = [...new Set((plan?.points || []).map(p => p.checkpoint).filter(Boolean))];
  const rowsByCp = {};
  let queryCount = 0;
  for (const keys of chunkArray(uniqueKeys, Math.max(1, batchSize))) {
    const data = await gql(
      `query($keys:[UInt53!]!,$obj:SuiAddress!,$fmt:String!){
        multiGetCheckpoints(keys:$keys){
          sequenceNumber
          timestamp
          query {
            object(address:$obj){
              address
              version
              asMoveObject { contents { value: format(format:$fmt) } }
            }
          }
        }
      }`,
      { keys, obj: objectId, fmt: formatExpr }
    );
    queryCount++;
    for (const row of (data?.multiGetCheckpoints || [])) rowsByCp[row.sequenceNumber] = row;
  }

  const resolved = (plan?.points || []).map(p => {
    const row = rowsByCp[p.checkpoint];
    const raw = row?.query?.object?.asMoveObject?.contents?.value;
    const value = parseHistoryNumericValue(raw);
    return {
      checkpoint: p.checkpoint,
      daysAgo: p.daysAgo,
      targetTs: p.targetTs,
      ts: row?.timestamp || "",
      tsMs: row?.timestamp ? new Date(row.timestamp).getTime() : NaN,
      value,
      raw,
      version: Number(row?.query?.object?.version),
    };
  });

  const driftMinutes = resolved
    .filter(r => Number.isFinite(r.tsMs))
    .map(r => Math.abs(r.tsMs - r.targetTs) / 60000);

  return {
    mode: "object",
    series: resolved.map(r => ({
      checkpoint: r.checkpoint,
      ts: r.ts,
      label: fmtDayShort(r.ts),
      value: Number.isFinite(r.value) ? r.value : null,
      version: Number.isFinite(r.version) ? r.version : null,
    })),
    coverage: {
      requestedPoints: plan?.points?.length || 0,
      resolvedPoints: resolved.filter(r => r.raw != null).length,
      validValues: resolved.filter(r => Number.isFinite(r.value)).length,
      driftAvgMin: driftMinutes.length ? (driftMinutes.reduce((s, v) => s + v, 0) / driftMinutes.length) : null,
      driftP95Min: quantile(driftMinutes, 0.95),
      driftMaxMin: driftMinutes.length ? Math.max(...driftMinutes) : null,
    },
    queryCount,
    dataMs: performance.now() - t0,
  };
}

async function fetchDefiHistorySnapshot(opts = {}, force = false) {
  const metric = opts?.metric === "network" ? "network" : "object";
  const rangeKey = DEFI_HISTORY_PRESETS[opts?.range] ? opts.range : "1W";
  const preset = DEFI_HISTORY_PRESETS[rangeKey];
  const rawObj = String(opts?.objectId || DEFAULT_DEFI_HISTORY_OBJECT).trim();
  const objectId = rawObj.startsWith("0x") ? rawObj : ("0x" + rawObj);
  const formatExpr = String(opts?.formatExpr || DEFAULT_DEFI_HISTORY_FORMAT).trim() || DEFAULT_DEFI_HISTORY_FORMAT;
  const cacheKey = `${metric}|${rangeKey}|${objectId.toLowerCase()}|${formatExpr}`;
  if (!defiHistoryCache[cacheKey]) defiHistoryCache[cacheKey] = { data: null, ts: 0, inFlight: null };

  return withTimedCache(defiHistoryCache[cacheKey], DEFI_HISTORY_TTL_MS, force, async () => {
    const totalStart = performance.now();
    const [serviceConfig, plan] = await Promise.all([
      fetchGraphqlServiceConfig(),
      buildHistoricalCheckpointPlan(preset.days, preset.segmentDays),
    ]);
    const maxBatch = Math.max(1, Math.min(Number(serviceConfig?.maxMultiGetSize || 200), 200));
    const fetched = metric === "network"
      ? await fetchHistoricalNetworkTxSeries(plan, maxBatch)
      : await fetchHistoricalObjectSeries(plan, objectId, formatExpr, maxBatch);

    const values = (fetched.series || []).map(s => s.value).filter(Number.isFinite);
    const latestVal = values.length ? values[values.length - 1] : null;
    const prevVal = values.length > 1 ? values[values.length - 2] : null;
    const delta = (latestVal != null && prevVal != null) ? (latestVal - prevVal) : null;
    const deltaPct = (delta != null && prevVal && Number.isFinite(prevVal) && prevVal !== 0) ? (delta / prevVal * 100) : null;

    return {
      fetchedAt: new Date().toISOString(),
      metric,
      range: rangeKey,
      preset,
      objectId,
      formatExpr,
      serviceConfig,
      mapping: {
        latestCheckpoint: plan.latestCheckpoint,
        latestTimestamp: plan.latestTimestamp,
        cpPerDayEstimate: plan.cpPerDayEstimate,
        segmentDays: plan.segmentDays,
      },
      coverage: fetched.coverage,
      performance: {
        mappingMs: plan.mappingMs,
        dataMs: fetched.dataMs,
        totalMs: performance.now() - totalStart,
        queryCount: plan.queryCount + fetched.queryCount,
        maxBatch,
      },
      stats: {
        points: fetched.series.length,
        latest: latestVal,
        previous: prevVal,
        delta,
        deltaPct,
        min: values.length ? Math.min(...values) : null,
        max: values.length ? Math.max(...values) : null,
      },
      series: fetched.series,
    };
  });
}

async function fetchRecentDefiActivity(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false) {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  const cacheState = getKeyedCacheState(defiActivityCacheByWindow, windowKey);
  return withTimedCache(cacheState, DEFI_ACTIVITY_TTL_MS, force, async () => {
    const sample = await fetchDeterministicDefiWindowSample(windowKey, force, "base");
    const txs = sample?.txs || [];
    const activity = buildDefiActivityFromTxs(txs, sample.coverage || {});
    return {
      fetchedAt: new Date().toISOString(),
      sampleSize: sample?.coverage?.txInWindow || 0,
      txRows: activity?.txRows || [],
      protocols: activity?.protocols || [],
      categories: activity?.categories || {},
      uniquePackages: sample?.coverage?.uniquePackages || 0,
      successRate: activity?.successRate || 0,
      coverage: {
        ...(activity?.coverage || {}),
        sampleCoverage: sample?.coverage || {},
      },
      window: sample?.coverage || {},
    };
  });
}

async function fetchPackageActivitySnapshot(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false) {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  const cacheState = getKeyedCacheState(packageActivityCacheByWindow, windowKey);
  const storageKey = persistedWindowCacheKey(PERSISTED_CACHE_KEYS.packageActivityPrefix, windowKey);
  hydratePersistedTimedCacheState(cacheState, storageKey, PACKAGE_ACTIVITY_TTL_MS);
  return withTimedCache(cacheState, PACKAGE_ACTIVITY_TTL_MS, force, async () => {
    const sample = await fetchDeterministicDefiWindowSample(windowKey, force, "package");
    const packages = buildPackageActivityFromTxs(sample?.txs || [], sample?.coverage || {});
    const result = {
      fetchedAt: new Date().toISOString(),
      sampleSize: sample?.coverage?.txInWindow || 0,
      packages: packages?.packages || [],
      coverage: {
        ...(packages?.coverage || {}),
        sampleCoverage: sample?.coverage || {},
      },
      unresolvedPackages: packages?.unresolvedPackages || [],
      window: sample?.coverage || {},
    };
    writePersistedTimedCacheRecord(storageKey, result, 160000);
    return result;
  });
}

async function fetchDefiOverviewParity(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false) {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  const cacheState = getKeyedCacheState(defiOverviewParityCacheByWindow, windowKey);
  return withTimedCache(cacheState, DEFI_OVERVIEW_TTL_MS, force, async () => {
    const [baseSample, packagesSnapshot, dexSnapshot] = await Promise.all([
      fetchDeterministicDefiWindowSample(windowKey, force, "base"),
      fetchPackageActivitySnapshot(windowKey, force),
      fetchDefiDexSnapshot(windowKey, force),
    ]);
    const overviewPackages = buildPackageActivityFromTxs(baseSample?.txs || [], baseSample?.coverage || {});
    const overviewDex = buildDefiDexFromActivity(
      buildDefiActivityFromTxs(baseSample?.txs || [], baseSample?.coverage || {}),
      baseSample?.coverage || {}
    );
    const parity = {
      windowKey,
      windowLabel: baseSample?.coverage?.windowLabel || packagesSnapshot?.window?.windowLabel || dexSnapshot?.window?.windowLabel || "",
      packagesRowsOverview: overviewPackages?.coverage?.uniquePackages || 0,
      packagesRowsPackages: packagesSnapshot?.coverage?.uniquePackages || 0,
      dexProtocolsOverview: overviewDex?.dexProtocols?.length || 0,
      dexProtocolsDex: dexSnapshot?.dexProtocols?.length || 0,
      dexTrackedTxOverview: overviewDex?.coverage?.trackedTxs || 0,
      dexTrackedTxDex: dexSnapshot?.coverage?.trackedTxs || 0,
      mismatches: [],
    };
    if (parity.packagesRowsOverview !== parity.packagesRowsPackages) {
      parity.mismatches.push(`packages rows mismatch (${fmtNumber(parity.packagesRowsOverview)} vs ${fmtNumber(parity.packagesRowsPackages)})`);
    }
    if (parity.dexProtocolsOverview !== parity.dexProtocolsDex) {
      parity.mismatches.push(`dex protocol count mismatch (${fmtNumber(parity.dexProtocolsOverview)} vs ${fmtNumber(parity.dexProtocolsDex)})`);
    }
    if (parity.dexTrackedTxOverview !== parity.dexTrackedTxDex) {
      parity.mismatches.push(`dex tracked tx mismatch (${fmtNumber(parity.dexTrackedTxOverview)} vs ${fmtNumber(parity.dexTrackedTxDex)})`);
    }
    return parity;
  });
}

async function fetchPackageModuleNamesByAddress(addresses) {
  const unique = [...new Set((addresses || []).map(normalizeSuiAddress).filter(Boolean))];
  const modulesByAddress = {};
  if (!unique.length) return modulesByAddress;

  for (const chunk of chunkArray(unique, 6)) {
    const vars = {};
    const varDefs = [];
    const fields = [];
    chunk.forEach((addr, i) => {
      const varName = `addr${i}`;
      vars[varName] = addr;
      varDefs.push(`$${varName}: SuiAddress!`);
      fields.push(`p${i}: object(address: $${varName}) { asMovePackage { modules(first: 250) { nodes { name } } } }`);
    });

    try {
      const data = await gql(`query(${varDefs.join(", ")}) { ${fields.join("\n")} }`, vars);
      chunk.forEach((addr, i) => {
        modulesByAddress[addr] = (data?.[`p${i}`]?.asMovePackage?.modules?.nodes || [])
          .map(m => m?.name)
          .filter(Boolean);
      });
    } catch (_) {
      await Promise.all(chunk.map(async (addr) => {
        try {
          const data = await gql(`query($addr: SuiAddress!) {
            object(address: $addr) { asMovePackage { modules(first: 250) { nodes { name } } } }
          }`, { addr });
          modulesByAddress[addr] = (data?.object?.asMovePackage?.modules?.nodes || [])
            .map(m => m?.name)
            .filter(Boolean);
        } catch (_) {
          modulesByAddress[addr] = [];
        }
      }));
    }
  }

  return modulesByAddress;
}

async function fetchPackageUpgradeSnapshot(pkgAddr, force = false) {
  const pkg = normalizeSuiAddress(pkgAddr);
  if (!pkg) return { package: "", versions: [], moduleDiff: null, modulesByAddress: {} };
  if (!packageDetailCache[pkg]) packageDetailCache[pkg] = { data: null, ts: 0, inFlight: null };
  return withTimedCache(packageDetailCache[pkg], PACKAGE_DETAIL_TTL_MS, force, async () => {
    const pvData = await gql(`query($pkg: SuiAddress!) {
      packageVersions(address: $pkg, last: 20) {
        nodes { address version previousTransaction { digest } }
      }
    }`, { pkg });
    const versions = (pvData?.packageVersions?.nodes || [])
      .map(v => ({
        address: normalizeSuiAddress(v?.address || ""),
        version: Number(v?.version || 0),
        txDigest: v?.previousTransaction?.digest || "",
      }))
      .filter(v => v.address)
      .sort((a, b) => a.version - b.version);

    const versionAddresses = [...new Set(versions.map(v => v.address))].slice(-8);
    const modulesByAddress = await fetchPackageModuleNamesByAddress(versionAddresses);

    let moduleDiff = null;
    if (versions.length >= 2) {
      const prev = versions[versions.length - 2];
      const latest = versions[versions.length - 1];
      const prevSet = new Set(modulesByAddress[prev.address] || []);
      const latestSet = new Set(modulesByAddress[latest.address] || []);
      const addedModules = [...latestSet].filter(m => !prevSet.has(m)).sort();
      const removedModules = [...prevSet].filter(m => !latestSet.has(m)).sort();
      const unchangedCount = [...latestSet].filter(m => prevSet.has(m)).length;
      moduleDiff = {
        fromVersion: prev.version,
        toVersion: latest.version,
        fromAddress: prev.address,
        toAddress: latest.address,
        addedModules,
        removedModules,
        unchangedCount,
      };
    }

    return {
      fetchedAt: new Date().toISOString(),
      package: pkg,
      versions,
      modulesByAddress,
      moduleDiff,
    };
  });
}

async function fetchDefiOverviewSnapshot(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false) {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  const cacheState = getKeyedCacheState(defiOverviewCacheByWindow, windowKey);
  const storageKey = persistedWindowCacheKey(PERSISTED_CACHE_KEYS.defiOverviewPrefix, windowKey);
  hydratePersistedTimedCacheState(cacheState, storageKey, DEFI_OVERVIEW_TTL_MS);
  return withTimedCache(cacheState, DEFI_OVERVIEW_TTL_MS, force, async () => {
    await fetchDefiPrices();
    const [activity, lending, stable, lst] = await Promise.all([
      fetchRecentDefiActivity(windowKey, force),
      fetchLendingRatesOverview(force),
      fetchStablecoinSupply(),
      fetchDefiLstSnapshot(force),
    ]);
    const lendingLive = ["SUI", "USDC"].reduce((acc, token) => {
      const rows = lending?.byToken?.[token] || [];
      return acc + rows.filter(r => Number.isFinite(r.borrowBps) && Number.isFinite(r.supplyBps)).length;
    }, 0);
    const topProtocols = activity.protocols.slice(0, 12);
    const categoryRows = Object.entries(activity.categories)
      .map(([category, txCount]) => ({ category, txCount }))
      .sort((a, b) => b.txCount - a.txCount);
    const coverage = activity.coverage || {};
    const topProtocol = topProtocols[0] || null;
    const topCategory = categoryRows[0] || null;
    const totalCategoryTx = categoryRows.reduce((s, c) => s + c.txCount, 0);
    const topCategoryShare = totalCategoryTx > 0 && topCategory ? (topCategory.txCount / totalCategoryTx * 100) : 0;
    const signals = [
      topProtocol
        ? `${topProtocol.display} leads recent activity (${fmtNumber(topProtocol.txCount)} txs, ${(topProtocol.txCount ? (topProtocol.successCount / topProtocol.txCount * 100) : 0).toFixed(1)}% success).`
        : "No protocol activity in the current sample.",
      topCategory
        ? `${topCategory.category} is the dominant category (${topCategoryShare.toFixed(1)}% share of tracked DeFi txs).`
        : "No category mix is currently available.",
      coverage.trackedTxs
        ? `${((coverage.highConfidenceTx || 0) / coverage.trackedTxs * 100).toFixed(1)}% of tracked txs are high-confidence mapped; ${fmtNumber(coverage.lowConfidenceTx || 0)} are low-confidence.`
        : "Coverage metrics are not available for this sample.",
    ];
    const result = {
      fetchedAt: new Date().toISOString(),
      activity,
      topProtocols,
      categoryRows,
      lendingLive,
      stableTotalSupply: stable?.totalSupply || 0,
      lstTotalMcap: lst?.totalMcap || 0,
      suiPrice: defiPrices.SUI || 0,
      coverage,
      signals,
      window: activity?.window || {},
    };
    writePersistedTimedCacheRecord(storageKey, result, 80000);
    return result;
  });
}

async function fetchDefiDexSnapshot(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false) {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  const cacheState = getKeyedCacheState(defiDexCacheByWindow, windowKey);
  const storageKey = persistedWindowCacheKey(PERSISTED_CACHE_KEYS.defiDexPrefix, windowKey);
  hydratePersistedTimedCacheState(cacheState, storageKey, DEFI_DEX_TTL_MS);
  return withTimedCache(cacheState, DEFI_DEX_TTL_MS, force, async () => {
    await fetchDefiPrices();
    const activity = await fetchRecentDefiActivity(windowKey, force);
    const dexData = buildDefiDexFromActivity(activity, activity?.window || {});
    const dexProtocols = dexData.dexProtocols || [];
    const dexTxRows = dexData.dexTxRows || [];
    const successRate = dexData.successRate || 0;
    const coverage = dexData.coverage || {};
    const topProtocol = dexProtocols[0] || null;
    const failedTxs = dexTxRows.filter(t => t.status !== "SUCCESS").length;
    const signals = [
      topProtocol
        ? `${topProtocol.display} is the most active DEX in-sample (${fmtNumber(topProtocol.txCount)} txs).`
        : "No DEX protocol activity detected in the current sample.",
      dexTxRows.length
        ? `${(successRate * 100).toFixed(1)}% success across DEX txs; ${fmtNumber(failedTxs)} failed.`
        : "No DEX tx rows available for success/failure analysis.",
      dexTxRows.length
        ? `${((coverage.lowConfidenceTx || 0) / dexTxRows.length * 100).toFixed(1)}% of DEX tx rows are low-confidence protocol mappings.`
        : "No DEX protocol-confidence coverage available.",
    ];
    const result = {
      fetchedAt: new Date().toISOString(),
      suiPrice: defiPrices.SUI || 0,
      sampleSize: activity.sampleSize,
      dexProtocols,
      dexTxRows: dexTxRows.slice(0, 80),
      dexTxCount: dexData.dexTxCount || dexTxRows.length,
      successRate,
      coverage,
      signals,
      window: activity?.window || {},
    };
    writePersistedTimedCacheRecord(storageKey, result, 120000);
    return result;
  });
}

async function fetchRecentStablecoinFlowsSample(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false) {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  await fetchDefiPrices();
  const stableKeys = getStableSymbolKeys();
  const sample = await fetchDeterministicDefiWindowSample(windowKey, force, "flow");
  const txs = sample?.txs || [];
  const sampleCoverage = sample?.coverage || {};

  const bySymbol = {};
  const flows = [];
  const confidenceCounts = { high: 0, medium: 0, low: 0 };
  for (const tx of txs) {
    const proto = (txMovePackages(tx).map(p => protocolInfoFromPackage(normalizeSuiAddress(p))).find(p => p.category !== "system" && p.category !== "other"))
      || (txMovePackages(tx).map(p => protocolInfoFromPackage(normalizeSuiAddress(p))).find(p => p.category !== "system"))
      || null;
    const protoConfidence = proto?.confidence === "high" || proto?.confidence === "medium" ? proto.confidence : "low";
    const bcs = tx?.effects?.balanceChanges?.nodes || [];
    for (const bc of bcs) {
      const ct = bc?.coinType?.repr;
      if (!ct) continue;
      const resolved = resolveCoinType(ct);
      const symKey = stableSymbolKey(resolved.symbol);
      if (!stableKeys.has(symKey)) continue;
      const amountRaw = Number(bc.amount || 0);
      if (!Number.isFinite(amountRaw) || amountRaw === 0) continue;
      const amount = Math.abs(amountRaw) / Math.pow(10, resolved.decimals || 9);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const symbol = stableSymbolDisplay(resolved.symbol);
      const price = Number(defiPrices[resolved.symbol] || defiPrices[symbol] || 1);
      const usdValue = amount * (price > 0 ? price : 1);
      const agg = bySymbol[symbol] || { symbol, amount: 0, usdValue: 0, changes: 0 };
      agg.amount += amount;
      agg.usdValue += usdValue;
      agg.changes++;
      bySymbol[symbol] = agg;
      confidenceCounts[protoConfidence]++;
      flows.push({
        symbol,
        amount,
        usdValue,
        owner: bc?.owner?.address || "",
        direction: amountRaw < 0 ? "out" : "in",
        digest: tx.digest,
        timestamp: tx?.effects?.timestamp || "",
        status: tx?.effects?.status || "",
        protocol: proto?.display || "Unknown",
        protocolConfidence: protoConfidence,
      });
    }
  }
  flows.sort((a, b) => b.usdValue - a.usdValue);
  return {
    flows,
    bySymbol: Object.values(bySymbol).sort((a, b) => b.usdValue - a.usdValue),
    totalFlowUsd: flows.reduce((s, f) => s + f.usdValue, 0),
    sampleSize: txs.length,
    uniquePackages: sampleCoverage.uniquePackages || 0,
    resolvedPackages: sampleCoverage.resolvedPackages || 0,
    confidenceCounts,
    window: sampleCoverage,
  };
}

async function fetchDefiStablecoinSnapshot(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false) {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  const cacheState = getKeyedCacheState(defiStablecoinsCacheByWindow, windowKey);
  const storageKey = persistedWindowCacheKey(PERSISTED_CACHE_KEYS.defiStablecoinsPrefix, windowKey);
  hydratePersistedTimedCacheState(cacheState, storageKey, DEFI_STABLECOINS_TTL_MS);
  return withTimedCache(cacheState, DEFI_STABLECOINS_TTL_MS, force, async () => {
    const [supply, flowSample] = await Promise.all([
      fetchStablecoinSupply(),
      fetchRecentStablecoinFlowsSample(windowKey, force),
    ]);
    const flowByKey = {};
    for (const f of flowSample.bySymbol) flowByKey[stableSymbolKey(f.symbol)] = f;
    const coins = (supply?.coins || []).map(c => {
      const k = stableSymbolKey(c.symbol);
      const f = flowByKey[k];
      return { ...c, recentFlowUsd: f?.usdValue || 0, recentFlowAmount: f?.amount || 0, recentChanges: f?.changes || 0 };
    }).sort((a, b) => b.supply - a.supply);
    const conf = flowSample.confidenceCounts || { high: 0, medium: 0, low: 0 };
    const unknownFlowRows = (flowSample.flows || []).filter(f => f.protocolConfidence === "low" || f.protocol === "Unknown").length;
    const dominant = coins[0] || null;
    const second = coins[1] || null;
    const signals = [
      dominant
        ? `${dominant.symbol} leads supply at ${dominant.pct.toFixed(1)}% (${fmtCompact(dominant.supply)} USD).`
        : "No stablecoin supply rows available.",
      second
        ? `${dominant.symbol} + ${second.symbol} account for ${(dominant.pct + second.pct).toFixed(1)}% of tracked supply.`
        : "Concentration signal unavailable (not enough assets).",
      flowSample.flows?.length
        ? `${((conf.low || 0) / flowSample.flows.length * 100).toFixed(1)}% of sampled stablecoin flow rows are low-confidence protocol mappings.`
        : "No sampled stablecoin flow rows for confidence coverage.",
    ];
    const result = {
      fetchedAt: new Date().toISOString(),
      totalSupply: supply?.totalSupply || 0,
      coins,
      totalRecentFlowUsd: flowSample.totalFlowUsd,
      topFlows: flowSample.flows.slice(0, 80),
      coverage: {
        sampleTxs: flowSample.sampleSize || 0,
        flowRows: flowSample.flows?.length || 0,
        highConfidenceFlowRows: conf.high || 0,
        mediumConfidenceFlowRows: conf.medium || 0,
        lowConfidenceFlowRows: conf.low || 0,
        unknownFlowRows,
        resolvedPackages: flowSample.resolvedPackages || 0,
        unresolvedPackages: Math.max(0, (flowSample.uniquePackages || 0) - (flowSample.resolvedPackages || 0)),
      },
      signals,
      window: flowSample.window || {},
    };
    writePersistedTimedCacheRecord(storageKey, result, 140000);
    return result;
  });
}

async function fetchDefiLstSnapshot(force = false) {
  return withTimedCache(defiLstCache, DEFI_LST_TTL_MS, force, async () => {
    await Promise.all([fetchDefiPrices(), fetchLstExchangeRates()]);
    const entries = [];
    for (const [coinType, info] of Object.entries(LST_TYPES)) {
      const meta = await getCoinMeta(coinType).catch(() => null);
      const resolved = resolveCoinType(coinType);
      const decimals = meta?.decimals ?? resolved.decimals ?? 9;
      const metaSupplyRaw = Number(meta?.supply || 0);
      const fallbackSupplyRaw = Number(lstSupplies[info.symbol] || 0);
      const supplyRaw = Number(metaSupplyRaw || fallbackSupplyRaw || 0);
      const supply = supplyRaw > 0 ? (supplyRaw / Math.pow(10, decimals)) : 0;
      const rate = Number(lstExchangeRates[info.symbol] || 1);
      const impliedPrice = (defiPrices.SUI || 0) * rate;
      const marketCap = supply * impliedPrice;
      const supplySource = metaSupplyRaw > 0 ? "coinMetadata" : (fallbackSupplyRaw > 0 ? "rateObject" : "missing");
      const rateSource = info.rateObj ? "rateObject" : "proxy";
      let confidence = "low";
      if (rateSource === "rateObject" && supplySource !== "missing") confidence = "high";
      else if (supplySource !== "missing") confidence = "medium";
      entries.push({
        coinType,
        symbol: info.symbol,
        name: info.name || info.symbol,
        protocol: info.protocol || "Unknown",
        sourceObj: info.rateObj || "",
        supply,
        exchangeRate: rate,
        premiumPct: (rate - 1) * 100,
        impliedPrice,
        marketCap,
        supplySource,
        rateSource,
        confidence,
      });
    }
    entries.sort((a, b) => b.marketCap - a.marketCap);
    const totalMcap = entries.reduce((s, e) => s + e.marketCap, 0);
    const avgRate = entries.length ? (entries.reduce((s, e) => s + e.exchangeRate, 0) / entries.length) : 0;
    const confidenceCounts = { high: 0, medium: 0, low: 0 };
    for (const e of entries) confidenceCounts[e.confidence === "high" || e.confidence === "medium" ? e.confidence : "low"]++;
    const highestPremium = entries.length ? [...entries].sort((a, b) => (b.premiumPct || 0) - (a.premiumPct || 0))[0] : null;
    const signals = [
      entries[0]
        ? `${entries[0].symbol} is the largest tracked LST by implied market cap ($${fmtCompact(entries[0].marketCap)}).`
        : "No LST entries available.",
      highestPremium
        ? `${highestPremium.symbol} has the highest premium vs SUI (${highestPremium.premiumPct >= 0 ? "+" : ""}${highestPremium.premiumPct.toFixed(2)}%).`
        : "No premium comparison is available.",
      entries.length
        ? `${((confidenceCounts.high || 0) / entries.length * 100).toFixed(1)}% of LST rows are high-confidence (direct rate object + non-missing supply).`
        : "No LST confidence coverage is available.",
    ];
    const result = {
      fetchedAt: new Date().toISOString(),
      entries,
      totalMcap,
      avgRate,
      coverage: {
        highConfidenceRows: confidenceCounts.high,
        mediumConfidenceRows: confidenceCounts.medium,
        lowConfidenceRows: confidenceCounts.low,
        missingSupplyRows: entries.filter(e => e.supplySource === "missing").length,
        derivedRateRows: entries.filter(e => e.rateSource !== "rateObject").length,
      },
      signals,
    };
    writePersistedTimedCacheRecord(PERSISTED_CACHE_KEYS.defiLst, result, 60000);
    return result;
  });
}

async function fetchDefiFlowSnapshot(windowKeyOrForce = DEFI_WINDOW_DEFAULT_KEY, forceMaybe = false) {
  const { windowKey, force } = parseDefiWindowAndForce(windowKeyOrForce, forceMaybe);
  const cacheState = getKeyedCacheState(defiFlowsCacheByWindow, windowKey);
  const storageKey = persistedWindowCacheKey(PERSISTED_CACHE_KEYS.defiFlowsPrefix, windowKey);
  hydratePersistedTimedCacheState(cacheState, storageKey, DEFI_FLOWS_TTL_MS);
  return withTimedCache(cacheState, DEFI_FLOWS_TTL_MS, force, async () => {
    await fetchDefiPrices();
    const sample = await fetchDeterministicDefiWindowSample(windowKey, force, "flow");
    const flowData = buildDefiFlowFromTxs(sample?.txs || [], sample?.coverage || {});
    const rows = flowData.rows || [];
    const totalUsd = flowData.totalUsd || 0;
    const coverage = flowData.coverage || {};
    const byProtocolUsd = {};
    for (const r of rows) byProtocolUsd[r.protocol] = (byProtocolUsd[r.protocol] || 0) + r.usdValue;
    const topProtocolEntry = Object.entries(byProtocolUsd).sort((a, b) => b[1] - a[1])[0] || null;
    const topFlow = rows[0] || null;
    const failedRows = rows.filter(r => r.status !== "SUCCESS").length;
    const signals = [
      topFlow
        ? `Largest priced flow is $${fmtCompact(topFlow.usdValue)} in ${topFlow.symbol} (${topFlow.protocol}).`
        : "No priced flow rows in current sample.",
      topProtocolEntry
        ? `${topProtocolEntry[0]} accounts for ${(totalUsd > 0 ? (topProtocolEntry[1] / totalUsd * 100) : 0).toFixed(1)}% of sampled priced flow USD.`
        : "No protocol concentration signal available.",
      rows.length
        ? `${((coverage.lowConfidenceRows || 0) / rows.length * 100).toFixed(1)}% of priced rows are low-confidence protocol mappings; ${fmtNumber(failedRows)} failed rows.`
        : "No flow confidence/failure signal available.",
    ];
    const result = {
      fetchedAt: new Date().toISOString(),
      rows,
      totalUsd,
      protocols: flowData.protocols || [],
      coverage,
      signals,
      window: sample?.coverage || {},
    };
    writePersistedTimedCacheRecord(storageKey, result, 160000);
    return result;
  });
}

async function fetchDefiWalletBalances(addr) {
  const allBalances = [];
  let cursor = null;
  let pages = 0;
  while (pages < 5) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const data = await gql(`{ address(address: "${addr}") { balances(first: 50${afterClause}) { pageInfo { hasNextPage endCursor } nodes { totalBalance coinType { repr } } } } }`);
    const balances = data.address?.balances;
    if (!balances) break;
    for (const node of balances.nodes) {
      const sym = node.coinType.repr.split("::").pop() || "?";
      allBalances.push({ symbol: sym, coinType: node.coinType.repr, rawBalance: node.totalBalance });
    }
    pages++;
    if (!balances.pageInfo.hasNextPage) break;
    cursor = balances.pageInfo.endCursor;
  }
  const nonZero = allBalances.filter(b => Number(b.rawBalance) > 0);
  // Prefetch on-chain CoinMetadata for unknown coin types → accurate decimals & symbols
  const unknownTypes = nonZero.map(b => b.coinType).filter(ct => !KNOWN_COIN_TYPES[ct] && !coinMetaCache[ct]);
  if (unknownTypes.length) await prefetchCoinMeta(unknownTypes);
  return nonZero
    .map(b => {
      const resolved = resolveCoinType(b.coinType);
      const sym = resolved.symbol;
      const dec = resolved.decimals;
      const amount = Number(b.rawBalance) / Math.pow(10, dec);
      const isLST = !!LST_TYPES[b.coinType];
      // LSTs: price = SUI_price * exchange_rate; regular: price from cached market feeds
      const lstRate = isLST ? (lstExchangeRates[sym] || 1) : 1;
      const price = isLST ? (defiPrices.SUI || 0) * lstRate : (defiPrices[sym] || 0);
      const suiEquiv = isLST ? amount * lstRate : 0;
      return { symbol: sym, coinType: b.coinType, decimals: dec, amount, price, usdValue: amount * price, isLST, suiEquiv };
    })
    .sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0) || b.amount - a.amount);
}

async function fetchSuilendPositions(addr) {
  const capData = await gql(`{ address(address: "${addr}") { objects(filter: { type: "${SUILEND_CAP_TYPE}" }, first: 10) { nodes { contents { json } } } } }`);
  const caps = capData.address?.objects?.nodes || [];
  if (!caps.length) return [];
  const obligationIds = caps.map(c => c.contents.json.obligation_id);
  const parts = obligationIds.map((id, i) => `ob${i}: object(address: "${id}") { ${GQL_F_MOVE_JSON} }`);
  const obData = await gql(`{ ${parts.join("\n")} }`);
  const positions = [];
  for (let i = 0; i < obligationIds.length; i++) {
    const ob = obData[`ob${i}`]?.asMoveObject?.contents?.json;
    if (!ob) continue;
    const deposits = (ob.deposits || []).map(d => {
      const sym = (d.coin_type?.name || "").split("::").pop();
      const usd = Number(d.market_value?.value || 0) / 1e18;
      const dec = getDecimals(sym);
      const raw = Number(d.deposited_ctoken_amount || 0);
      const amount = raw > 0 ? raw / Math.pow(10, dec) : (usd > 0 && defiPrices[sym] > 0 ? usd / defiPrices[sym] : 0);
      return { symbol: sym, amount, amountUsd: usd };
    });
    const borrows = (ob.borrows || []).map(b => {
      const sym = (b.coin_type?.name || "").split("::").pop();
      const usd = Number(b.market_value?.value || 0) / 1e18;
      // borrowed_amount.value is NOT in native decimals — it's a cumulative
      // interest-scaled value. Derive human amount from USD / price instead.
      const price = defiPrices[sym] || 0;
      const amount = usd > 0 && price > 0 ? usd / price : 0;
      return { symbol: sym, amount, amountUsd: usd };
    });
    const depositedUsd = Number(ob.deposited_value_usd?.value || 0) / 1e18;
    const borrowedUsd = Number(ob.unweighted_borrowed_value_usd?.value || 0) / 1e18;
    const weightedBorrow = Number(ob.weighted_borrowed_value_usd?.value || 0) / 1e18;
    const unhealthy = Number(ob.unhealthy_borrow_value_usd?.value || 0) / 1e18;
    positions.push({ protocol: "Suilend", deposits, borrows, depositedUsd, borrowedUsd, healthFactor: weightedBorrow > 0 ? unhealthy / weightedBorrow : Infinity, netUsd: depositedUsd - borrowedUsd });
  }
  return positions;
}

// Fetch a wallet's NAVI lending/borrowing positions.
// Flow: UserInfo → asset IDs → Reserves → user scaled balances → human amounts.
// See docs/navi-positions.md for the full query walkthrough.
async function fetchNaviPositions(addr) {
  // Step 1: Look up UserInfo from the dynamic field table keyed by wallet address.
  // Returns { collaterals: base64, loans: base64 } — VecSet<u8> of asset IDs.
  const userInfoData = await gql(`{ address(address: "${NAVI_USER_INFO_TABLE}") {
    dynamicField(name: { type: "address", bcs: "${addrBcs(addr)}" }) { value { ... on MoveValue { json } } }
  } }`);
  const userInfo = userInfoData?.address?.dynamicField?.value?.json;
  if (!userInfo) return [];
  // Decode asset IDs: collaterals/loans are VecSet<u8> serialized as base64 strings.
  // Each byte is one asset ID (e.g. 0=SUI, 10=USDC, 11=ETH, 15=DEEP, 21=BTC, ...).
  const decodeAssetIds = v => {
    if (Array.isArray(v)) return v.map(Number);
    if (typeof v === "string" && v.length > 0) return Array.from(atob(v), c => c.charCodeAt(0));
    return [];
  };
  const collateralIds = decodeAssetIds(userInfo.collaterals);
  const loanIds = decodeAssetIds(userInfo.loans);
  const allAssetIds = [...new Set([...collateralIds, ...loanIds])];
  if (!allAssetIds.length) return [];
  // Step 2: Batch-fetch Reserve objects from RESERVES_TABLE, keyed by u8 asset ID.
  // Each reserve contains: coin_type, current_supply_index, current_borrow_index,
  // supply_balance.user_state.id, borrow_balance.user_state.id, ltv, rates, etc.
  const reserveParts = allAssetIds.map((id, i) => `r${i}: dynamicField(name: { type: "u8", bcs: "${u8Bcs(Number(id))}" }) { value { ... on MoveValue { json } } }`);
  const reserveData = await gql(`{ address(address: "${NAVI_RESERVES_TABLE}") { ${reserveParts.join("\n")} } }`);
  const reserves = {};
  allAssetIds.forEach((id, i) => {
    const rv = reserveData?.address?.[`r${i}`]?.value?.json;
    if (rv) reserves[id] = rv;
  });
  // Step 3: Fetch user's scaled balances from each reserve's balance table.
  // supply_balance.user_state.id → Table<address, u64> of supply scaled balances
  // borrow_balance.user_state.id → Table<address, u64> of borrow scaled balances
  const balQueries = [];
  for (const assetId of collateralIds) {
    const rv = reserves[assetId]; if (!rv) continue;
    const tableId = rv.supply_balance?.user_state?.id; if (!tableId) continue;
    balQueries.push({ assetId, type: "supply", tableId, reserve: rv });
  }
  for (const assetId of loanIds) {
    const rv = reserves[assetId]; if (!rv) continue;
    const tableId = rv.borrow_balance?.user_state?.id; if (!tableId) continue;
    balQueries.push({ assetId, type: "borrow", tableId, reserve: rv });
  }
  const balParts = balQueries.map((q, i) => `b${i}: address(address: "${q.tableId}") { dynamicField(name: { type: "address", bcs: "${addrBcs(addr)}" }) { value { ... on MoveValue { json } } } }`);
  const balData = balParts.length ? await gql(`{ ${balParts.join("\n")} }`) : {};
  const balResults = balQueries.map((q, i) => {
    const val = balData[`b${i}`]?.dynamicField?.value?.json;
    return val != null ? { assetId: q.assetId, type: q.type, balance: String(val), reserve: q.reserve } : null;
  }).filter(Boolean);
  // Normalize coin_type from reserve: NAVI stores without 0x prefix, with variable-length
  // address. Pad to canonical 64-hex-char Sui address format for KNOWN_COIN_TYPES lookups.
  const normalizeCt = ct => {
    if (!ct) return "";
    if (!ct.startsWith("0x")) ct = "0x" + ct;
    const sep = ct.indexOf("::");
    if (sep > 2) { ct = "0x" + ct.slice(2, sep).padStart(64, "0") + ct.slice(sep); }
    return ct;
  };
  // Prefetch CoinMetadata for coin types not in our static lookup table
  const unknownTypes = balResults.map(b => normalizeCt(b.reserve.coin_type)).filter(ct => ct && !KNOWN_COIN_TYPES[ct]);
  if (unknownTypes.length) await prefetchCoinMeta(unknownTypes);
  // Step 4: Convert scaled balances to human-readable amounts.
  // Formula: human_amount = scaled_balance * (current_index / 1e27) / 1e9
  // NAVI uses 9-decimal internal precision for ALL coins, regardless of native decimals
  // (e.g. USDC natively has 6 decimals, but NAVI stores USDC balances with 9).
  const deposits = [], borrows = [];
  let totalDepUsd = 0, totalBorUsd = 0;
  for (const b of balResults) {
    const rv = b.reserve;
    const coinType = normalizeCt(rv.coin_type);
    const resolved = resolveCoinType(coinType);
    const sym = resolved.symbol || `Asset${b.assetId}`;
    const dec = 9; // NAVI 9-decimal internal precision — do NOT use coin's native decimals
    const scaled = Number(b.balance);
    if (b.type === "supply") {
      const idx = Number(rv.current_supply_index || 1e27) / NAVI_RAY;
      const human = (scaled * idx) / Math.pow(10, dec);
      const usd = human * (defiPrices[sym] || 0);
      totalDepUsd += usd;
      deposits.push({ symbol: sym, amount: human, amountUsd: usd, ltv: Number(rv.ltv || 0) / NAVI_RAY });
    } else {
      const idx = Number(rv.current_borrow_index || 1e27) / NAVI_RAY;
      const human = (scaled * idx) / Math.pow(10, dec);
      const usd = human * (defiPrices[sym] || 0);
      totalBorUsd += usd;
      borrows.push({ symbol: sym, amount: human, amountUsd: usd });
    }
  }
  // Health factor = sum(deposit_usd * ltv) / total_borrow_usd
  const weightedColl = deposits.reduce((s, d) => s + d.amountUsd * (d.ltv || 0), 0);
  return [{ protocol: "NAVI", deposits, borrows, depositedUsd: totalDepUsd, borrowedUsd: totalBorUsd, healthFactor: totalBorUsd > 0 ? weightedColl / totalBorUsd : Infinity, netUsd: totalDepUsd - totalBorUsd }];
}

async function fetchAlphaPositions(addr) {
  const capData = await gql(`{ address(address: "${addr}") { objects(filter: { type: "${ALPHA_CAP_TYPE}" }, first: 10) { nodes { contents { json } } } } }`);
  const caps = capData.address?.objects?.nodes || [];
  if (!caps.length) return [];
  // Batch-fetch positions via dynamicField
  const posIds = caps.map(c => c.contents.json.position_id).filter(Boolean);
  const posParts = posIds.map((id, i) => `p${i}: dynamicField(name: { type: "0x2::object::ID", bcs: "${objectIdBcs(id)}" }) { value { ... on MoveValue { json } } }`);
  const posData = await gql(`{ address(address: "${ALPHA_POSITIONS_TABLE}") { ${posParts.join("\n")} } }`);
  const positions = [];
  for (let i = 0; i < posIds.length; i++) {
    const data = posData?.address?.[`p${i}`]?.value?.json;
    if (!data) continue;
    const extractUsd = v => Number(v?.value || v || 0) / 1e18;
    const depositedUsd = extractUsd(data.total_collateral_usd);
    const borrowedUsd = extractUsd(data.total_loan_usd);
    const safeCollUsd = extractUsd(data.safe_collateral_usd);
    const collContents = data.collaterals?.contents || [];
    const deps = collContents.map(c => {
      const m = Number(c.key || 0);
      const sym = ALPHA_MARKETS[m] || `Market${m}`;
      const dec = getDecimals(sym);
      const amount = Number(c.value || 0) / Math.pow(10, dec);
      const price = defiPrices[sym] || 0;
      const amountUsd = amount * price;
      return { symbol: sym, amount, amountUsd };
    });
    const loans = (data.loans || []).map(l => { const sym = String(l.coin_type?.name || "").split("::").pop() || "?"; const dec = getDecimals(sym); const human = Number(l.amount || 0) / Math.pow(10, dec); const usd = human * (defiPrices[sym] || 0); return { symbol: sym, amount: human, amountUsd: usd }; });
    // Recompute USD totals from per-asset amounts when on-chain values are 0
    const computedDepUsd = deps.reduce((s, d) => s + d.amountUsd, 0);
    const computedBorUsd = loans.reduce((s, l) => s + l.amountUsd, 0);
    const finalDepUsd = depositedUsd > 0 ? depositedUsd : computedDepUsd;
    const finalBorUsd = borrowedUsd > 0 ? borrowedUsd : computedBorUsd;
    const finalSafeUsd = safeCollUsd > 0 ? safeCollUsd : computedDepUsd * 0.8;
    positions.push({ protocol: "Alpha", deposits: deps, borrows: loans, depositedUsd: finalDepUsd, borrowedUsd: finalBorUsd, healthFactor: finalBorUsd > 0 ? finalSafeUsd / finalBorUsd : Infinity, netUsd: finalDepUsd - finalBorUsd });
  }
  return positions;
}

function sqrtPriceToHumanPrice(sqrtPriceStr, decimalsA, decimalsB) {
  const s = Number(sqrtPriceStr);
  if (!s || !Number.isFinite(s)) return 0;
  const ratio = s / (2 ** 64);
  const p = ratio * ratio * Math.pow(10, decimalsA - decimalsB);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

function i32FromBits(val) { const n = Number(val?.bits ?? val); return n > 0x7FFFFFFF ? n - 0x100000000 : n; }
function tickToSqrtPriceX64(tick) { return Math.pow(1.0001, tick / 2) * (2 ** 64); }
function getCoinAmountsFromLiquidity(liq, curSqrt, lowSqrt, upSqrt) {
  const Q64 = 2 ** 64; let coinA = 0, coinB = 0;
  if (curSqrt < lowSqrt) coinA = liq * (upSqrt - lowSqrt) / (lowSqrt * upSqrt) * Q64;
  else if (curSqrt >= upSqrt) coinB = liq * (upSqrt - lowSqrt) / Q64;
  else { coinA = liq * (upSqrt - curSqrt) / (curSqrt * upSqrt) * Q64; coinB = liq * (curSqrt - lowSqrt) / Q64; }
  return { coinA: Math.abs(coinA), coinB: Math.abs(coinB) };
}

async function fetchCetusPositions(addr) {
  const posNodes = [];
  let cursor = null, pages = 0;
  while (pages < 3) {
    const ac = cursor ? `, after: "${cursor}"` : "";
    const data = await gql(`{ address(address: "${addr}") { objects(filter: { type: "${CETUS_POSITION_TYPE}" }, first: 50${ac}) { pageInfo { hasNextPage endCursor } nodes { address contents { json } } } } }`);
    const objs = data.address?.objects;
    if (!objs) break;
    posNodes.push(...objs.nodes); pages++;
    if (!objs.pageInfo.hasNextPage) break; cursor = objs.pageInfo.endCursor;
  }
  if (!posNodes.length) return [];
  // Fetch pool data for each unique pool
  const poolIds = [...new Set(posNodes.map(p => p.contents.json.pool))];
  const poolById = await multiGetObjectsTypeJsonByAddress(poolIds);
  const pools = {};
  poolIds.forEach((id) => {
    const pd = poolById[normalizeSuiAddress(id)]?.asMoveObject;
    if (!pd) return;
    const typeRepr = pd.contents.type.repr;
    const tps = typeRepr.match(/<(.+)>/)?.[1]?.split(",").map(s => s.trim()) || [];
    const rA = resolveCoinType(tps[0] || ""), rB = resolveCoinType(tps[1] || "");
    pools[id] = { json: pd.contents.json, symbolA: rA.symbol, symbolB: rB.symbol, decA: rA.decimals, decB: rB.decimals };
  });
  const positions = [];
  for (const node of posNodes) {
    const pj = node.contents.json;
    const pool = pools[pj.pool]; if (!pool) continue;
    const curTick = i32FromBits(pool.json.current_tick_index);
    const lowTick = i32FromBits(pj.tick_lower_index), upTick = i32FromBits(pj.tick_upper_index);
    const curSqrt = tickToSqrtPriceX64(curTick), lowSqrt = tickToSqrtPriceX64(lowTick), upSqrt = tickToSqrtPriceX64(upTick);
    const liq = Number(pj.liquidity);
    const { coinA, coinB } = getCoinAmountsFromLiquidity(liq, curSqrt, lowSqrt, upSqrt);
    const amtA = coinA / Math.pow(10, pool.decA), amtB = coinB / Math.pow(10, pool.decB);
    const usdA = amtA * (defiPrices[pool.symbolA] || 0), usdB = amtB * (defiPrices[pool.symbolB] || 0);
    const inRange = curTick >= lowTick && curTick < upTick;
    positions.push({ protocol: "Cetus LP", pair: `${pool.symbolA}/${pool.symbolB}`, symbolA: pool.symbolA, symbolB: pool.symbolB, amountA: amtA, amountB: amtB, usdA, usdB, totalUsd: usdA + usdB, inRange, posId: node.address });
  }
  return positions;
}

// ── DeepBook Margin Fetcher ────────────────────────────────────────────
async function lookupManagerIds(userAddress) {
  const bcs = addressToBcs(userAddress);
  const data = await gql(`query($table: SuiAddress!, $bcs: Base64!) {
    address(address: $table) { dynamicField(name: { type: "address", bcs: $bcs }) { value { ... on MoveValue { json } } } }
  }`, { table: MARGIN_MANAGERS_TABLE, bcs });
  const field = data.address?.dynamicField;
  if (!field) return [];
  return field.value?.json?.contents || [];
}

async function fetchCollateral(bagId, bagSize) {
  if (Number(bagSize) === 0) return [];
  const data = await gql(`query($bag: SuiAddress!) {
    address(address: $bag) { dynamicFields(first: 10) { nodes { name { type { repr } json } value { ... on MoveValue { type { repr } json } } } } }
  }`, { bag: bagId });
  return (data.address?.dynamicFields?.nodes || []).map(f => {
    const coinType = (f.name.type.repr.match(/<(.+)>/) || [])[1] || "";
    const resolved = resolveCoinType(coinType);
    return { symbol: resolved.symbol, coinType, amount: Number(f.value?.json), decimals: resolved.decimals };
  });
}

async function fetchRiskConfigs() {
  try {
    const data = await gql(`{ address(address: "${POOL_REGISTRY_TABLE}") { dynamicFields(first: 10) { nodes { name { json } value { ... on MoveValue { json } } } } } }`);
    const configs = {};
    for (const n of (data.address?.dynamicFields?.nodes || [])) configs[n.name.json] = n.value.json;
    return configs;
  } catch (e) { return {}; }
}

async function fetchDeepBookPositions(addr) {
  const managerIds = await lookupManagerIds(addr);
  if (!managerIds.length) return { positions: [], pools: {}, riskConfigs: {} };
  const poolIds = Object.keys(KNOWN_POOLS);
  const [data, riskConfigs] = await Promise.all([
    multiGetObjectsTypeJsonByAddress([...managerIds, ...poolIds]),
    fetchRiskConfigs(),
  ]);
  const objById = data || {};
  const pools = {};
  poolIds.forEach((poolId) => {
    const pd = objById[normalizeSuiAddress(poolId)];
    if (pd?.asMoveObject?.contents?.json) pools[poolId] = pd.asMoveObject.contents.json;
  });
  // Collect managers and their bag IDs, then batch-fetch all collateral in one query
  const managers = [];
  for (const id of managerIds) {
    const mgrNode = objById[normalizeSuiAddress(id)];
    if (!mgrNode?.asMoveObject?.contents) continue;
    const mgrJson = mgrNode.asMoveObject.contents.json;
    const mgrType = mgrNode.asMoveObject.contents.type.repr;
    managers.push({ json: mgrJson, type: mgrType, bagId: mgrJson.balance_manager.balances.id, bagSize: Number(mgrJson.balance_manager.balances.size) });
  }
  const bagParts = managers.filter(m => m.bagSize > 0).map((m, i) =>
    `bag${i}: address(address: "${m.bagId}") { dynamicFields(first: 10) { nodes { name { type { repr } json } value { ... on MoveValue { type { repr } json } } } } }`
  );
  const bagData = bagParts.length ? await gql(`{ ${bagParts.join("\n")} }`) : {};
  let bagIdx = 0;
  const positions = managers.map(m => {
    let collateral = [];
    if (m.bagSize > 0) {
      collateral = (bagData[`bag${bagIdx}`]?.dynamicFields?.nodes || []).map(f => {
        const coinType = (f.name.type.repr.match(/<(.+)>/) || [])[1] || "";
        const resolved = resolveCoinType(coinType);
        return { symbol: resolved.symbol, coinType, amount: Number(f.value?.json), decimals: resolved.decimals };
      });
      bagIdx++;
    }
    return {
      mgr: { id: m.json.id, owner: m.json.owner, deepbook_pool: m.json.deepbook_pool, margin_pool_id: m.json.margin_pool_id,
        borrowed_base_shares: m.json.borrowed_base_shares, borrowed_quote_shares: m.json.borrowed_quote_shares,
        tpsl: m.json.take_profit_stop_loss, type_repr: m.type },
      collateral,
    };
  });
  return { positions, pools, riskConfigs };
}

// ── Scallop Lending Fetcher ─────────────────────────────────────────────
let scallopBorrowIndicesCache = null;
async function fetchScallopBorrowIndices() {
  if (scallopBorrowIndicesCache) return scallopBorrowIndicesCache;
  try {
    const data = await gql(`{ address(address: "${SCALLOP_BORROW_DYNAMICS_TABLE}") {
      dynamicFields(first: 30) { nodes { name { json } value { ... on MoveValue { json } } } }
    } }`);
    const indices = {};
    for (const n of (data.address?.dynamicFields?.nodes || [])) {
      const coinType = "0x" + (n.name?.json?.name || "");
      const bi = Number(n.value?.json?.borrow_index || 0);
      if (bi > 0) indices[coinType] = bi;
    }
    scallopBorrowIndicesCache = indices;
    return indices;
  } catch (e) { return {}; }
}

async function fetchScallopPositions(addr) {
  // Step 1: Find ObligationKey objects
  const keyData = await gql(`{ address(address: "${addr}") {
    objects(filter: { type: "${SCALLOP_KEY_TYPE}" }, first: 10) { nodes { contents { json } } }
  } }`);
  const keys = keyData.address?.objects?.nodes || [];
  if (!keys.length) return [];
  // Step 2: Extract obligation IDs and fetch obligations + market borrow indices
  const obligationIds = keys.map(k => k.contents.json.ownership?.of).filter(Boolean);
  if (!obligationIds.length) return [];
  const [obData, marketIndices] = await Promise.all([
    multiGetObjectsJsonByAddress(obligationIds),
    fetchScallopBorrowIndices(),
  ]);
  const obById = obData || {};
  // Step 3: Collect all collateral/debt table IDs and batch-fetch in one query
  const tableQueries = [];
  const obInfos = [];
  for (let i = 0; i < obligationIds.length; i++) {
    const ob = obById[normalizeSuiAddress(obligationIds[i])]?.asMoveObject?.contents?.json;
    if (!ob) continue;
    const collKeys = ob.collaterals?.keys?.contents || [];
    const debtKeys = ob.debts?.keys?.contents || [];
    if (!collKeys.length && !debtKeys.length) continue;
    const collTableId = ob.collaterals?.table?.id;
    const debtTableId = ob.debts?.table?.id;
    const info = { idx: obInfos.length, collAlias: null, debtAlias: null };
    if (collTableId) { info.collAlias = `coll${i}`; tableQueries.push(`coll${i}: address(address: "${collTableId}") { dynamicFields(first: 20) { nodes { name { json } value { ... on MoveValue { json } } } } }`); }
    if (debtTableId) { info.debtAlias = `debt${i}`; tableQueries.push(`debt${i}: address(address: "${debtTableId}") { dynamicFields(first: 20) { nodes { name { json } value { ... on MoveValue { json } } } } }`); }
    obInfos.push(info);
  }
  const tableData = tableQueries.length ? await gql(`{ ${tableQueries.join("\n")} }`).catch(() => ({})) : {};
  // Prefetch CoinMetadata for all unknown types across all obligations
  const allUnknownTypes = [];
  for (const info of obInfos) {
    const collNodes = info.collAlias ? (tableData[info.collAlias]?.dynamicFields?.nodes || []) : [];
    const debtNodes = info.debtAlias ? (tableData[info.debtAlias]?.dynamicFields?.nodes || []) : [];
    for (const f of [...collNodes, ...debtNodes]) {
      const ct = "0x" + (f.name?.json?.name || "");
      if (ct.length > 2 && !KNOWN_COIN_TYPES[ct]) allUnknownTypes.push(ct);
    }
  }
  if (allUnknownTypes.length) await prefetchCoinMeta(allUnknownTypes);
  // Step 4: Process each obligation
  const positions = [];
  for (const info of obInfos) {
    const collNodes = info.collAlias ? (tableData[info.collAlias]?.dynamicFields?.nodes || []) : [];
    const debtNodes = info.debtAlias ? (tableData[info.debtAlias]?.dynamicFields?.nodes || []) : [];
    const deposits = [], borrows = [];
    let totalDepUsd = 0, totalBorUsd = 0;
    for (const f of collNodes) {
      const coinType = "0x" + (f.name?.json?.name || "");
      const resolved = resolveCoinType(coinType);
      const amount = Number(f.value?.json?.amount || 0);
      const human = amount / Math.pow(10, resolved.decimals);
      const usd = human * (defiPrices[resolved.symbol] || 0);
      totalDepUsd += usd;
      deposits.push({ symbol: resolved.symbol, amount: human, amountUsd: usd });
    }
    for (const f of debtNodes) {
      const coinType = "0x" + (f.name?.json?.name || "");
      const resolved = resolveCoinType(coinType);
      const rawAmount = Number(f.value?.json?.amount || 0);
      const userIndex = Number(f.value?.json?.borrow_index || 0);
      const marketIndex = marketIndices[coinType] || 0;
      const amount = (userIndex > 0 && marketIndex > 0) ? rawAmount * marketIndex / userIndex : rawAmount;
      const human = amount / Math.pow(10, resolved.decimals);
      const usd = human * (defiPrices[resolved.symbol] || 0);
      totalBorUsd += usd;
      borrows.push({ symbol: resolved.symbol, amount: human, amountUsd: usd });
    }
    const healthFactor = totalBorUsd > 0 ? totalDepUsd / totalBorUsd : Infinity;
    positions.push({ protocol: "Scallop", deposits, borrows, depositedUsd: totalDepUsd, borrowedUsd: totalBorUsd, healthFactor, netUsd: totalDepUsd - totalBorUsd });
  }
  return positions;
}

// ── Turbos CLMM Fetcher ─────────────────────────────────────────────────
async function fetchTurbosPositions(addr) {
  // Step 1: Find TurbosPositionNFT objects
  const nftData = await gql(`{ address(address: "${addr}") {
    objects(filter: { type: "${TURBOS_POSITION_TYPE}" }, first: 50) {
      nodes { address contents { json } }
    }
  } }`);
  const nfts = nftData.address?.objects?.nodes || [];
  if (!nfts.length) return [];
  // Step 2: Batch-fetch position data + pool data in one GQL query using dynamicObjectField
  const posParts = nfts.map((n, i) =>
    `pos${i}: dynamicObjectField(name: {type: "address", bcs: "${addrBcs(n.address)}"}) { value { ... on MoveObject { contents { json } } } }`
  );
  const poolIds = [...new Set(nfts.map(n => n.contents.json.pool_id).filter(Boolean))];
  const batchQuery = `{ container: object(address: "${TURBOS_POSITIONS_CONTAINER}") { ${posParts.join("\n")} } }`;
  const [containerData, poolData] = await Promise.all([
    gql(batchQuery),
    poolIds.length ? multiGetObjectsTypeJsonByAddress(poolIds) : Promise.resolve({}),
  ]);
  const container = containerData.container || {};
  const poolById = poolData || {};
  const pools = {};
  poolIds.forEach((id) => {
    const pd = poolById[normalizeSuiAddress(id)]?.asMoveObject;
    if (!pd) return;
    const typeRepr = pd.contents.type.repr;
    const tps = typeRepr.match(/<(.+)>/)?.[1]?.split(",").map(s => s.trim()) || [];
    pools[id] = { json: pd.contents.json, typeA: tps[0], typeB: tps[1] };
  });
  const positions = [];
  for (let i = 0; i < nfts.length; i++) {
    const nft = nfts[i];
    const posFields = container[`pos${i}`]?.value?.contents?.json;
    if (!posFields) continue;
    const poolId = nft.contents.json.pool_id;
    const pool = pools[poolId];
    if (!pool) continue;
    const resolvedA = resolveCoinType(nft.contents.json.coin_type_a?.name ? ("0x" + nft.contents.json.coin_type_a.name) : (pool.typeA || ""));
    const resolvedB = resolveCoinType(nft.contents.json.coin_type_b?.name ? ("0x" + nft.contents.json.coin_type_b.name) : (pool.typeB || ""));
    const curTick = i32FromBits(pool.json.tick_current_index || pool.json.current_tick_index);
    const lowTick = i32FromBits(posFields.tick_lower_index);
    const upTick = i32FromBits(posFields.tick_upper_index);
    const curSqrt = tickToSqrtPriceX64(curTick), lowSqrt = tickToSqrtPriceX64(lowTick), upSqrt = tickToSqrtPriceX64(upTick);
    const liq = Number(posFields.liquidity);
    if (liq === 0) continue;
    const { coinA, coinB } = getCoinAmountsFromLiquidity(liq, curSqrt, lowSqrt, upSqrt);
    const amtA = coinA / Math.pow(10, resolvedA.decimals), amtB = coinB / Math.pow(10, resolvedB.decimals);
    const usdA = amtA * (defiPrices[resolvedA.symbol] || 0), usdB = amtB * (defiPrices[resolvedB.symbol] || 0);
    const inRange = curTick >= lowTick && curTick < upTick;
    positions.push({ protocol: "Turbos LP", pair: `${resolvedA.symbol}/${resolvedB.symbol}`, symbolA: resolvedA.symbol, symbolB: resolvedB.symbol, amountA: amtA, amountB: amtB, usdA, usdB, totalUsd: usdA + usdB, inRange, posId: nft.address });
  }
  return positions;
}

// ── Bluefin Spot CLMM Fetcher ───────────────────────────────────────────
async function fetchBluefinSpotPositions(addr) {
  const nftData = await gql(`{ address(address: "${addr}") {
    objects(filter: { type: "${BLUEFIN_POSITION_TYPE}" }, first: 50) {
      nodes { address contents { json } }
    }
  } }`);
  const nfts = nftData.address?.objects?.nodes || [];
  if (!nfts.length) return [];
  // Fetch pools for current sqrt_price
  const poolIds = [...new Set(nfts.map(n => n.contents.json.pool_id).filter(Boolean))];
  const poolById = poolIds.length ? await multiGetObjectsTypeJsonByAddress(poolIds) : {};
  const pools = {};
  poolIds.forEach((id) => {
    const pd = poolById[normalizeSuiAddress(id)]?.asMoveObject;
    if (!pd) return;
    const typeRepr = pd.contents.type.repr;
    const tps = typeRepr.match(/<(.+)>/)?.[1]?.split(",").map(s => s.trim()) || [];
    pools[id] = { json: pd.contents.json, typeA: tps[0], typeB: tps[1] };
  });
  const positions = [];
  for (const nft of nfts) {
    const pj = nft.contents.json;
    const poolId = pj.pool_id;
    const pool = pools[poolId];
    if (!pool) continue;
    const coinTypeA = pj.coin_type_a ? ("0x" + pj.coin_type_a) : (pool.typeA || "");
    const coinTypeB = pj.coin_type_b ? ("0x" + pj.coin_type_b) : (pool.typeB || "");
    const resolvedA = resolveCoinType(coinTypeA);
    const resolvedB = resolveCoinType(coinTypeB);
    const curTick = i32FromBits(pool.json.current_tick_index || pool.json.tick_current_index);
    const lowTick = i32FromBits(pj.lower_tick);
    const upTick = i32FromBits(pj.upper_tick);
    const curSqrt = tickToSqrtPriceX64(curTick), lowSqrt = tickToSqrtPriceX64(lowTick), upSqrt = tickToSqrtPriceX64(upTick);
    const liq = Number(pj.liquidity);
    if (liq === 0) continue;
    const { coinA, coinB } = getCoinAmountsFromLiquidity(liq, curSqrt, lowSqrt, upSqrt);
    const amtA = coinA / Math.pow(10, resolvedA.decimals), amtB = coinB / Math.pow(10, resolvedB.decimals);
    const usdA = amtA * (defiPrices[resolvedA.symbol] || 0), usdB = amtB * (defiPrices[resolvedB.symbol] || 0);
    const inRange = curTick >= lowTick && curTick < upTick;
    positions.push({ protocol: "Bluefin LP", pair: `${resolvedA.symbol}/${resolvedB.symbol}`, symbolA: resolvedA.symbol, symbolB: resolvedB.symbol, amountA: amtA, amountB: amtB, usdA, usdB, totalUsd: usdA + usdB, inRange, posId: nft.address });
  }
  return positions;
}

// ── Bluefin Pro (Perps) Fetcher ────────────────────────────────────────
async function fetchBluefinProPositions(addr) {
  try {
    const data = await gql(`{ address(address: "${BLUEFIN_PRO_ACCOUNTS_TABLE}") {
      dynamicField(name: { type: "address", bcs: "${addrBcs(addr)}" }) {
        value { ... on MoveValue { json } }
      }
    } }`);
    const account = data?.address?.dynamicField?.value?.json;
    if (!account) return { positions: [], collateral: 0 };
    // Extract USDC collateral (Bluefin uses 1e9 precision internally)
    const assets = account.assets || [];
    let collateralUsdc = 0;
    for (const a of assets) {
      const af = a.fields || a;
      collateralUsdc += Number(af.quantity || 0) / 1e9;
    }
    // Extract positions
    const crossPositions = (account.cross_positions || []).map(p => ({ ...(p.fields || p), _isCross: true }));
    const isolatedPositions = (account.isolated_positions || []).map(p => ({ ...(p.fields || p), _isCross: false }));
    const allPositions = [...crossPositions, ...isolatedPositions];
    const positions = allPositions.map(pf => {
      const symbol = pf.perpetual || "?";
      const size = Number(pf.size || 0) / 1e9;
      const entryPrice = Number(pf.average_entry_price || 0) / 1e9;
      const margin = Number(pf.margin || 0) / 1e9;
      const leverage = Number(pf.leverage || 0) / 1e9;
      const isLong = pf.is_long === true || pf.is_long === "true";
      const isCross = pf._isCross;
      const notional = size * entryPrice;
      return { symbol, size, entryPrice, margin, leverage, isLong, isCross, notional };
    }).filter(p => p.size > 0);
    return { positions, collateral: collateralUsdc };
  } catch (e) { return { positions: [], collateral: 0 }; }
}

function afNormalizeAccountId(v) {
  const raw = String(v ?? "").trim();
  if (!raw || !/^\d+$/.test(raw)) return "";
  return raw.replace(/^0+(?=\d)/, "") || "0";
}
function afAccountCapRoleFromType(typeRepr, fallbackRole = "") {
  const lower = String(typeRepr || "").toLowerCase();
  if (!lower) return fallbackRole || "unknown";
  if (lower.includes("::account::admin>") || lower.endsWith("::account::admin")) return "admin";
  if (lower.includes("::account::assistant>") || lower.endsWith("::account::assistant")) return "assistant";
  return fallbackRole || "unknown";
}
function afRolePriority(role) {
  if (role === "admin") return 2;
  if (role === "assistant") return 1;
  return 0;
}
function afRoleLabel(role) {
  if (role === "admin") return "Admin";
  if (role === "assistant") return "Assistant";
  return "Unknown";
}
function afMarketAccountKey(chId, accountId) {
  return `${chId}::${accountId}`;
}
function afMarketLabel(chId) {
  return AF_CLEARING_HOUSES[chId] || `Market ${truncHash(chId, 6)}`;
}
async function fetchAftermathAccountCaps(addr) {
  const capByObject = {};
  let partial = false;

  for (const filter of AF_ACCOUNT_CAP_FILTERS) {
    let after = null;
    for (let page = 0; page < AF_ACCOUNT_CAP_MAX_PAGES; page += 1) {
      const data = await gql(`query($addr: SuiAddress!, $type: String!, $after: String, $first: Int!) {
        address(address: $addr) {
          objects(filter: { type: $type }, first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              address
              ${GQL_F_CONTENTS_TYPE_JSON}
            }
          }
        }
      }`, {
        addr,
        type: filter.type,
        after,
        first: AF_ACCOUNT_CAP_PAGE_SIZE,
      });
      const conn = data?.address?.objects;
      const rows = conn?.nodes || [];
      for (const row of rows) {
        const info = row?.contents?.json || {};
        const accountId = afNormalizeAccountId(info.account_id);
        const capObjectId = normalizeSuiAddress(row?.address || "");
        if (!accountId && !capObjectId) continue;
        const key = capObjectId || `${accountId}:${filter.type}`;
        const role = afAccountCapRoleFromType(row?.contents?.type?.repr || "", filter.role);
        const existing = capByObject[key];
        if (existing) {
          if (afRolePriority(role) > afRolePriority(existing.role || "")) existing.role = role;
          if (!existing.accountObjectId) existing.accountObjectId = normalizeSuiAddress(info.account_obj_id || "");
          if (!existing.accountId) existing.accountId = accountId;
          continue;
        }
        capByObject[key] = {
          accountId,
          role,
          capObjectId,
          accountObjectId: normalizeSuiAddress(info.account_obj_id || ""),
          capType: String(row?.contents?.type?.repr || filter.type || ""),
        };
      }
      if (!conn?.pageInfo?.hasNextPage) {
        after = null;
        break;
      }
      after = conn?.pageInfo?.endCursor || null;
      if (!after) break;
      if (page === AF_ACCOUNT_CAP_MAX_PAGES - 1) partial = true;
    }
  }

  const caps = Object.values(capByObject).filter((row) => row?.accountId);
  const accountMap = {};
  for (const cap of caps) {
    const key = cap.accountId;
    if (!accountMap[key]) {
      accountMap[key] = {
        accountId: cap.accountId,
        accountObjectId: cap.accountObjectId || "",
        capObjectIds: [],
        roleSet: new Set(),
        role: "unknown",
      };
    }
    const row = accountMap[key];
    if (cap.accountObjectId && !row.accountObjectId) row.accountObjectId = cap.accountObjectId;
    if (cap.capObjectId) row.capObjectIds.push(cap.capObjectId);
    if (cap.role) row.roleSet.add(cap.role);
    if (afRolePriority(cap.role) > afRolePriority(row.role)) row.role = cap.role;
  }
  const accounts = Object.values(accountMap)
    .map((row) => ({
      accountId: row.accountId,
      accountObjectId: row.accountObjectId,
      capObjectIds: [...new Set(row.capObjectIds.filter(Boolean))],
      roles: [...row.roleSet].sort((a, b) => afRolePriority(b) - afRolePriority(a)),
      role: row.role,
    }))
    .sort((a, b) => {
      const ai = parseBigIntSafe(a.accountId);
      const bi = parseBigIntSafe(b.accountId);
      if (ai === bi) return 0;
      return ai < bi ? -1 : 1;
    });

  return { caps, accounts, partial };
}
async function fetchAftermathClearingHouses(force = false) {
  const now = Date.now();
  if (!force
    && afClearingHouseDiscoveryCache.rows?.length
    && (now - afClearingHouseDiscoveryCache.at) < AF_CLEARING_HOUSE_DISCOVERY_TTL_MS) {
    return {
      rows: afClearingHouseDiscoveryCache.rows,
      partial: !!afClearingHouseDiscoveryCache.partial,
      warnings: [],
    };
  }
  const byId = {};
  for (const [id, label] of Object.entries(AF_CLEARING_HOUSES)) {
    const norm = normalizeSuiAddress(id) || id;
    byId[norm] = { id: norm, label, known: true };
  }
  let partial = false;
  const warnings = [];
  let after = null;
  for (let page = 0; page < AF_CLEARING_HOUSE_DISCOVERY_MAX_PAGES; page += 1) {
    const data = await gql(`query($type: String!, $after: String, $first: Int!) {
      objects(filter: { type: $type }, first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { address }
      }
    }`, {
      type: AF_CLEARING_HOUSE_TYPE,
      after,
      first: AF_ORDERBOOK_PAGE_SIZE,
    });
    const conn = data?.objects;
    for (const row of (conn?.nodes || [])) {
      const id = normalizeSuiAddress(row?.address || "");
      if (!id) continue;
      if (!byId[id]) byId[id] = { id, label: afMarketLabel(id), known: false };
    }
    if (!conn?.pageInfo?.hasNextPage) {
      after = null;
      break;
    }
    after = conn?.pageInfo?.endCursor || null;
    if (!after) break;
    if (page === AF_CLEARING_HOUSE_DISCOVERY_MAX_PAGES - 1) {
      partial = true;
      warnings.push("Aftermath market discovery reached pagination cap; discovered market list may be partial.");
    }
  }
  const rows = Object.values(byId).sort((a, b) => {
    const ak = a.known ? 0 : 1;
    const bk = b.known ? 0 : 1;
    if (ak !== bk) return ak - bk;
    return String(a.label || "").localeCompare(String(b.label || ""));
  });
  afClearingHouseDiscoveryCache = { at: now, rows, partial };
  return { rows, partial, warnings };
}
async function fetchAftermathPositionStates(accountCaps, markets) {
  const combos = [];
  let aliasIndex = 0;
  for (const cap of (accountCaps || [])) {
    for (const m of (markets || [])) {
      combos.push({
        alias: `afp${aliasIndex += 1}`,
        accountId: cap.accountId,
        chId: m.id,
        market: m.label,
      });
    }
  }
  if (!combos.length) return { states: [], totalCollateral: 0 };
  const states = [];
  let totalCollateral = 0;
  for (const batch of chunkArray(combos, AF_POSITION_QUERY_BATCH)) {
    const fields = batch.map((row) => `${row.alias}: object(address: "${row.chId}") {
      dynamicField(name: { type: "${AF_POSITION_KEY_TYPE}", bcs: "${u64Bcs(row.accountId)}" }) {
        value { ... on MoveValue { json } }
      }
    }`).join("\n");
    const data = await gql(`{ ${fields} }`);
    for (const row of batch) {
      const pos = data?.[row.alias]?.dynamicField?.value?.json;
      if (!pos) continue;
      const baseRaw = parseIFixedRaw(pos.base_asset_amount);
      const notionalRaw = parseIFixedRaw(pos.quote_asset_notional_amount);
      const collateralRaw = parseIFixedRaw(pos.collateral);
      const askRawAbs = parseIFixedRaw(pos.asks_quantity);
      const bidRawAbs = parseIFixedRaw(pos.bids_quantity);
      const askAbs = askRawAbs < 0n ? -askRawAbs : askRawAbs;
      const bidAbs = bidRawAbs < 0n ? -bidRawAbs : bidRawAbs;
      const collAbs = collateralRaw < 0n ? -collateralRaw : collateralRaw;
      const pendingRaw = Number(pos.pending_orders || 0);
      const pendingOrders = Number.isFinite(pendingRaw) ? Math.max(0, Math.floor(pendingRaw)) : 0;

      const hasOpenPosition = (baseRaw > AF_PERPS_EPS_RAW || baseRaw < -AF_PERPS_EPS_RAW)
        || (notionalRaw > AF_PERPS_EPS_RAW || notionalRaw < -AF_PERPS_EPS_RAW);
      const hasOpenOrders = pendingOrders > 0 || askAbs > AF_PERPS_EPS_RAW || bidAbs > AF_PERPS_EPS_RAW;
      if (!hasOpenPosition && !hasOpenOrders && collAbs < AF_COLLATERAL_DUST_RAW) continue;

      const baseSize = scaledBigIntAbsToApprox(baseRaw, AF_IFIXED_SCALE_DECIMALS, 8);
      const notionalAbs = scaledBigIntAbsToApprox(notionalRaw, AF_IFIXED_SCALE_DECIMALS, 8);
      const entryPrice = baseSize > AF_PERPS_SIZE_EPS ? notionalAbs / baseSize : NaN;
      let side = "flat";
      if (baseRaw > AF_PERPS_EPS_RAW) side = "long";
      else if (baseRaw < -AF_PERPS_EPS_RAW) side = "short";
      else if (bidAbs > askAbs) side = "long";
      else if (askAbs > bidAbs) side = "short";
      const collateral = scaledBigIntToApprox(collateralRaw, AF_IFIXED_SCALE_DECIMALS, 8);
      if (collateral > AF_PERPS_COLLATERAL_DUST) totalCollateral += collateral;
      states.push({
        key: afMarketAccountKey(row.chId, row.accountId),
        chId: row.chId,
        market: row.market || afMarketLabel(row.chId),
        accountId: row.accountId,
        side,
        hasOpenPosition,
        hasOpenOrders,
        pendingOrders,
        baseRaw,
        notionalRaw,
        collateralRaw,
        askRawAbs: askAbs,
        bidRawAbs: bidAbs,
        size: baseSize,
        entryPrice,
        notionalAbs,
        collateral,
      });
    }
  }
  return { states, totalCollateral };
}
async function fetchAftermathOrderbookRefs(markets) {
  const refs = {};
  const warnings = [];
  let partial = false;
  const validMarkets = (markets || []).filter(m => m?.id);
  if (!validMarkets.length) return { refs, partial, warnings };

  // Pass 1: batch-fetch clearing house dynamic fields for all markets in parallel
  const chAliases = validMarkets.map((m, i) => `ch${i}: object(address: "${m.id}") { dynamicFields(first: 50) { pageInfo { hasNextPage } nodes { name { type { repr } } value { ... on MoveObject { address } } } } }`);
  let chData;
  try { chData = await gql(`{ ${chAliases.join("\n")} }`); } catch (e) { return { refs, partial: true, warnings: [`Orderbook batch lookup failed: ${e?.message || "unknown"}`] }; }

  // Extract orderbook IDs from clearing house results
  const obLookups = []; // { market, orderbookId, idx }
  for (let i = 0; i < validMarkets.length; i++) {
    const market = validMarkets[i];
    const chConn = chData?.[`ch${i}`]?.dynamicFields;
    if (chConn?.pageInfo?.hasNextPage) { partial = true; warnings.push(`Orderbook reference scan for ${market.label} was truncated.`); }
    const obNode = (chConn?.nodes || []).find(n => n?.name?.type?.repr === AF_ORDERBOOK_KEY_TYPE);
    const orderbookId = normalizeSuiAddress(obNode?.value?.address || "");
    if (!orderbookId) { partial = true; warnings.push(`Missing orderbook reference for ${market.label}.`); continue; }
    obLookups.push({ market, orderbookId, idx: obLookups.length });
  }
  if (!obLookups.length) return { refs, partial, warnings };

  // Pass 2: batch-fetch orderbook dynamic fields (asks/bids map IDs)
  const obAliases = obLookups.map((o, i) => `ob${i}: object(address: "${o.orderbookId}") { dynamicFields(first: 10) { pageInfo { hasNextPage } nodes { name { type { repr } } value { ... on MoveObject { address } } } } }`);
  let obData;
  try { obData = await gql(`{ ${obAliases.join("\n")} }`); } catch (e) { return { refs, partial: true, warnings: [...warnings, `Orderbook map batch lookup failed: ${e?.message || "unknown"}`] }; }

  for (let i = 0; i < obLookups.length; i++) {
    const { market, orderbookId } = obLookups[i];
    const obConn = obData?.[`ob${i}`]?.dynamicFields;
    if (obConn?.pageInfo?.hasNextPage) { partial = true; warnings.push(`Orderbook map scan for ${market.label} was truncated.`); }
    const asksMapId = normalizeSuiAddress((obConn?.nodes || []).find(n => n?.name?.type?.repr === AF_ASKS_MAP_KEY_TYPE)?.value?.address || "");
    const bidsMapId = normalizeSuiAddress((obConn?.nodes || []).find(n => n?.name?.type?.repr === AF_BIDS_MAP_KEY_TYPE)?.value?.address || "");
    if (!asksMapId || !bidsMapId) { partial = true; warnings.push(`Could not resolve asks/bids maps for ${market.label}.`); continue; }
    refs[market.id] = { orderbookId, asksMapId, bidsMapId };
  }
  return { refs, partial, warnings };
}
async function fetchAftermathOrdersFromMap(mapId, side, market, accountSet) {
  const orders = [];
  const seen = new Set();
  let after = null;
  let partial = false;
  for (let page = 0; page < AF_ORDERBOOK_MAX_PAGES; page += 1) {
    const data = await gql(`query($id: SuiAddress!, $after: String, $first: Int!) {
      object(address: $id) {
        dynamicFields(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            value {
              ... on MoveValue {
                type { repr }
                json
              }
            }
          }
        }
      }
    }`, {
      id: mapId,
      after,
      first: AF_ORDERBOOK_PAGE_SIZE,
    });
    const conn = data?.object?.dynamicFields;
    for (const node of (conn?.nodes || [])) {
      const leaf = node?.value?.json;
      const entries = Array.isArray(leaf?.keys_vals) ? leaf.keys_vals : [];
      for (const kv of entries) {
        const accountId = afNormalizeAccountId(kv?.val?.account_id);
        if (!accountId) continue;
        if (accountSet && !accountSet.has(accountId)) continue;
        const orderId = String(kv?.key || "").trim();
        if (!orderId) continue;
        const seenKey = `${side}:${orderId}:${accountId}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        const sizeRaw = parseBigIntSafe(kv?.val?.size || 0);
        if (sizeRaw <= 0n) continue;
        const expirationRaw = kv?.val?.expiration_timestamp_ms;
        const expirationNum = Number(expirationRaw);
        const expirationMs = Number.isFinite(expirationNum) && expirationNum > 0 ? expirationNum : NaN;
        // ordered_map key encodes (price << 64 | sequence); price in 1e9 fixed-point
        const orderKeyBig = parseBigIntSafe(kv?.key || 0);
        const priceTicks = orderKeyBig >> 64n;
        const price = Number(priceTicks) / 1e9;
        orders.push({
          market: market?.label || afMarketLabel(market?.id || ""),
          chId: market?.id || "",
          accountId,
          side,
          orderId,
          price: Number.isFinite(price) && price > 0 ? price : NaN,
          sizeRaw,
          size: scaledBigIntToApprox(sizeRaw, AF_ORDER_SIZE_DECIMALS, 8),
          sizeText: scaledBigIntToText(sizeRaw, AF_ORDER_SIZE_DECIMALS, 8),
          reduceOnly: kv?.val?.reduce_only === true || kv?.val?.reduce_only === "true",
          expirationMs,
          kind: `Maker Limit (${Number.isFinite(expirationMs) ? "GTD" : "GTC"})`,
          synthetic: false,
        });
      }
    }
    if (!conn?.pageInfo?.hasNextPage) {
      after = null;
      break;
    }
    after = conn?.pageInfo?.endCursor || null;
    if (!after) break;
    if (page === AF_ORDERBOOK_MAX_PAGES - 1) partial = true;
  }
  return { orders, partial };
}
async function fetchAftermathRecentOrderEvents(addr, accountSet) {
  const out = {};
  const data = await gql(`query($addr: SuiAddress!) {
    address(address: $addr) {
      transactions(last: ${AF_ORDER_EVENT_TX_SCAN}) {
        nodes {
          digest
          effects {
            timestamp
            events(first: ${AF_ORDER_EVENT_PER_TX}) {
              nodes {
                ${GQL_F_CONTENTS_TYPE_JSON}
              }
            }
          }
        }
      }
    }
  }`, { addr });
  const txs = data?.address?.transactions?.nodes || [];
  for (const tx of txs) {
    const tsMs = parseTsMs(tx?.effects?.timestamp);
    for (const ev of (tx?.effects?.events?.nodes || [])) {
      const type = ev?.contents?.type?.repr || "";
      if (!type.startsWith(`${AF_PERPS_PKG}::events::`)) continue;
      const tail = type.split("::").pop() || "";
      if (tail !== "PostedOrder" && tail !== "CanceledOrder") continue;
      const json = ev?.contents?.json || {};
      const accountId = afNormalizeAccountId(json.account_id);
      if (!accountId) continue;
      if (accountSet?.size && !accountSet.has(accountId)) continue;
      const orderId = String(json.order_id || "").trim();
      if (!orderId) continue;
      const prev = out[orderId];
      if (!prev || (Number.isFinite(tsMs) && (!Number.isFinite(prev.tsMs) || tsMs >= prev.tsMs))) {
        out[orderId] = {
          action: tail === "PostedOrder" ? "posted" : "canceled",
          tsMs,
          digest: String(tx?.digest || ""),
        };
      }
    }
  }
  return out;
}
// ── Aftermath Perpetuals Fetcher ────────────────────────────────────────
async function fetchAftermathPerpsPositions(addr) {
  try {
    const warnings = [];
    let partial = false;

    const capsMeta = await fetchAftermathAccountCaps(addr);
    const caps = capsMeta.caps || [];
    const accounts = capsMeta.accounts || [];
    if (capsMeta.partial) {
      partial = true;
      warnings.push("AccountCap scan reached pagination cap; account coverage may be partial.");
    }
    if (!accounts.length) {
      return { accounts: [], caps: [], markets: [], positions: [], orders: [], collateral: 0, partial, warnings };
    }

    let marketRows = [];
    try {
      const marketMeta = await fetchAftermathClearingHouses();
      marketRows = marketMeta.rows || [];
      if (marketMeta.partial) partial = true;
      for (const w of (marketMeta.warnings || [])) warnings.push(w);
    } catch (e) {
      partial = true;
      warnings.push(`Market discovery failed: ${e?.message || "unknown error"}. Falling back to configured market list.`);
    }
    if (!marketRows.length) {
      marketRows = Object.keys(AF_CLEARING_HOUSES).map((id) => ({
        id: normalizeSuiAddress(id) || id,
        label: afMarketLabel(id),
        known: true,
      }));
    }

    const posMeta = await fetchAftermathPositionStates(accounts, marketRows);
    const states = posMeta.states || [];
    const stateByKey = {};
    for (const s of states) stateByKey[s.key] = s;
    const totalCollateral = Number.isFinite(posMeta.totalCollateral) ? posMeta.totalCollateral : 0;

    const positions = states
      .filter((s) => s.hasOpenPosition)
      .map((s) => ({
        market: s.market,
        chId: s.chId,
        accountId: s.accountId,
        side: s.side,
        isLong: s.side === "long",
        size: s.size,
        entryPrice: s.entryPrice,
        notional: s.notionalAbs,
        collateral: s.collateral,
        pendingOrders: s.pendingOrders,
        hasOpenOrders: s.hasOpenOrders,
      }));

    const expectedByKey = {};
    const accountSetByMarket = {};
    const allAccountIds = new Set(accounts.map((c) => c.accountId));
    for (const s of states) {
      if (!s.hasOpenOrders) continue;
      const expected = s.pendingOrders > 0 ? s.pendingOrders : 1;
      expectedByKey[s.key] = Math.max(expectedByKey[s.key] || 0, expected);
      if (!accountSetByMarket[s.chId]) accountSetByMarket[s.chId] = new Set();
      accountSetByMarket[s.chId].add(s.accountId);
    }

    const orders = [];
    const marketsWithOpenOrders = marketRows.filter((m) => accountSetByMarket[m.id]?.size);
    if (marketsWithOpenOrders.length) {
      const refMeta = await fetchAftermathOrderbookRefs(marketsWithOpenOrders);
      if (refMeta.partial) partial = true;
      for (const w of (refMeta.warnings || [])) warnings.push(w);

      for (const market of marketsWithOpenOrders) {
        const refs = refMeta.refs?.[market.id];
        const accountSet = accountSetByMarket[market.id];
        if (!refs || !accountSet?.size) continue;
        const [asks, bids] = await Promise.all([
          fetchAftermathOrdersFromMap(refs.asksMapId, "short", market, accountSet),
          fetchAftermathOrdersFromMap(refs.bidsMapId, "long", market, accountSet),
        ]);
        orders.push(...asks.orders, ...bids.orders);
        if (asks.partial || bids.partial) {
          partial = true;
          warnings.push(`Orderbook scan for ${market.label} reached pagination cap; open-order detail may be partial.`);
        }
      }
    }

    const foundByKey = {};
    for (const o of orders) {
      const key = afMarketAccountKey(o.chId, o.accountId);
      foundByKey[key] = (foundByKey[key] || 0) + 1;
    }

    for (const [key, expected] of Object.entries(expectedByKey)) {
      const found = foundByKey[key] || 0;
      if (found >= expected) continue;
      partial = true;
      const [chId, accountId] = key.split("::");
      warnings.push(`Order coverage mismatch for ${afMarketLabel(chId)} account ${accountId}: found ${found}/${expected}.`);
      const st = stateByKey[key];
      if (!st || found > 0) continue;
      if (st.askRawAbs > AF_PERPS_EPS_RAW) {
        orders.push({
          market: st.market,
          chId: st.chId,
          accountId: st.accountId,
          side: "short",
          orderId: "",
          sizeRaw: st.askRawAbs,
          size: scaledBigIntAbsToApprox(st.askRawAbs, AF_IFIXED_SCALE_DECIMALS, 8),
          sizeText: scaledBigIntToText(st.askRawAbs, AF_IFIXED_SCALE_DECIMALS, 8),
          reduceOnly: false,
          expirationMs: NaN,
          kind: "Inferred Aggregate",
          synthetic: true,
        });
      }
      if (st.bidRawAbs > AF_PERPS_EPS_RAW) {
        orders.push({
          market: st.market,
          chId: st.chId,
          accountId: st.accountId,
          side: "long",
          orderId: "",
          sizeRaw: st.bidRawAbs,
          size: scaledBigIntAbsToApprox(st.bidRawAbs, AF_IFIXED_SCALE_DECIMALS, 8),
          sizeText: scaledBigIntToText(st.bidRawAbs, AF_IFIXED_SCALE_DECIMALS, 8),
          reduceOnly: false,
          expirationMs: NaN,
          kind: "Inferred Aggregate",
          synthetic: true,
        });
      }
      if (st.askRawAbs <= AF_PERPS_EPS_RAW && st.bidRawAbs <= AF_PERPS_EPS_RAW && st.pendingOrders > 0) {
        orders.push({
          market: st.market,
          chId: st.chId,
          accountId: st.accountId,
          side: "flat",
          orderId: "",
          sizeRaw: 0n,
          size: NaN,
          sizeText: "",
          reduceOnly: false,
          expirationMs: NaN,
          kind: "Inferred Pending Orders",
          synthetic: true,
        });
      }
    }

    const hasConcreteOrders = orders.some((o) => !o.synthetic && o.orderId);
    if (hasConcreteOrders) {
      try {
        const recent = await fetchAftermathRecentOrderEvents(addr, allAccountIds);
        for (const o of orders) {
          if (o.synthetic || !o.orderId) continue;
          const ev = recent[o.orderId];
          if (!ev) continue;
          o.lastEventAction = ev.action;
          o.lastEventTsMs = ev.tsMs;
          o.lastEventDigest = ev.digest;
        }
      } catch (e) {
        partial = true;
        warnings.push(`Recent order-event enrichment failed: ${e?.message || "unknown error"}`);
      }
    }

    positions.sort((a, b) => (b.notional || 0) - (a.notional || 0) || (b.size || 0) - (a.size || 0));
    orders.sort((a, b) =>
      String(a.market || "").localeCompare(String(b.market || ""))
      || String(a.accountId || "").localeCompare(String(b.accountId || ""))
      || (a.side === b.side ? 0 : (a.side === "long" ? -1 : 1))
      || (b.size || 0) - (a.size || 0));

    return {
      accounts,
      caps,
      markets: marketRows,
      positions,
      orders,
      collateral: totalCollateral,
      partial,
      warnings: [...new Set(warnings)].slice(0, 12),
    };
  } catch (e) {
    return {
      accounts: [],
      caps: [],
      markets: [],
      positions: [],
      orders: [],
      collateral: 0,
      partial: true,
      warnings: [e?.message || "Aftermath fetch failed."],
    };
  }
}

// ── Address View ────────────────────────────────────────────────────────
async function fetchAddressShell(addrNorm, force = false) {
  const addressShellStorageKey = persistedEntityCacheKey(PERSISTED_CACHE_KEYS.addressShellPrefix, addrNorm);
  const addressShellState = getKeyedCacheState(addressShellCache, addrNorm);
  hydratePersistedTimedCacheState(addressShellState, addressShellStorageKey, ENTITY_SHELL_TTL_MS);
  return withTimedCache(addressShellState, ENTITY_SHELL_TTL_MS, force, async () => {
    const result = await gql(`query($addr: SuiAddress!) {
      address(address: $addr) {
        address
        defaultNameRecord { domain }
        objects(first: 20) {
          pageInfo { hasNextPage endCursor }
          nodes {
            address version digest
            ${GQL_F_CONTENTS_TYPE_JSON}
          }
        }
      }
    }`, { addr: addrNorm });
    writePersistedTimedCacheRecord(addressShellStorageKey, result, 45000);
    return result;
  });
}

async function renderAddress(app, addr) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const rawAddr = decodeURIComponent(String(addr || ""));
  const addrNorm = normalizeSuiAddress(rawAddr);
  if (!addrNorm) {
    const asCoinType = normalizeCoinTypeQueryInput(rawAddr);
    if (asCoinType) {
      navigate("/coin?type=" + encodeURIComponent(asCoinType));
      return;
    }
    app.innerHTML = renderEmpty(`Invalid address: ${escapeHtml(rawAddr || String(addr || ""))}`);
    return;
  }

  const data = await fetchAddressShell(addrNorm, false);

  // If address query returns null, try as object
  if (!data.address) {
    return renderObjectDetail(app, addrNorm);
  }

  const a = data.address;
  let allTxs = [];
  let txPageInfo = { hasPreviousPage: false, startCursor: "" };
  let txFilterState = txListNormalizeDateState({ preset: "all" });
  let txFilterMeta = { filter: null, fromMs: NaN, toMs: NaN, note: "", error: "" };
  let txLoading = false;
  let txLoadError = "";
  let allObjects = a.objects?.nodes || [];
  let objPageInfo = a.objects?.pageInfo || {};
  const name = a.defaultNameRecord?.domain;
  let activeTab = "txs";
  let initialTxLoadPromise = null;

  // DeFi data is loaded only when the user opens the DeFi tab.
  let defiLoaded = false;
  let defiHtml = "";

  async function loadAddressTransactions(before = null, append = false) {
    txLoadError = "";
    txFilterMeta = await txListResolveDateFilter(txFilterState);
    if (txFilterMeta.error) {
      allTxs = [];
      txPageInfo = { hasPreviousPage: false, startCursor: "" };
      txLoadError = txFilterMeta.error;
      return;
    }

    try {
      const more = await gql(`query($addr: SuiAddress!, $before: String, $filter: TransactionFilter) {
        address(address: $addr) {
          transactions(last: 20, before: $before, filter: $filter) {
            pageInfo { hasPreviousPage startCursor }
            nodes {
              digest
              sender { address }
              kind {
                __typename
                ... on ProgrammableTransaction {
                  commands(first: 3) { nodes { __typename ... on MoveCallCommand { function { name module { name package { address } } } } } }
                }
              }
              effects {
                status timestamp
                checkpoint { sequenceNumber }
                balanceChanges(first: 50) {
                  pageInfo { hasNextPage }
                  nodes { ${GQL_F_BAL_NODE} }
                }
                events(first: 3) { nodes { contents { type { repr } } } }
              }
            }
          }
        }
      }`, { addr: addrNorm, before, filter: txFilterMeta.filter });
      const rows = (more?.address?.transactions?.nodes || [])
        .reverse()
        .filter((t) => txListWithinRange(t, txFilterMeta.fromMs, txFilterMeta.toMs));
      for (const tx of rows) {
        const seq = Number(tx?.effects?.checkpoint?.sequenceNumber);
        const tsMs = parseTsMs(tx?.effects?.timestamp);
        if (Number.isFinite(seq) && Number.isFinite(tsMs)) txListRememberCheckpointHint(tsMs, seq);
      }
      allTxs = append ? [...allTxs, ...rows] : rows;
      txPageInfo = more?.address?.transactions?.pageInfo || { hasPreviousPage: false, startCursor: "" };
    } catch (e) {
      allTxs = append ? allTxs : [];
      txPageInfo = { hasPreviousPage: false, startCursor: "" };
      txLoadError = e?.message || "Failed to load transactions.";
    }
  }

  async function ensureInitialAddressTransactions() {
    if (initialTxLoadPromise) return initialTxLoadPromise;
    initialTxLoadPromise = (async () => {
      try {
        await loadAddressTransactions(null, false);
      } finally {
        txLoading = false;
        if (isActiveRoute()) renderTabs(activeTab);
      }
    })();
    return initialTxLoadPromise;
  }

  txLoading = true;

  const tabContent = {
    txs: () => {
      const txRows = txListBuildRows(allTxs);
      const txBody = txLoading
        ? renderLoading()
        : (txLoadError
          ? renderEmpty(`Failed to load transactions: ${escapeHtml(txLoadError)}`)
          : (!txRows.length
            ? renderEmpty(txFilterState.preset === "all"
              ? "No transactions found."
              : "No transactions matched this timestamp range.")
            : `<table>
              <thead><tr><th>Digest</th><th>Summary</th><th>Sender</th><th>Status</th><th>Time</th></tr></thead>
              <tbody>${txRows.map((row) => `<tr>
                <td>${hashLink(row.tx.digest, '/tx/' + row.tx.digest)}</td>
                <td class="tx-flow-cell">
                  <div class="tx-flow-main${row.flow.hasFlows ? "" : " tx-flow-empty"}">${escapeHtml(row.summary)}</div>
                  <div class="u-fs11-dim">${renderIntentChip(row.intent)}${row.flow.partial ? ' <span class="tx-flow-partial">partial</span>' : ''}</div>
                </td>
                <td>${row.tx.sender ? hashLink(row.tx.sender.address, '/address/' + row.tx.sender.address) : "—"}</td>
                <td>${statusBadge(row.tx.effects?.status)}</td>
                <td>${timeTag(row.tx.effects?.timestamp)}</td>
              </tr>`).join("")}</tbody>
            </table>`));
      return `
        <div class="tx-list-toolbar">
          <div class="tx-list-toolbar-left">
            <span class="u-fs12-dim">Timestamp filter</span>
            <select id="addr-tx-date-preset" class="ui-control">
              <option value="all" ${txFilterState.preset === "all" ? "selected" : ""}>All time</option>
              <option value="7d" ${txFilterState.preset === "7d" ? "selected" : ""}>Last 7 days</option>
              <option value="30d" ${txFilterState.preset === "30d" ? "selected" : ""}>Last 30 days</option>
              <option value="custom" ${txFilterState.preset === "custom" ? "selected" : ""}>Custom</option>
            </select>
            ${txFilterState.preset === "custom" ? `<div class="tx-date-custom">
              <input type="date" id="addr-tx-date-from" class="ui-control" value="${escapeAttr(txFilterState.fromDate)}">
              <span class="u-c-dim">to</span>
              <input type="date" id="addr-tx-date-to" class="ui-control" value="${escapeAttr(txFilterState.toDate)}">
              <button data-action="addr-tx-date-apply" class="btn-surface-sm">Apply</button>
            </div>` : ""}
          </div>
          <div class="tx-list-toolbar-right">
            <button data-action="addr-tx-export-csv" class="btn-surface-sm" ${txRows.length ? "" : "disabled"}>Download CSV</button>
          </div>
        </div>
        ${txFilterMeta.note ? `<div class="tx-filter-note">${escapeHtml(txFilterMeta.note)}</div>` : ""}
        ${txBody}
        ${!txLoading && !txLoadError && txPageInfo.hasPreviousPage ? `<div class="pagination"><button data-action="addr-load-more-txs">Load older transactions</button></div>` : ""}
      `;
    },
    objects: () => {
      if (!allObjects.length) return renderEmpty("No owned objects.");
      return `<table>
        <thead><tr><th>Object ID</th><th>Type</th><th>Version</th></tr></thead>
        <tbody>${allObjects.map(o => `<tr>
          <td>${hashLink(o.address, '/object/' + o.address)}</td>
          <td class="u-fs12-dim">${shortType(o.contents?.type?.repr)}</td>
          <td class="u-mono-12">${o.version ?? "—"}</td>
        </tr>`).join("")}</tbody>
      </table>
      ${objPageInfo.hasNextPage ? `<div class="pagination"><button id="load-more-objs">Load more objects</button></div>` : ""}`;
    },
    defi: () => {
      if (!defiLoaded) return renderLoading();
      return defiHtml || renderEmpty("No DeFi positions found.");
    },
  };

  async function loadDefi() {
    if (defiLoaded) return;
    // Phase 1: Get SUI price + stablecoins + LSTs quickly (skip slow pool oracle)
    await Promise.all([fetchDefiPrices(false, { skipOracle: true }), fetchLstExchangeRates()]);
    // Phase 2: Run pool oracle concurrently with position fetchers
    const [, results] = await Promise.all([
      fetchPoolOraclePrices().catch(() => null),
      Promise.allSettled([
      fetchSuilendPositions(addrNorm), fetchNaviPositions(addrNorm),
      fetchAlphaPositions(addrNorm), fetchScallopPositions(addrNorm),
      fetchCetusPositions(addrNorm), fetchTurbosPositions(addrNorm),
      fetchDefiWalletBalances(addrNorm), fetchDeepBookPositions(addrNorm),
      fetchBluefinSpotPositions(addrNorm), fetchBluefinProPositions(addrNorm),
      fetchAftermathPerpsPositions(addrNorm),
      ]),
    ]);
    // Sync LSTs + stablecoins + BTC variants now that oracle is done
    syncPeggedPrices();

    const [suilend, navi, alpha, scallop, cetus, turbos, wallet, deepbook, bluefinSpot, bluefinPro, aftermathPerps] = results;
    const suilendPos = suilend.status === "fulfilled" ? suilend.value : [];
    const naviPos = navi.status === "fulfilled" ? navi.value : [];
    const alphaPos = alpha.status === "fulfilled" ? alpha.value : [];
    const scallopPos = scallop.status === "fulfilled" ? scallop.value : [];
    const cetusPos = cetus.status === "fulfilled" ? cetus.value : [];
    const turbosPos = turbos.status === "fulfilled" ? turbos.value : [];
    const walletBals = wallet.status === "fulfilled" ? wallet.value : [];
    const db = deepbook.status === "fulfilled" ? deepbook.value : { positions: [], pools: {}, riskConfigs: {} };
    const bluefinSpotPos = bluefinSpot.status === "fulfilled" ? bluefinSpot.value : [];
    const bluefinProData = bluefinPro.status === "fulfilled" ? bluefinPro.value : { positions: [], collateral: 0 };
    const afPerpsData = aftermathPerps.status === "fulfilled"
      ? aftermathPerps.value
      : { accounts: [], caps: [], markets: [], positions: [], orders: [], collateral: 0, partial: true, warnings: ["Aftermath fetch failed."] };

    // Derive XAUM (gold) price from Aftermath XAUT/USD order prices if no DEX liquidity
    if (!defiPrices.XAUM || defiPrices.XAUM <= 0) {
      const goldOrders = afPerpsData.orders.filter(o => (o.market || "").includes("XAUT") && Number.isFinite(o.price) && o.price > 0);
      if (goldOrders.length) {
        const mid = goldOrders.reduce((s, o) => s + o.price, 0) / goldOrders.length;
        if (mid > 0) defiPrices.XAUM = mid;
      } else {
        const goldPos = afPerpsData.positions.filter(p => (p.market || "").includes("XAUT") && Number.isFinite(p.entryPrice) && p.entryPrice > 0);
        if (goldPos.length) defiPrices.XAUM = goldPos[0].entryPrice;
      }
    }

    // Second pricing pass: price any tokens discovered by fetchers but missing from defiPrices
    const allCoinTypes = new Set();
    for (const b of walletBals) { if (b.coinType) allCoinTypes.add(b.coinType); }
    await ensurePrices([...allCoinTypes]);
    // Recompute wallet USD values with fresh prices
    for (const b of walletBals) {
      const lstRate = b.isLST ? (lstExchangeRates[b.symbol] || 1) : 1;
      b.price = b.isLST ? (defiPrices.SUI || 0) * lstRate : (defiPrices[b.symbol] || 0);
      b.usdValue = b.amount * b.price;
    }
    // Recompute lending position USD values now that prices are available
    for (const pos of [...naviPos, ...alphaPos]) {
      let depUsd = 0, borUsd = 0;
      for (const d of (pos.deposits || [])) {
        if (d.amountUsd <= 0 && d.amount > 0 && defiPrices[d.symbol] > 0) d.amountUsd = d.amount * defiPrices[d.symbol];
        depUsd += d.amountUsd;
      }
      for (const b of (pos.borrows || [])) {
        if (b.amountUsd <= 0 && b.amount > 0 && defiPrices[b.symbol] > 0) b.amountUsd = b.amount * defiPrices[b.symbol];
        borUsd += b.amountUsd;
      }
      if (pos.depositedUsd <= 0 && depUsd > 0) pos.depositedUsd = depUsd;
      if (pos.borrowedUsd <= 0 && borUsd > 0) pos.borrowedUsd = borUsd;
      pos.netUsd = pos.depositedUsd - pos.borrowedUsd;
    }

    // Separate LSTs from regular wallet holdings
    const lstBals = walletBals.filter(b => b.isLST);
    const regularBals = walletBals.filter(b => !b.isLST);

    // Aggregate totals
    const allLending = [...suilendPos, ...naviPos, ...alphaPos, ...scallopPos];
    const allDexLp = [...cetusPos, ...turbosPos, ...bluefinSpotPos];
    let totalSupplied = allLending.reduce((s, p) => s + (p.depositedUsd || 0), 0);
    const totalBorrowed = allLending.reduce((s, p) => s + (p.borrowedUsd || 0), 0);
    const totalWallet = regularBals.reduce((s, b) => s + b.usdValue, 0);
    const totalLst = lstBals.reduce((s, b) => s + b.usdValue, 0);
    const totalDexLp = allDexLp.reduce((s, p) => s + p.totalUsd, 0);
    let dbCollateralUsd = 0;
    for (const pos of db.positions) {
      for (const c of pos.collateral) {
        const dec = c.decimals || getDecimals(c.symbol);
        dbCollateralUsd += (c.amount / Math.pow(10, dec)) * (defiPrices[c.symbol] || 0);
      }
    }
    totalSupplied += dbCollateralUsd;
    totalSupplied += bluefinProData.collateral;
    totalSupplied += afPerpsData.collateral * (defiPrices["USDC"] || 1);
    const netWorth = totalWallet + totalLst + totalSupplied - totalBorrowed + totalDexLp;

    const hasAnything = allLending.length
      || allDexLp.length
      || walletBals.length
      || db.positions.length
      || bluefinProData.positions.length
      || afPerpsData.accounts.length
      || afPerpsData.positions.length
      || afPerpsData.orders.length
      || afPerpsData.collateral > 0;
    if (!hasAnything) {
      const errors = [];
      if (suilend.status === "rejected") errors.push("Suilend");
      if (navi.status === "rejected") errors.push("NAVI");
      if (alpha.status === "rejected") errors.push("Alpha");
      if (scallop.status === "rejected") errors.push("Scallop");
      if (cetus.status === "rejected") errors.push("Cetus");
      if (turbos.status === "rejected") errors.push("Turbos");
      if (deepbook.status === "rejected") errors.push("DeepBook");
      if (bluefinSpot.status === "rejected") errors.push("Bluefin Spot");
      if (bluefinPro.status === "rejected") errors.push("Bluefin Pro");
      if (aftermathPerps.status === "rejected") errors.push("Aftermath Perps");
      defiHtml = renderEmpty("No DeFi positions found." + (errors.length ? " (Failed: " + errors.map(escapeHtml).join(", ") + ")" : ""));
      defiLoaded = true;
      if (isActiveRoute()) renderTabs("defi");
      return;
    }

    let html = `<div style="padding:16px">`;
    // ─── Summary cards ──────────────────────
    html += `<div class="stats-grid u-mb16">`;
    html += `<div class="stat-box"><div class="stat-label">Net Worth</div><div class="stat-value" style="color:${netWorth >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtUsdFromFloat(Math.abs(netWorth))}</div></div>`;
    if (totalWallet > 0) html += `<div class="stat-box"><div class="stat-label">Wallet</div><div class="stat-value u-c-purple">${fmtUsdFromFloat(totalWallet)}</div><div class="stat-sub">${regularBals.length} tokens</div></div>`;
    if (totalLst > 0) html += `<div class="stat-box"><div class="stat-label">Liquid Staking</div><div class="stat-value u-c-accent">${fmtUsdFromFloat(totalLst)}</div><div class="stat-sub">${lstBals.length} LSTs</div></div>`;
    if (totalSupplied > 0 || totalBorrowed > 0) {
      const netSupply = totalSupplied - totalBorrowed;
      html += `<div class="stat-box"><div class="stat-label">Net Supply</div><div class="stat-value" style="color:${netSupply >= 0 ? 'var(--green)' : 'var(--red)'}">${netSupply >= 0 ? '' : '-'}${fmtUsdFromFloat(Math.abs(netSupply))}</div><div class="stat-sub">${fmtUsdFromFloat(totalSupplied)} supplied · ${fmtUsdFromFloat(totalBorrowed)} borrowed</div></div>`;
    }
    if (totalDexLp > 0) html += `<div class="stat-box"><div class="stat-label">DEX LP</div><div class="stat-value u-c-accent">${fmtUsdFromFloat(totalDexLp)}</div><div class="stat-sub">${allDexLp.length} positions</div></div>`;
    if (db.positions.length > 0) html += `<div class="stat-box"><div class="stat-label">DeepBook Margin</div><div class="stat-value u-c-accent">${db.positions.length}</div><div class="stat-sub">positions</div></div>`;
    if (bluefinProData.positions.length > 0) html += `<div class="stat-box"><div class="stat-label">Bluefin Perps</div><div class="stat-value u-c-blue">${bluefinProData.positions.length}</div><div class="stat-sub">${fmtUsdFromFloat(bluefinProData.collateral)} collateral</div></div>`;
    if (afPerpsData.accounts.length || afPerpsData.positions.length > 0 || afPerpsData.orders.length > 0 || afPerpsData.collateral > 0) {
      html += `<div class="stat-box"><div class="stat-label">Aftermath Perps</div><div class="stat-value u-c-blue">${afPerpsData.positions.length + afPerpsData.orders.length}</div><div class="stat-sub">${afPerpsData.accounts.length} acct · ${afPerpsData.positions.length} pos · ${afPerpsData.orders.length} orders · ${fmtUsdFromFloat(afPerpsData.collateral)} collateral</div></div>`;
    }
    html += `</div>`;

    // ─── Wallet Holdings ────────────────────
    if (regularBals.length) {
      html += `<h3 style="font-size:14px;margin-bottom:8px;color:var(--text-dim)">Wallet Holdings</h3>`;
      html += `<table><thead><tr><th>Token</th><th>Amount</th><th>USD Value</th><th class="u-c-dim">Total Supply</th></tr></thead><tbody>`;
      for (const b of regularBals.slice(0, 15)) {
        const meta = coinMetaCache[b.coinType];
        const supplyRaw = meta?.supply != null ? Number(meta.supply) : null;
        const supplyFmt = supplyRaw != null ? fmtCompact(supplyRaw / Math.pow(10, meta?.decimals || 9)) : '<span class="trunc-note">inc_data</span>';
        html += `<tr><td class="u-mono-12">${b.symbol}</td><td class="u-mono-12">${b.amount >= 1000 ? fmtCompact(b.amount) : b.amount >= 1 ? b.amount.toFixed(1) : b.amount >= 0.01 ? b.amount.toLocaleString(undefined, {maximumFractionDigits:4}) : b.amount.toFixed(8)}</td><td style="font-family:var(--mono);font-size:12px;color:var(--green)">${b.usdValue > 0 ? fmtUsdFromFloat(b.usdValue) : '<span class="trunc-note">inc_data</span>'}</td><td class="u-mono-11-dim">${supplyFmt}</td></tr>`;
      }
      if (regularBals.length > 15) html += `<tr><td colspan="3" style="color:var(--text-dim);font-size:12px">... and ${regularBals.length - 15} more tokens</td></tr>`;
      html += `</tbody></table>`;
    }

    // ─── Liquid Staking Tokens ──────────────
    if (lstBals.length) {
      html += `<h3 class="u-section-h3">Liquid Staking</h3>`;
      html += `<table><thead><tr><th>Token</th><th>Protocol</th><th>Amount</th><th>SUI Equivalent</th><th>USD Value</th></tr></thead><tbody>`;
      for (const b of lstBals) {
        const lstInfo = LST_TYPES[b.coinType] || {};
        const rate = lstExchangeRates[b.symbol] || 1;
        const rateLabel = rate > 1 ? ` (1=${rate.toFixed(4)} SUI)` : "";
        html += `<tr>
          <td class="u-mono-12">${b.symbol}</td>
          <td class="u-fs12-dim">${lstInfo.protocol || "—"}</td>
          <td class="u-mono-12">${b.amount >= 1000 ? fmtCompact(b.amount) : b.amount >= 1 ? b.amount.toFixed(1) : b.amount >= 0.01 ? b.amount.toLocaleString(undefined, {maximumFractionDigits:4}) : b.amount.toFixed(8)}</td>
          <td style="font-family:var(--mono);font-size:12px;color:var(--text-dim)">${b.suiEquiv > 0 ? (b.suiEquiv >= 1000 ? fmtCompact(b.suiEquiv) : b.suiEquiv >= 1 ? b.suiEquiv.toFixed(1) : b.suiEquiv.toLocaleString(undefined, {maximumFractionDigits:4})) + " SUI" : '<span class="trunc-note">inc_data</span>'}<span class="u-fs10-dim">${rateLabel}</span></td>
          <td style="font-family:var(--mono);font-size:12px;color:var(--accent)">${b.usdValue > 0 ? fmtUsdFromFloat(b.usdValue) : '<span class="trunc-note">inc_data</span>'}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    // ─── Lending Positions ──────────────────
    if (allLending.length) {
      html += `<h3 class="u-section-h3">Lending</h3>`;
      for (const pos of allLending) {
        const healthColor = pos.healthFactor > 2 ? "var(--green)" : pos.healthFactor > 1.2 ? "var(--yellow)" : "var(--red)";
        const healthLabel = pos.healthFactor === Infinity ? "No Debt" : pos.healthFactor > 2 ? "Healthy" : pos.healthFactor > 1.2 ? "Caution" : "At Risk";
        const healthDisplay = pos.healthFactor === Infinity ? "---" : pos.healthFactor.toFixed(3);
        html += `<div class="u-bg-panel-12">`;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="u-fw-600">${pos.protocol}</span><span class="badge" style="color:${healthColor};background:${healthColor}20">${healthLabel} ${healthDisplay}</span></div>`;
        if (pos.deposits?.length) {
          html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Supply</div>`;
          for (const d of pos.deposits) {
            const liveUsd = d.amountUsd > 0 ? d.amountUsd : (d.amount > 0 && defiPrices[d.symbol] > 0 ? d.amount * defiPrices[d.symbol] : 0);
            const fmtAmt = d.amount > 0 ? (d.amount >= 1000 ? fmtCompact(d.amount) : d.amount >= 1 ? d.amount.toFixed(1) : d.amount >= 0.01 ? d.amount.toLocaleString(undefined, {maximumFractionDigits:4}) : d.amount.toFixed(8)) : "";
            const amtCell = fmtAmt ? fmtAmt + " " + d.symbol : '<span class="trunc-note">inc_data</span>';
            const usdCell = liveUsd > 0 ? fmtUsdFromFloat(liveUsd) : '<span class="trunc-note">inc_data</span>';
            html += `<div style="display:grid;grid-template-columns:90px 1fr auto;gap:6px;font-size:13px;padding:2px 0;align-items:baseline"><span class="u-fw-600">${d.symbol}</span><span style="font-family:var(--mono);font-size:12px;color:var(--text-dim)">${amtCell}</span><span class="u-c-green" style="font-family:var(--mono);font-size:12px;text-align:right">${usdCell}</span></div>`;
          }
        }
        if (pos.borrows?.length) {
          html += `<div style="font-size:12px;color:var(--text-dim);margin:6px 0 4px">Borrow</div>`;
          for (const b of pos.borrows) {
            const liveUsd = b.amountUsd > 0 ? b.amountUsd : (b.amount > 0 && defiPrices[b.symbol] > 0 ? b.amount * defiPrices[b.symbol] : 0);
            const fmtAmt = b.amount > 0 ? (b.amount >= 1000 ? fmtCompact(b.amount) : b.amount >= 1 ? b.amount.toFixed(1) : b.amount >= 0.01 ? b.amount.toLocaleString(undefined, {maximumFractionDigits:4}) : b.amount.toFixed(8)) : "";
            const amtCell = fmtAmt ? fmtAmt + " " + b.symbol : '<span class="trunc-note">inc_data</span>';
            const usdCell = liveUsd > 0 ? fmtUsdFromFloat(liveUsd) : '<span class="trunc-note">inc_data</span>';
            html += `<div style="display:grid;grid-template-columns:90px 1fr auto;gap:6px;font-size:13px;padding:2px 0;align-items:baseline"><span class="u-fw-600">${b.symbol}</span><span style="font-family:var(--mono);font-size:12px;color:var(--text-dim)">${amtCell}</span><span class="u-c-red" style="font-family:var(--mono);font-size:12px;text-align:right">${usdCell}</span></div>`;
          }
        }
        html += `<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:6px;display:flex;justify-content:space-between;font-size:13px;font-weight:600"><span>Net Equity</span><span style="color:${pos.netUsd >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtUsdFromFloat(Math.abs(pos.netUsd))}</span></div>`;
        html += `</div>`;
      }
    }

    // ─── DEX LP Positions ───────────────────
    if (allDexLp.length) {
      html += `<h3 class="u-section-h3">DEX Liquidity</h3>`;
      for (const pos of allDexLp) {
        html += `<div class="u-bg-panel-12">`;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span class="u-fw-600">${pos.pair}</span><div style="display:flex;gap:6px;align-items:center"><span class="badge" style="background:var(--accent)20;color:var(--accent)">${pos.protocol}</span><span class="badge ${pos.inRange ? 'badge-success' : 'badge-fail'}">${pos.inRange ? "In Range" : "Out of Range"}</span></div></div>`;
        html += `<div style="display:flex;gap:20px;font-size:13px"><span>${pos.amountA >= 1000 ? fmtCompact(pos.amountA) : pos.amountA >= 1 ? pos.amountA.toFixed(1) : pos.amountA.toFixed(4)} ${pos.symbolA} <span class="u-c-dim">${pos.usdA > 0 ? fmtUsdFromFloat(pos.usdA) : '<span class="trunc-note">inc_data</span>'}</span></span><span>${pos.amountB >= 1000 ? fmtCompact(pos.amountB) : pos.amountB >= 1 ? pos.amountB.toFixed(1) : pos.amountB.toFixed(4)} ${pos.symbolB} <span class="u-c-dim">${pos.usdB > 0 ? fmtUsdFromFloat(pos.usdB) : '<span class="trunc-note">inc_data</span>'}</span></span></div>`;
        html += `<div style="font-size:12px;margin-top:4px;color:var(--text-dim)">Total: <span style="color:var(--text);font-weight:600">${fmtUsdFromFloat(pos.totalUsd)}</span> ${hashLink(pos.posId, '/object/' + pos.posId)}</div>`;
        html += `</div>`;
      }
    }

    // ─── DeepBook Margin ────────────────────
    if (db.positions.length) {
      html += `<h3 class="u-section-h3">DeepBook Margin</h3>`;
      for (const pos of db.positions) {
        const mgr = pos.mgr;
        const typeRepr = mgr.type_repr;
        const inner = (typeRepr.match(/<(.+)>/) || [])[1] || "";
        const pairParts = inner.split(",").map(s => s.trim().split("::").pop());
        const pair = pairParts.length === 2 ? pairParts[0] + "/" + pairParts[1] : inner;
        const baseBorrowed = Number(mgr.borrowed_base_shares);
        const quoteBorrowed = Number(mgr.borrowed_quote_shares);
        const riskConfig = db.riskConfigs[mgr.deepbook_pool];
        let baseDebt = 0, quoteDebt = 0;
        if (riskConfig) {
          const basePoolId = riskConfig.base_margin_pool_id;
          const quotePoolId = riskConfig.quote_margin_pool_id;
          if (baseBorrowed > 0 && basePoolId && db.pools[basePoolId]) {
            const ps = db.pools[basePoolId].state;
            baseDebt = baseBorrowed * (Number(ps.borrow_shares) > 0 ? Number(ps.total_borrow) / Number(ps.borrow_shares) : 1);
          }
          if (quoteBorrowed > 0 && quotePoolId && db.pools[quotePoolId]) {
            const ps = db.pools[quotePoolId].state;
            quoteDebt = quoteBorrowed * (Number(ps.borrow_shares) > 0 ? Number(ps.total_borrow) / Number(ps.borrow_shares) : 1);
          }
        }
        let totalCollUsd = 0;
        html += `<div class="u-bg-panel-12">`;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span class="u-fw-600">${pair}</span><span class="u-fs12-dim">${hashLink(mgr.id, '/object/' + mgr.id)}</span></div>`;
        html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Collateral</div>`;
        for (const c of pos.collateral) {
          const dec = c.decimals || getDecimals(c.symbol);
          const human = c.amount / Math.pow(10, dec);
          const usd = human * (defiPrices[c.symbol] || 0);
          totalCollUsd += usd;
          html += `<div class="u-row-between-sm"><span>${c.symbol}</span><span class="u-c-green">${human.toLocaleString(undefined, {maximumFractionDigits:4})} ${usd > 0 ? fmtUsdFromFloat(usd) : '<span class="trunc-note">inc_data</span>'}</span></div>`;
        }
        let totalDebtUsd = 0;
        if (baseBorrowed > 0 || quoteBorrowed > 0) {
          html += `<div style="font-size:12px;color:var(--text-dim);margin:6px 0 4px">Debt</div>`;
          if (baseBorrowed > 0) {
            const sym = pairParts[0] || "BASE";
            const dec = getDecimals(sym);
            const human = baseDebt / Math.pow(10, dec);
            const usd = human * (defiPrices[sym] || 0);
            totalDebtUsd += usd;
            html += `<div class="u-row-between-sm"><span>${sym}</span><span class="u-c-red">${human.toLocaleString(undefined, {maximumFractionDigits:4})} ${usd > 0 ? fmtUsdFromFloat(usd) : '<span class="trunc-note">inc_data</span>'}</span></div>`;
          }
          if (quoteBorrowed > 0) {
            const sym = pairParts[1] || "QUOTE";
            const dec = getDecimals(sym);
            const human = quoteDebt / Math.pow(10, dec);
            const usd = human * (defiPrices[sym] || 0);
            totalDebtUsd += usd;
            html += `<div class="u-row-between-sm"><span>${sym}</span><span class="u-c-red">${human.toLocaleString(undefined, {maximumFractionDigits:4})} ${usd > 0 ? fmtUsdFromFloat(usd) : '<span class="trunc-note">inc_data</span>'}</span></div>`;
          }
        }
        const netUsd = totalCollUsd - totalDebtUsd;
        if (riskConfig && totalDebtUsd > 0) {
          const liqRatio = Number(riskConfig.risk_ratios.liquidation_risk_ratio) / SCALE;
          const healthRatio = totalCollUsd / (totalDebtUsd * liqRatio);
          const healthColor = healthRatio > 2 ? "var(--green)" : healthRatio > 1.2 ? "var(--yellow)" : "var(--red)";
          const healthLabel = healthRatio > 2 ? "Healthy" : healthRatio > 1.2 ? "Caution" : healthRatio > 1 ? "At Risk" : "Liquidatable";
          html += `<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:6px;display:flex;justify-content:space-between;font-size:13px"><span class="u-c-dim">Health</span><span style="color:${healthColor}">${healthRatio.toFixed(3)} (${healthLabel})</span></div>`;
        }
        html += `<div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600;margin-top:4px"><span>Net Equity</span><span style="color:${netUsd >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtUsdFromFloat(Math.abs(netUsd))}</span></div>`;
        const tpslCount = (mgr.tpsl?.trigger_below?.length || 0) + (mgr.tpsl?.trigger_above?.length || 0);
        if (tpslCount > 0) html += `<div style="font-size:12px;color:var(--text-dim);margin-top:4px">${tpslCount} TP/SL orders active</div>`;
        html += `</div>`;
      }
    }

    // ─── Bluefin Perps ─────────────────────
    if (bluefinProData.positions.length) {
      html += `<h3 class="u-section-h3">Bluefin Perpetuals</h3>`;
      html += `<div class="u-bg-panel-12">`;
      if (bluefinProData.collateral > 0) {
        html += `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:13px;margin-bottom:8px"><span class="u-c-dim">USDC Collateral</span><span class="u-c-green">${fmtUsdFromFloat(bluefinProData.collateral)}</span></div>`;
      }
      html += `<table><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry Price</th><th class="u-ta-right">Notional</th><th class="u-ta-right">Mode</th></tr></thead><tbody>`;
      for (const p of bluefinProData.positions) {
        const sideColor = p.isLong ? "var(--green)" : "var(--red)";
        const sideLabel = p.isLong ? "LONG" : "SHORT";
        html += `<tr>
          <td style="font-weight:500">${p.symbol}</td>
          <td><span class="badge" style="background:${sideColor};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px">${sideLabel}</span></td>
          <td class="u-mono">${p.size.toLocaleString(undefined, {maximumFractionDigits:4})}</td>
          <td class="u-mono">$${p.entryPrice.toLocaleString(undefined, {maximumFractionDigits:2})}</td>
          <td class="u-ta-right-mono">${fmtUsdFromFloat(p.notional)}</td>
          <td style="text-align:right;font-size:11px;color:var(--text-dim)">${p.isCross ? "Cross" : p.leverage > 0 ? p.leverage.toFixed(0) + "x Isolated" : "Isolated"}</td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
    }

    // ─── Aftermath Perps ─────────────────────
    if (afPerpsData.accounts.length || afPerpsData.positions.length || afPerpsData.orders.length || afPerpsData.collateral > 0 || afPerpsData.warnings?.length) {
      html += `<h3 class="u-section-h3">Aftermath Perpetuals</h3>`;
      html += `<div class="u-bg-panel-12">`;
      if (afPerpsData.collateral > 0) {
        html += `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:13px;margin-bottom:8px"><span class="u-c-dim">USDC Collateral</span><span class="u-c-green">${fmtUsdFromFloat(afPerpsData.collateral)}</span></div>`;
      }
      if (afPerpsData.accounts.length) {
        html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">Perps Accounts</div>`;
        html += `<table><thead><tr><th>Account ID</th><th>Role</th><th>Caps (owned)</th><th class="u-ta-right">Account Object</th></tr></thead><tbody>`;
        for (const aRow of afPerpsData.accounts) {
          const roleBadgeColor = aRow.role === "admin"
            ? "var(--accent)"
            : (aRow.role === "assistant" ? "var(--blue)" : "var(--text-dim)");
          const roleText = afRoleLabel(aRow.role);
          const capLinks = (aRow.capObjectIds || []).length
            ? (aRow.capObjectIds || []).map((id) => hashLink(id, "/object/" + id)).join(" ")
            : `<span class="u-c-dim">—</span>`;
          const accountObject = aRow.accountObjectId
            ? hashLink(aRow.accountObjectId, "/object/" + aRow.accountObjectId)
            : '<span class="u-c-dim">—</span>';
          html += `<tr>
            <td class="u-mono">${escapeHtml(String(aRow.accountId || "—"))}</td>
            <td><span class="badge" style="background:${roleBadgeColor}22;color:${roleBadgeColor}">${escapeHtml(roleText)}</span></td>
            <td>${capLinks}</td>
            <td class="u-ta-right">${accountObject}</td>
          </tr>`;
        }
        html += `</tbody></table>`;
      }
      if (afPerpsData.partial || afPerpsData.warnings?.length) {
        html += `<div style="font-size:12px;color:var(--text-dim);margin:${afPerpsData.accounts.length ? "8px" : "0"} 0 8px 0;padding:6px 8px;background:var(--panel);border:1px dashed var(--border);border-radius:8px">`;
        if (afPerpsData.partial) html += `<div>Open-order coverage is partial; incomplete rows are explicitly tagged.</div>`;
        const warnRows = (afPerpsData.warnings || []).slice(0, 4);
        for (const w of warnRows) html += `<div>${escapeHtml(w)}</div>`;
        if ((afPerpsData.warnings || []).length > warnRows.length) html += `<div>+${(afPerpsData.warnings || []).length - warnRows.length} more note(s)</div>`;
        html += `</div>`;
      }
      if (afPerpsData.positions.length) {
        html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">Open Positions</div>`;
        html += `<table><thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry Price</th><th class="u-ta-right">Notional</th><th class="u-ta-right">Orders</th><th class="u-ta-right">Account</th></tr></thead><tbody>`;
        for (const p of afPerpsData.positions) {
          const sideLabel = p.side === "long" ? "LONG" : p.side === "short" ? "SHORT" : "FLAT";
          const sideColor = p.side === "long" ? "var(--green)" : p.side === "short" ? "var(--red)" : "var(--text-dim)";
          const entryText = Number.isFinite(p.entryPrice) && p.entryPrice > 0
            ? `$${p.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : "—";
          const notionalText = Number.isFinite(p.notional) && p.notional > 0
            ? fmtUsdFromFloat(p.notional)
            : "—";
          html += `<tr>
            <td style="font-weight:500">${escapeHtml(p.market || "Unknown")}</td>
            <td><span class="badge" style="background:${sideColor};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px">${sideLabel}</span></td>
            <td class="u-mono">${Number.isFinite(p.size) ? p.size.toLocaleString(undefined, {maximumFractionDigits:6}) : "—"}</td>
            <td class="u-mono">${entryText}</td>
            <td class="u-ta-right-mono">${notionalText}</td>
            <td style="text-align:right;font-size:11px;color:var(--text-dim)">${p.pendingOrders || "—"}</td>
            <td class="u-ta-right-mono">${escapeHtml(String(p.accountId || "—"))}</td>
          </tr>`;
        }
        html += `</tbody></table>`;
      } else if (afPerpsData.orders.length) {
        html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">No open positions; showing live resting orders.</div>`;
      }
      if (afPerpsData.orders.length) {
        html += `<div style="font-size:12px;color:var(--text-dim);margin:${afPerpsData.positions.length ? "8px" : "0"} 0 6px">Open Orders (Resting/Maker)</div>`;
        html += `<table><thead><tr><th>Market</th><th>Side</th><th>Size</th><th class="u-ta-right">Limit Price</th><th>Type</th><th class="u-ta-right">Reduce Only</th><th class="u-ta-right">Expires</th><th class="u-ta-right">Last Activity</th><th class="u-ta-right">Account</th></tr></thead><tbody>`;
        for (const o of afPerpsData.orders) {
          const sideLabel = o.side === "long" ? "BID" : o.side === "short" ? "ASK" : "FLAT";
          const sideColor = o.side === "long" ? "var(--green)" : o.side === "short" ? "var(--red)" : "var(--text-dim)";
          const sizeText = Number.isFinite(o.size) && o.size > 0
            ? o.size.toLocaleString(undefined, { maximumFractionDigits: 6 })
            : (o.sizeText ? txListFormatTokenAmount(o.sizeText) : "—");
          const expExpired = Number.isFinite(o.expirationMs) && o.expirationMs <= Date.now();
          const expText = Number.isFinite(o.expirationMs)
            ? `${timeTag(o.expirationMs)}${expExpired ? ' <span class="badge badge-fail">expired</span>' : ''}`
            : `<span class="u-c-dim">GTC</span>`;
          const activityText = o.lastEventAction
            ? `${o.lastEventAction === "posted" ? "Posted" : "Canceled"} ${timeTag(o.lastEventTsMs)}`
            : '<span class="u-c-dim">—</span>';
          const kindLabel = `${escapeHtml(o.kind || "Maker Limit")}${o.synthetic ? ' <span class="badge badge-fail">inferred</span>' : ""}`;
          const priceText = Number.isFinite(o.price) && o.price > 0
            ? `$${o.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
            : '<span class="u-c-dim">—</span>';
          html += `<tr>
            <td style="font-weight:500">${escapeHtml(o.market || "Unknown")}</td>
            <td><span class="badge" style="background:${sideColor};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px">${sideLabel}</span></td>
            <td class="u-mono">${sizeText}</td>
            <td class="u-ta-right-mono">${priceText}</td>
            <td>${kindLabel}</td>
            <td style="text-align:right;font-size:11px;color:var(--text-dim)">${o.reduceOnly ? "Yes" : "No"}</td>
            <td style="text-align:right">${expText}</td>
            <td style="text-align:right">${activityText}</td>
            <td class="u-ta-right-mono">${escapeHtml(String(o.accountId || "—"))}</td>
          </tr>`;
        }
        html += `</tbody></table>`;
      }
      html += `</div>`;
    }

    // ─── Errors ─────────────────────────────
    const failed = [];
    const protoResults = { Suilend: suilend, NAVI: navi, Alpha: alpha, Scallop: scallop, Cetus: cetus, Turbos: turbos, DeepBook: deepbook, "Bluefin Spot": bluefinSpot, "Bluefin Pro": bluefinPro, "Aftermath Perps": aftermathPerps };
    for (const [name, r] of Object.entries(protoResults)) { if (r.status === "rejected") failed.push(name); }
    if (failed.length) html += `<div style="margin-top:12px;font-size:12px;color:var(--text-dim)">Could not query: ${failed.join(", ")}</div>`;

    html += `</div>`;
    defiHtml = html;
    defiLoaded = true;
    if (!isActiveRoute()) return;
    renderTabs("defi");
  }

  function renderTabs(active) {
    activeTab = active;
    const tabs = ["defi", "txs", "objects"];
    const labels = { defi: "DeFi Portfolio", txs: "Transactions", objects: "Owned Objects" };
    const counts = { defi: "", txs: allTxs.length + (txPageInfo.hasPreviousPage ? "+" : ""), objects: allObjects.length + (objPageInfo.hasNextPage ? "+" : "") };
    document.getElementById("addr-tabs").innerHTML = tabs.map(t =>
      `<div class="inner-tab ${t === active ? 'active' : ''}"
        data-action="addr-switch-tab" data-tab="${t}">${labels[t]}${counts[t] ? " (" + counts[t] + ")" : ""}</div>`
    ).join("");
    document.getElementById("addr-tab-content").innerHTML = tabContent[active]();
    if (isActiveRoute()) scheduleVisibleObjectShellPrefetch(app);

    // Lazy-load DeFi data when tab is clicked
    if (active === "defi" && !defiLoaded) {
      loadDefi().catch(e => {
        if (!isActiveRoute()) return;
        defiHtml = renderEmpty("Failed to load DeFi data: " + escapeHtml(e.message));
        defiLoaded = true;
        renderTabs("defi");
      });
    }

    // Bind load-more buttons
    if (active === "txs") {
      const presetEl = document.getElementById("addr-tx-date-preset");
      if (presetEl) {
        presetEl.onchange = async () => {
          if (txLoading) return;
          const next = txListNormalizeDateState({
            preset: presetEl.value,
            fromDate: document.getElementById("addr-tx-date-from")?.value || txFilterState.fromDate,
            toDate: document.getElementById("addr-tx-date-to")?.value || txFilterState.toDate,
          });
          if (next.preset !== "custom") {
            next.fromDate = "";
            next.toDate = "";
          } else if (!next.fromDate && !next.toDate) {
            const now = Date.now();
            next.toDate = txListDateInputFromMs(now);
            next.fromDate = txListDateInputFromMs(now - 7 * 24 * 60 * 60 * 1000);
          }
          txFilterState = next;
          txLoading = true;
          renderTabs("txs");
          await loadAddressTransactions(null, false);
          txLoading = false;
          renderTabs("txs");
        };
      }
    }
    if (active === "objects") {
      const btn = document.getElementById("load-more-objs");
      if (btn) btn.onclick = async () => {
        btn.textContent = "Loading..."; btn.disabled = true;
        const more = await gql(`query($addr: SuiAddress!, $after: String) {
          address(address: $addr) { objects(first: 20, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { address version digest ${GQL_F_CONTENTS_TYPE_JSON} }
          } }
        }`, { addr: addrNorm, after: objPageInfo.endCursor });
        allObjects = [...allObjects, ...(more.address.objects.nodes || [])];
        objPageInfo = more.address.objects.pageInfo;
        renderTabs("objects");
      };
    }
  }

  app.innerHTML = `
    <div class="page-title">
      Address <span class="type-tag">ACCOUNT</span>
      ${name ? `<span style="color:var(--green);font-size:14px">${name}</span>` : ""}
      ${copyLinkBtn()}${viewQueryBtn('address_detail', { addr: addrNorm })}
    </div>
    <div class="card u-mb16">
      <div class="card-body">
        <div class="detail-row">
          <div class="detail-key">Address</div>
          <div class="detail-val">${a.address} ${copyBtn(a.address)}</div>
        </div>
        ${name ? `<div class="detail-row">
          <div class="detail-key">SuiNS Name</div>
          <div class="detail-val normal-font">${name}</div>
        </div>` : ""}
      </div>
    </div>
    <div class="card">
      <div id="addr-tabs" class="inner-tabs"></div>
      <div id="addr-tab-content" class="card-body"></div>
    </div>
  `;
  if (app._addressClickHandler) app.removeEventListener("click", app._addressClickHandler);
  app._addressClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (!action) return;
    ev.preventDefault();
    if (action === "addr-switch-tab") {
      renderTabs(trigger.getAttribute("data-tab") || "txs");
      return;
    }
    if (action === "addr-tx-date-apply") {
      if (txLoading) return;
      txFilterState = txListNormalizeDateState({
        preset: "custom",
        fromDate: document.getElementById("addr-tx-date-from")?.value || "",
        toDate: document.getElementById("addr-tx-date-to")?.value || "",
      });
      txLoading = true;
      renderTabs("txs");
      await loadAddressTransactions(null, false);
      txLoading = false;
      renderTabs("txs");
      return;
    }
    if (action === "addr-load-more-txs") {
      if (txLoading || !txPageInfo.hasPreviousPage || !txPageInfo.startCursor) return;
      txLoading = true;
      renderTabs("txs");
      await loadAddressTransactions(txPageInfo.startCursor, true);
      txLoading = false;
      renderTabs("txs");
      return;
    }
    if (action === "addr-tx-export-csv") {
      if (trigger.hasAttribute("disabled")) return;
      const txRows = txListBuildRows(allTxs);
      if (!txRows.length) return;
      const stamp = new Date().toISOString().slice(0, 10);
      const idPart = addrNorm.slice(2, 10) || "address";
      txListDownloadCsv(`suigraph-address-${idPart}-${stamp}.csv`, txListBuildCsv(txRows));
      return;
    }
  };
  app.addEventListener("click", app._addressClickHandler);
  renderTabs("txs");
  setTimeout(() => {
    if (!isActiveRoute()) return;
    ensureInitialAddressTransactions().catch(() => {});
  }, 0);
}

// ── Object Detail ───────────────────────────────────────────────────────
async function renderDeletedObjectDetail(app, id) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const targetId = normalizeSuiAddress(id);
  const baseData = await gql(`query($id: SuiAddress!) {
    objectVersions(address: $id, last: 20) {
      pageInfo { hasPreviousPage startCursor }
      nodes {
        address
        version
        digest
        storageRebate
        owner {
          ${GQL_F_OWNER}
        }
        previousTransaction { digest }
        asMoveObject {
          hasPublicTransfer
          ${GQL_F_CONTENTS_TYPE_JSON}
        }
      }
    }
  }`, { id: targetId });

  const baseConn = baseData?.objectVersions;
  let historyRows = (baseConn?.nodes || []).slice().sort((a, b) => Number(a?.version || 0) - Number(b?.version || 0));
  if (!historyRows.length) {
    app.innerHTML = renderEmpty("Object not found.");
    return;
  }

  let historyHasPrev = !!baseConn?.pageInfo?.hasPreviousPage;
  let historyCursor = baseConn?.pageInfo?.startCursor || null;
  let historyLoading = false;
  let historyErr = "";
  let summaryHydrated = false;
  let boundaryHydrated = false;
  let initialHydrationStarted = false;
  const txMetaByDigest = {};
  const summaryState = {
    deletedEvent: null,
    createdEvent: null,
    completeStart: !historyHasPrev,
  };
  const boundaryState = {
    createdEvent: null,
    deletedEvent: null,
  };

  function ownerSummary(owner) {
    if (!owner) return '<span class="u-c-dim">—</span>';
    const ownerAddr = owner?.address?.address;
    if (ownerAddr) return fullHashLink(ownerAddr, '/address/' + ownerAddr);
    if (owner?.initialSharedVersion != null) return `Shared (v${owner.initialSharedVersion})`;
    if (owner?.__typename === "Immutable") return "Immutable";
    return '<span class="u-c-dim">—</span>';
  }

  function classifyLifecycleForTarget(effects) {
    const changes = effects?.objectChanges?.nodes || [];
    let targetChange = null;
    for (const c of changes) {
      const addr = normalizeSuiAddress(c?.address || c?.idCreated || c?.idDeleted || "");
      if (addr && addr === targetId) {
        targetChange = c;
        break;
      }
    }
    if (!targetChange) return "";
    if (targetChange?.idDeleted || (targetChange?.inputState?.version != null && targetChange?.outputState?.version == null)) return "Deleted";
    if (targetChange?.idCreated || (targetChange?.inputState?.version == null && targetChange?.outputState?.version != null)) return "Created";
    return "Mutated";
  }

  async function hydrateTxMeta(rows) {
    const uniqueDigests = [...new Set(rows.map(r => r?.previousTransaction?.digest).filter(Boolean))];
    const missing = uniqueDigests.filter(d => !txMetaByDigest[d]);
    if (!missing.length) return;

    for (const chunk of chunkArray(missing, 8)) {
      try {
        const effectsList = await multiGetTransactionEffectsWithObjectChanges(chunk, 120);
        const effectsByDigest = {};
        for (const fx of effectsList) {
          if (fx?.digest) effectsByDigest[fx.digest] = fx;
        }
        chunk.forEach((digest) => {
          const eff = effectsByDigest[digest] || null;
          txMetaByDigest[digest] = {
            status: eff?.status || "",
            timestamp: eff?.timestamp || "",
            checkpoint: Number(eff?.checkpoint?.sequenceNumber),
            lifecycle: classifyLifecycleForTarget(eff),
          };
        });
      } catch (e) {
        chunk.forEach((digest) => {
          txMetaByDigest[digest] = txMetaByDigest[digest] || { status: "", timestamp: "", checkpoint: NaN, lifecycle: "" };
        });
      }
    }
  }

  function recomputeSummary() {
    const orderedByVersionDesc = historyRows.slice().sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0));
    summaryState.deletedEvent = null;
    for (const row of orderedByVersionDesc) {
      const digest = row?.previousTransaction?.digest || "";
      const meta = digest ? txMetaByDigest[digest] : null;
      if (meta?.lifecycle === "Deleted") {
        summaryState.deletedEvent = { digest, ...meta };
        break;
      }
    }
    summaryState.createdEvent = null;
    if (!historyHasPrev && historyRows.length) {
      const first = historyRows[0];
      const digest = first?.previousTransaction?.digest || "";
      const meta = digest ? txMetaByDigest[digest] : null;
      if (meta?.lifecycle === "Created") summaryState.createdEvent = { digest, ...meta };
    }
    summaryState.completeStart = !historyHasPrev;
  }

  async function loadBoundaryLifecycle() {
    try {
      const bData = await gql(`query($id: SuiAddress!) {
        firstTx: transactions(first: 1, filter: { affectedObject: $id }) {
          nodes {
            digest
            effects {
              status
              timestamp
              checkpoint { sequenceNumber }
              objectChanges(first: 120) {
                nodes {
                  address
                  idCreated
                  idDeleted
                  inputState { version }
                  outputState { version }
                }
              }
            }
          }
        }
        lastTx: transactions(last: 1, filter: { affectedObject: $id }) {
          nodes {
            digest
            effects {
              status
              timestamp
              checkpoint { sequenceNumber }
              objectChanges(first: 120) {
                nodes {
                  address
                  idCreated
                  idDeleted
                  inputState { version }
                  outputState { version }
                }
              }
            }
          }
        }
      }`, { id: targetId });
      const firstTx = bData?.firstTx?.nodes?.[0] || null;
      const lastTx = bData?.lastTx?.nodes?.[0] || null;
      const firstLife = classifyLifecycleForTarget(firstTx);
      const lastLife = classifyLifecycleForTarget(lastTx);
      boundaryState.createdEvent = (firstTx && firstLife === "Created")
        ? {
          digest: firstTx.digest,
          status: firstTx?.effects?.status || "",
          timestamp: firstTx?.effects?.timestamp || "",
          checkpoint: Number(firstTx?.effects?.checkpoint?.sequenceNumber),
        }
        : null;
      boundaryState.deletedEvent = (lastTx && lastLife === "Deleted")
        ? {
          digest: lastTx.digest,
          status: lastTx?.effects?.status || "",
          timestamp: lastTx?.effects?.timestamp || "",
          checkpoint: Number(lastTx?.effects?.checkpoint?.sequenceNumber),
        }
        : null;
    } catch (e) {
      boundaryState.createdEvent = boundaryState.createdEvent || null;
      boundaryState.deletedEvent = boundaryState.deletedEvent || null;
    }
  }

  function lifecycleBadge(label) {
    if (label === "Created") return '<span class="badge badge-success">Created</span>';
    if (label === "Deleted") return '<span class="badge badge-fail">Deleted</span>';
    if (label === "Mutated") return '<span class="badge">Mutated</span>';
    return '<span class="badge">State</span>';
  }

  function rowLifecycle(row) {
    const digest = row?.previousTransaction?.digest || "";
    const meta = digest ? txMetaByDigest[digest] : null;
    if (meta?.lifecycle) return meta.lifecycle;
    if (!historyHasPrev && historyRows.length && Number(row?.version) === Number(historyRows[0]?.version)) return "Created";
    return "Mutated";
  }

  function renderHistoryTable() {
    if (historyLoading && !historyRows.length) return '<div class="loading u-p24">Loading version history...</div>';
    if (historyErr) return renderEmpty(escapeHtml(historyErr));
    if (!historyRows.length) return renderEmpty("No version history available.");

    let html = `<table>
      <thead><tr><th>Version</th><th>Change</th><th>Digest</th><th>Transaction</th><th>Checkpoint</th><th>Time</th><th>Type</th></tr></thead>
      <tbody>`;
    for (const v of historyRows) {
      const digest = v?.previousTransaction?.digest || "";
      const meta = digest ? txMetaByDigest[digest] : null;
      const lifecycle = rowLifecycle(v);
      html += `<tr>
        <td class="u-mono-12">${fmtNumber(v?.version)}</td>
        <td>${lifecycleBadge(lifecycle)}</td>
        <td class="u-mono-11-dim">${v?.digest ? truncHash(v.digest) : "—"}</td>
        <td>${digest ? hashLink(digest, '/tx/' + digest) : "—"}</td>
        <td class="u-mono-12">${Number.isFinite(meta?.checkpoint) ? fmtNumber(meta.checkpoint) : "—"}</td>
        <td>${meta?.timestamp ? timeTag(meta.timestamp) : '<span class="u-c-dim">—</span>'}</td>
        <td class="u-mono-11-dim">${escapeHtml(shortType(v?.asMoveObject?.contents?.type?.repr || "")) || "—"}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
    if (historyHasPrev || historyLoading) {
      html += `<div style="padding:10px 0;display:flex;align-items:center;gap:10px">
        ${historyHasPrev ? `<button data-action="deleted-load-history" class="btn-surface-sm">Load Older Versions</button>` : ""}
        ${historyLoading ? `<span class="u-fs12-dim">Loading...</span>` : ""}
        ${historyHasPrev ? `<span class="trunc-note">Partial</span>` : ""}
      </div>`;
    }
    return html;
  }

  async function loadHistoryPage(before = null) {
    if (historyLoading) return;
    historyLoading = true;
    historyErr = "";
    const activeEl = document.getElementById("obj-tab-content");
    if (activeEl && document.querySelector(".inner-tab.active")?.textContent?.includes("History")) {
      activeEl.innerHTML = renderHistoryTable();
    }
    try {
      const hData = await gql(`query($id: SuiAddress!, $before: String) {
        objectVersions(address: $id, last: 20, before: $before) {
          pageInfo { hasPreviousPage startCursor }
          nodes {
            address
            version
            digest
            storageRebate
            owner {
              ${GQL_F_OWNER}
            }
            previousTransaction { digest }
            asMoveObject { hasPublicTransfer ${GQL_F_CONTENTS_TYPE_JSON} }
          }
        }
      }`, { id: targetId, before });
      const conn = hData?.objectVersions;
      const batch = conn?.nodes || [];
      await hydrateTxMeta(batch);
      const byKey = new Map(historyRows.map(v => [`${v.version}:${v.digest || ""}`, v]));
      for (const v of batch) byKey.set(`${v.version}:${v.digest || ""}`, v);
      historyRows = [...byKey.values()].sort((a, b) => Number(a?.version || 0) - Number(b?.version || 0));
      historyHasPrev = !!conn?.pageInfo?.hasPreviousPage;
      historyCursor = conn?.pageInfo?.startCursor || null;
      recomputeSummary();
    } catch (e) {
      historyErr = e?.message || "Failed to load version history.";
    } finally {
      historyLoading = false;
      if (activeEl && document.querySelector(".inner-tab.active")?.textContent?.includes("History")) {
        activeEl.innerHTML = renderHistoryTable();
      }
      const summaryCardEl = document.getElementById("deleted-obj-card");
      if (summaryCardEl) summaryCardEl.innerHTML = renderOverviewBody();
      const summaryTabEl = document.getElementById("deleted-obj-summary");
      if (summaryTabEl) summaryTabEl.innerHTML = renderOverviewBody();
    }
  }

  const latestRow = () => historyRows[historyRows.length - 1] || null;

  function renderOverviewBody() {
    const latest = latestRow();
    const latestType = latest?.asMoveObject?.contents?.type?.repr || "";
    const latestOwner = latest?.owner;
    const deleted = boundaryState.deletedEvent || summaryState.deletedEvent;
    const created = boundaryState.createdEvent || summaryState.createdEvent;
    const totalVersions = historyRows.length;
    const createdLoading = !created && (!summaryHydrated || !boundaryHydrated);
    const deletedLoading = !deleted && (!summaryHydrated || !boundaryHydrated);
    return `
      <div class="detail-row">
        <div class="detail-key">Object ID</div>
        <div class="detail-val">${targetId} ${copyBtn(targetId)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-key">Live State</div>
        <div class="detail-val"><span class="badge badge-fail">Deleted</span> <span class="normal-font u-c-dim">object unavailable at latest checkpoint</span></div>
      </div>
      <div class="detail-row">
        <div class="detail-key">Last Known Version</div>
        <div class="detail-val normal-font">${latest ? fmtNumber(latest.version) : "—"}</div>
      </div>
      ${latestType ? `<div class="detail-row">
        <div class="detail-key">Last Known Type</div>
        <div class="detail-val u-mono-12">${escapeHtml(latestType)}</div>
      </div>` : ""}
      <div class="detail-row">
        <div class="detail-key">Last Known Owner</div>
        <div class="detail-val">${ownerSummary(latestOwner)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-key">History Loaded</div>
        <div class="detail-val normal-font">${fmtNumber(totalVersions)} version${totalVersions === 1 ? "" : "s"}${historyHasPrev ? ` <span class="trunc-note">Partial</span>` : ""}</div>
      </div>
      <div class="detail-row">
        <div class="detail-key">Created In Tx</div>
        <div class="detail-val">${created?.digest
          ? `${fullHashLink(created.digest, '/tx/' + created.digest)}${Number.isFinite(created.checkpoint) ? ` · checkpoint ${fmtNumber(created.checkpoint)}` : ""}`
          : (createdLoading
            ? '<span class="u-c-dim">Loading...</span>'
            : (summaryState.completeStart ? '<span class="u-c-dim">Not detected</span>' : '<span class="u-c-dim">Load older versions to resolve</span>'))}</div>
      </div>
      <div class="detail-row">
        <div class="detail-key">Deleted In Tx</div>
        <div class="detail-val">${deleted?.digest
          ? `${fullHashLink(deleted.digest, '/tx/' + deleted.digest)}${Number.isFinite(deleted.checkpoint) ? ` · checkpoint ${fmtNumber(deleted.checkpoint)}` : ""}`
          : (deletedLoading ? '<span class="u-c-dim">Loading...</span>' : '<span class="u-c-dim">Not detected in loaded window</span>')}</div>
      </div>
    `;
  }

  const tabContent = {
    overview: () => `<div id="deleted-obj-summary">${renderOverviewBody()}</div>`,
    snapshot: () => {
      const latest = latestRow();
      const latestJson = latest?.asMoveObject?.contents?.json;
      if (!latestJson) return renderEmpty("No last-snapshot JSON available.");
      return jsonTreeBlock(latestJson, 500);
    },
    history: () => renderHistoryTable(),
    dynamic: () => renderEmpty("Dynamic fields are not available from the deleted live object. Use checkpoint queries for point-in-time dynamic fields."),
  };

  function renderTabs(active) {
    const tabs = ["overview", "snapshot", "history", "dynamic"];
    const labels = { overview: "Overview", snapshot: "Last Snapshot", history: "History", dynamic: "Dynamic Fields" };
    document.getElementById("obj-tabs").innerHTML = tabs.map(t =>
      `<div class="inner-tab ${t === active ? 'active' : ''}" data-action="deleted-switch-tab" data-tab="${t}">${labels[t]}</div>`
    ).join("");
    document.getElementById("obj-tab-content").innerHTML = tabContent[active]();
  }

  app.innerHTML = `
    <div class="page-title">
      Object <span class="type-tag">OBJ</span> <span class="type-tag" style="background:rgba(248,81,73,0.15);border-color:rgba(248,81,73,0.35);color:var(--red)">DELETED</span>
      ${copyLinkBtn()}${viewQueryBtn('object_detail', { id: targetId })}
    </div>
    <div class="card u-mb16">
      <div class="card-body" id="deleted-obj-card">${renderOverviewBody()}</div>
    </div>
    <div class="card">
      <div id="obj-tabs" class="inner-tabs"></div>
      <div id="obj-tab-content" class="card-body"></div>
    </div>
  `;

  if (app._deletedObjectClickHandler) app.removeEventListener("click", app._deletedObjectClickHandler);
  app._deletedObjectClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (action === "deleted-switch-tab") {
      ev.preventDefault();
      renderTabs(trigger.getAttribute("data-tab") || "overview");
      return;
    }
    if (action === "deleted-load-history") {
      ev.preventDefault();
      if (!historyHasPrev || !historyCursor) return;
      await loadHistoryPage(historyCursor);
    }
  };
  app.addEventListener("click", app._deletedObjectClickHandler);

  function refreshDeletedObjectView(activeTab = null) {
    const summaryCardEl = document.getElementById("deleted-obj-card");
    if (summaryCardEl) summaryCardEl.innerHTML = renderOverviewBody();
    const summaryTabEl = document.getElementById("deleted-obj-summary");
    if (summaryTabEl) summaryTabEl.innerHTML = renderOverviewBody();
    const activeLabel = activeTab || document.querySelector(".inner-tab.active")?.textContent || "";
    const activeContentEl = document.getElementById("obj-tab-content");
    if (!activeContentEl) return;
    if (activeLabel.includes("History")) activeContentEl.innerHTML = renderHistoryTable();
    else if (activeLabel.includes("Overview")) activeContentEl.innerHTML = tabContent.overview();
  }

  function ensureInitialDeletedObjectHydration() {
    if (initialHydrationStarted) return;
    initialHydrationStarted = true;
    setTimeout(() => {
      Promise.allSettled([
        (async () => {
          await hydrateTxMeta(historyRows);
          summaryHydrated = true;
          recomputeSummary();
        })(),
        (async () => {
          await loadBoundaryLifecycle();
          boundaryHydrated = true;
        })(),
      ]).finally(() => {
        if (isActiveRoute()) refreshDeletedObjectView();
      });
    }, 0);
  }

  renderTabs("overview");
  ensureInitialDeletedObjectHydration();
}

async function renderObjectDetail(app, id) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const rawId = decodeURIComponent(String(id || ""));
  const idNorm = normalizeSuiAddress(rawId);
  if (!idNorm) {
    const asCoinType = normalizeCoinTypeQueryInput(rawId);
    if (asCoinType) {
      navigate("/coin?type=" + encodeURIComponent(asCoinType));
      return;
    }
    app.innerHTML = renderEmpty(`Invalid object ID: ${escapeHtml(rawId || String(id || ""))}`);
    return;
  }

  const data = await fetchObjectShell(idNorm, false);

  const obj = data.object;
  if (!obj) {
    await renderDeletedObjectDetail(app, idNorm);
    return;
  }

  const isPackage = !!obj.asMovePackage;
  const isObj = !!obj.asMoveObject;
  const contents = obj.asMoveObject?.contents;
  const typeRepr = contents?.type?.repr || "";
  const ownerAddr = obj.owner?.address?.address;
  const isShared = obj.owner?.initialSharedVersion != null;
  const isImmutable = obj.owner?.__typename === "Immutable";

  // Resolve MVR name for packages
  let mvrName = null;
  if (isPackage) {
    await resolvePackageNames([obj.address]);
    mvrName = mvrNameCache[obj.address] || null;
  }

  let ownerDisplay = "—";
  if (ownerAddr) ownerDisplay = fullHashLink(ownerAddr, '/address/' + ownerAddr);
  else if (isShared) ownerDisplay = `Shared (v${obj.owner.initialSharedVersion})`;
  else if (isImmutable) ownerDisplay = "Immutable";

  let dynFields = [];
  let dynFieldsLoaded = false;
  let dynFieldsHasNext = false;
  let dynFieldsCursor = null;
  let dynFieldsLoading = false;
  let modules = isPackage ? (obj.asMovePackage.modules?.nodes || []) : [];
  let modulesLoaded = !isPackage ? true : !obj.asMovePackage?.modules?.pageInfo?.hasNextPage;
  let modulesHasNext = !!obj.asMovePackage?.modules?.pageInfo?.hasNextPage;
  let modulesCursor = obj.asMovePackage?.modules?.pageInfo?.endCursor || null;
  let modulesLoading = false;
  const moduleData = {};
  let selectedModule = modules[0]?.name || "";
  let activeModuleTab = "functions";
  let expandedFunctions = new Set();

  async function loadDynamicFieldsPage(after = null) {
    dynFieldsLoading = true;
    try {
      const more = await gql(`query($id: SuiAddress!, $after: String) {
        object(address: $id) {
          dynamicFields(first: 20, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name { type { repr } json }
              value {
                ... on MoveValue { type { repr } json }
                ... on MoveObject { address ${GQL_F_CONTENTS_TYPE_JSON} }
              }
            }
          }
        }
      }`, { id: idNorm, after });
      const conn = more?.object?.dynamicFields;
      const nextNodes = conn?.nodes || [];
      const seen = new Set(dynFields.map(df => JSON.stringify(df?.name?.json || "")));
      for (const n of nextNodes) {
        const key = JSON.stringify(n?.name?.json || "");
        if (seen.has(key)) continue;
        seen.add(key);
        dynFields.push(n);
      }
      dynFieldsLoaded = true;
      dynFieldsHasNext = !!conn?.pageInfo?.hasNextPage;
      dynFieldsCursor = conn?.pageInfo?.endCursor || null;
    } catch (e) {
      dynFieldsLoaded = true;
      dynFieldsHasNext = false;
    } finally {
      dynFieldsLoading = false;
      const active = document.querySelector(".inner-tab.active")?.textContent || "";
      if (active.includes("Dynamic Fields")) {
        const c = document.getElementById("obj-tab-content");
        if (c) c.innerHTML = tabContent.dynamic();
      }
    }
  }

  async function ensureInitialDynamicFields() {
    if (dynFieldsLoaded || dynFieldsLoading) return;
    await loadDynamicFieldsPage(null);
  }

  async function loadMoreDynamicFields() {
    if (!dynFieldsLoaded) {
      await ensureInitialDynamicFields();
      return;
    }
    if (dynFieldsLoading || !dynFieldsHasNext) return;
    await loadDynamicFieldsPage(dynFieldsCursor);
  }

  async function loadMorePackageModules() {
    if (!isPackage || modulesLoading || !modulesHasNext) return;
    modulesLoading = true;
    try {
      const more = await gql(`query($id: SuiAddress!, $after: String) {
        object(address: $id) {
          asMovePackage {
            modules(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { name }
            }
          }
        }
      }`, { id: idNorm, after: modulesCursor });
      const conn = more?.object?.asMovePackage?.modules;
      const existing = new Set(modules.map(m => m.name));
      for (const m of (conn?.nodes || [])) {
        if (existing.has(m.name)) continue;
        existing.add(m.name);
        modules.push(m);
      }
      modulesLoaded = !conn?.pageInfo?.hasNextPage;
      modulesHasNext = !!conn?.pageInfo?.hasNextPage;
      modulesCursor = conn?.pageInfo?.endCursor || null;
      if (!selectedModule && modules.length) selectedModule = modules[0].name;
    } catch (e) {
      modulesHasNext = false;
    } finally {
      modulesLoading = false;
      const active = document.querySelector(".inner-tab.active")?.textContent || "";
      if (active.includes("Modules")) {
        const sidebar = document.getElementById("pkg-sidebar-list");
        if (sidebar) sidebar.innerHTML = renderSidebar(document.getElementById("pkg-mod-filter")?.value);
      }
    }
  }

  const tabContent = {
    fields: () => {
      if (!contents?.json) return renderEmpty("No field data.");
      const json = contents.json;
      if (typeof json === "object" && json !== null) {
        return Object.entries(json).map(([k, v]) => `
          <div class="obj-field">
            <div class="obj-field-name">${k}</div>
            <div class="obj-field-val">${renderJson(v, {depth: 0, maxDepth: 2})}</div>
          </div>
        `).join("");
      }
      return jsonTreeBlock(json, 400);
    },
    raw: () => contents?.json ? jsonTreeBlock(contents.json, 400) : renderEmpty("No data."),
    dynamic: () => {
      if (!dynFieldsLoaded && !dynFieldsLoading) {
        ensureInitialDynamicFields().catch(() => {});
      }
      if (dynFieldsLoading && !dynFieldsLoaded) return `<div style="padding:12px 0">${renderLoading()}</div>`;
      if (!dynFields.length) return renderEmpty("No dynamic fields.");
      return `<table>
        <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
        <tbody>${dynFields.map(df => {
          const valAddr = df.value?.address;
          const valJson = df.value?.json;
          return `<tr>
            <td class="u-mono-12">${renderJson(df.name?.json, {depth: 0, maxDepth: 1})}</td>
            <td class="u-fs12-dim">${shortType(df.value?.type?.repr || df.name?.type?.repr)}</td>
            <td class="u-mono-12">${valAddr
              ? hashLink(valAddr, '/object/' + valAddr)
              : (valJson ? renderJson(valJson, {depth: 0, maxDepth: 1}) : "—")}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
      ${(dynFieldsHasNext || dynFieldsLoading) ? `<div style="padding:10px 0;display:flex;align-items:center;gap:10px">
        ${dynFieldsHasNext ? `<button data-action="obj-load-dynamic" class="btn-surface-sm">Load More Fields</button>` : ""}
        ${dynFieldsLoading ? `<span class="u-fs12-dim">Loading...</span>` : ""}
        ${dynFieldsHasNext ? `<span class="trunc-note">Partial</span>` : ""}
      </div>` : ""}`;
    },
  };

  // Module viewer helpers (at function scope so renderTabs can access them)
  const highlightDisasm = (text) => {
    return text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/^(\/\/.*)$/gm, '<span class="u-c-dim">$1</span>')
      .replace(/\b(module|struct|enum|has|use|public|friend|native|fun|entry|const|let|mut|if|else|while|loop|return|abort|break|continue|spec|phantom)\b/g, '<span style="color:#ff7b72">$1</span>')
      .replace(/\b(u8|u16|u32|u64|u128|u256|bool|address|signer|vector)\b/g, '<span style="color:#79c0ff">$1</span>')
      .replace(/\b(key|store|drop|copy)\b/g, '<span style="color:#d2a8ff">$1</span>')
      .replace(/\b(true|false)\b/g, '<span style="color:#79c0ff">$1</span>')
      .replace(/(0x[0-9a-fA-F]+)/g, '<span class="u-c-dim">$1</span>');
  };

  const loadModuleData = async (modName) => {
    if (moduleData[modName]) return;
    try {
      const md = await gql(`query($pkg: SuiAddress!, $mod: String!) {
        object(address: $pkg) { asMovePackage { module(name: $mod) {
          fileFormatVersion disassembly
          structs { nodes { name abilities typeParameters { constraints isPhantom } } }
          functions { nodes { name isEntry visibility typeParameters { constraints } parameters { repr } return { repr } } }
          enums { nodes { name abilities typeParameters { constraints isPhantom } variants { name fields { name type { repr } } } } }
        } } }
      }`, { pkg: id, mod: modName });
      const m = md.object?.asMovePackage?.module;
      moduleData[modName] = {
        functions: m?.functions?.nodes || [],
        structs: m?.structs?.nodes || [],
        enums: m?.enums?.nodes || [],
        disassembly: m?.disassembly || "",
        fileFormatVersion: m?.fileFormatVersion ?? null,
      };
    } catch (e) {
      moduleData[modName] = { functions: [], structs: [], enums: [], disassembly: "", fileFormatVersion: null };
    }
  };

  const renderModulePanel = () => {
    const d = moduleData[selectedModule];
    if (!d) return '<div class="loading u-p24">Loading module...</div>';
    const tabs = ["functions", "structs", ...(d.enums?.length ? ["enums"] : []), "disassembly"];
    const labels = { functions: `Functions (${d.functions.length})`, structs: `Structs (${d.structs.length})`, enums: `Enums (${(d.enums||[]).length})`, disassembly: "Bytecode" };
    let html = `<div style="display:flex;gap:0;border-bottom:1px solid var(--border)">`;
    for (const t of tabs) {
      const act = t === activeModuleTab;
      html += `<div style="padding:8px 16px;font-size:12px;cursor:pointer;border-bottom:2px solid ${act ? 'var(--accent)' : 'transparent'};color:${act ? 'var(--text)' : 'var(--text-dim)'};font-weight:${act ? '600' : '400'}" data-action="obj-switch-mod-tab" data-tab="${t}">${labels[t]}</div>`;
    }
    html += `</div>`;
    if (activeModuleTab === "functions") {
      if (!d.functions.length) { html += '<div style="padding:16px;color:var(--text-dim);font-size:13px">No public functions in this module.</div>'; }
      else {
        html += '<div style="overflow-y:auto;max-height:calc(100vh - 400px)">';
        for (const f of d.functions) {
          const vis = f.visibility === "PUBLIC" ? "pub" : f.visibility === "FRIEND" ? "friend" : "priv";
          const visColor = f.visibility === "PUBLIC" ? "var(--green)" : f.visibility === "FRIEND" ? "var(--yellow)" : "var(--text-dim)";
          const tps = (f.typeParameters || []).map((tp, i) => `<span class="u-c-purple">T${i}${tp.constraints?.length ? ': ' + tp.constraints.join(' + ') : ''}</span>`).join(", ");
          const tpStr = tps ? `&lt;${tps}&gt;` : "";
          const params = (f.parameters || []).map(p => shortType(p.repr)).join(", ");
          const ret = (f.return || []).map(r => shortType(r.repr)).join(", ");
          const isExpanded = expandedFunctions.has(f.name);
          const chevron = isExpanded ? "▼" : "▶";
          html += `<div data-action="obj-toggle-fn" data-fn="${escapeAttr(f.name)}" style="padding:6px 16px;font-family:var(--mono);font-size:12px;border-bottom:${isExpanded ? "none" : "1px solid var(--border)"};cursor:pointer;display:flex;align-items:flex-start;gap:8px;user-select:none" title="Click to ${isExpanded ? "collapse" : "expand"} function details">
            <span style="color:var(--text-dim);font-size:10px;margin-top:2px;flex-shrink:0">${chevron}</span>
            <div style="min-width:0;flex:1"><span style="color:${visColor};font-size:11px;display:inline-block;width:45px">${vis}</span>${f.isEntry ? '<span style="color:var(--accent);font-size:11px"> entry</span> ' : ""}<span class="u-fw-600">${escapeHtml(f.name)}</span>${tpStr}(<span class="u-c-dim">${params}</span>)${ret ? ` -&gt; <span class="u-c-purple">${ret}</span>` : ""}</div>
          </div>`;
          if (isExpanded) {
            html += `<div style="padding:10px 16px 14px 40px;border-bottom:1px solid var(--border);background:var(--bg);font-family:var(--mono);font-size:12px;line-height:1.6">`;
            if (f.typeParameters?.length) {
              html += `<div style="margin-bottom:10px"><div style="color:var(--text-dim);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Type Parameters</div>`;
              f.typeParameters.forEach((tp, i) => {
                const con = tp.constraints?.length ? ` <span style="color:var(--text-dim)">:</span> <span class="u-c-purple">${tp.constraints.map(escapeHtml).join(" + ")}</span>` : "";
                html += `<div style="padding:1px 0"><span class="u-c-purple">T${i}</span>${con}</div>`;
              });
              html += `</div>`;
            }
            html += `<div style="margin-bottom:10px"><div style="color:var(--text-dim);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Parameters</div>`;
            if (f.parameters?.length) {
              f.parameters.forEach((p, i) => {
                html += `<div style="padding:1px 0"><span class="u-c-dim">_${i}:</span> <span class="u-c-blue">${escapeHtml(p.repr)}</span></div>`;
              });
            } else {
              html += `<div style="color:var(--text-dim)">(none)</div>`;
            }
            html += `</div>`;
            html += `<div><div style="color:var(--text-dim);font-size:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Returns</div>`;
            if (f.return?.length) {
              f.return.forEach(r => {
                html += `<div style="padding:1px 0"><span class="u-c-purple">${escapeHtml(r.repr)}</span></div>`;
              });
            } else {
              html += `<div style="color:var(--text-dim)">(none)</div>`;
            }
            html += `</div>`;
            html += `</div>`;
          }
        }
        html += '</div>';
      }
    } else if (activeModuleTab === "structs") {
      if (!d.structs.length) { html += '<div style="padding:16px;color:var(--text-dim);font-size:13px">No structs in this module.</div>'; }
      else {
        html += '<div style="overflow-y:auto;max-height:calc(100vh - 400px)">';
        const structFields = {};
        if (d.disassembly) {
          const re = /struct\s+(\w+)(?:<[^>]*>)?\s+has\s+[^{]*\{([^}]*)}/gs;
          let sm;
          while ((sm = re.exec(d.disassembly)) !== null) {
            const fields = sm[2].trim().split(/\n/).map(l => l.trim().replace(/,\s*$/, '')).filter(Boolean);
            structFields[sm[1]] = fields;
          }
        }
        for (const s of d.structs) {
          const abilities = s.abilities || [];
          const tps = (s.typeParameters || []).map((tp, i) => `${tp.isPhantom ? 'phantom ' : ''}T${i}${tp.constraints?.length ? ': ' + tp.constraints.join(' + ') : ''}`).join(", ");
          html += `<div style="padding:10px 16px;border-bottom:1px solid var(--border)">
            <div style="font-family:var(--mono);font-size:13px"><span style="color:#ff7b72">struct</span> <span class="u-fw-600">${s.name}</span>${tps ? '&lt;<span class="u-c-purple">' + tps + '</span>&gt;' : ''} <span style="color:#d2a8ff">has ${abilities.join(", ").toLowerCase()}</span></div>`;
          const fields = structFields[s.name];
          if (fields && fields.length) {
            html += `<div style="margin:6px 0 0 16px;font-family:var(--mono);font-size:12px">`;
            for (const fld of fields) {
              const parts = fld.split(':').map(x => x.trim());
              if (parts.length >= 2) {
                html += `<div style="padding:2px 0"><span class="u-c-text">${parts[0]}</span><span class="u-c-dim">:</span> <span class="u-c-blue">${shortType(parts.slice(1).join(':'))}</span></div>`;
              } else {
                html += `<div style="padding:2px 0;color:var(--text-dim)">${fld}</div>`;
              }
            }
            html += `</div>`;
          }
          html += `</div>`;
        }
        html += '</div>';
      }
    } else if (activeModuleTab === "enums") {
      if (!d.enums?.length) { html += '<div style="padding:16px;color:var(--text-dim);font-size:13px">No enums in this module.</div>'; }
      else {
        html += '<div style="overflow-y:auto;max-height:calc(100vh - 400px)">';
        for (const e of d.enums) {
          const abilities = e.abilities || [];
          const tps = (e.typeParameters || []).map((tp, i) => `${tp.isPhantom ? 'phantom ' : ''}T${i}${tp.constraints?.length ? ': ' + tp.constraints.join(' + ') : ''}`).join(", ");
          html += `<div style="padding:10px 16px;border-bottom:1px solid var(--border)">
            <div style="font-family:var(--mono);font-size:13px"><span style="color:#ff7b72">enum</span> <span class="u-fw-600">${e.name}</span>${tps ? '&lt;<span class="u-c-purple">' + tps + '</span>&gt;' : ''} <span style="color:#d2a8ff">has ${abilities.join(", ").toLowerCase()}</span></div>`;
          if (e.variants?.length) {
            html += `<div style="margin:6px 0 0 16px;font-family:var(--mono);font-size:12px">`;
            for (const v of e.variants) {
              html += `<div style="padding:3px 0"><span style="color:var(--yellow);font-weight:600">${v.name}</span>`;
              if (v.fields?.length) {
                html += ` { ${v.fields.map(f => `<span class="u-c-text">${f.name}</span><span class="u-c-dim">:</span> <span class="u-c-blue">${shortType(f.type?.repr || '')}</span>`).join(', ')} }`;
              }
              html += `</div>`;
            }
            html += `</div>`;
          }
          html += `</div>`;
        }
        html += '</div>';
      }
    } else if (activeModuleTab === "disassembly") {
      if (!d.disassembly) { html += '<div style="padding:16px;color:var(--text-dim);font-size:13px">No disassembly available.</div>'; }
      else {
        html += `<pre style="margin:0;padding:12px 16px;font-family:var(--mono);font-size:11px;line-height:1.5;overflow:auto;white-space:pre;max-height:calc(100vh - 400px);background:var(--bg)">${highlightDisasm(d.disassembly)}</pre>`;
      }
    }
    return html;
  };

  const renderSidebar = (filter) => {
    const q = (filter || "").toLowerCase();
    const filtered = q ? modules.filter(m => m.name.toLowerCase().includes(q)) : modules;
    let html = filtered.map(m => {
      const act = m.name === selectedModule;
      const d = moduleData[m.name];
      const badge = d ? `<span class="u-fs10-dim">${d.functions.length}fn ${d.structs.length}st${d.enums?.length ? ' ' + d.enums.length + 'en' : ''}</span>` : "";
      return `<div role="button" tabindex="0" data-action="obj-select-module" data-module="${escapeAttr(m.name)}" style="padding:6px 12px;cursor:pointer;font-family:var(--mono);font-size:12px;display:flex;justify-content:space-between;align-items:center;background:${act ? 'var(--bg-light)' : 'transparent'};border-left:2px solid ${act ? 'var(--accent)' : 'transparent'};color:${act ? 'var(--text)' : 'var(--text-dim)'}">${escapeHtml(m.name)}${badge}</div>`;
    }).join("");
    if (modulesHasNext || modulesLoading) {
      html += `<div style="padding:8px 10px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${modulesHasNext ? `<button data-action="obj-load-modules" style="padding:5px 10px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:11px">Load More Modules</button>` : ""}
        ${modulesLoading ? `<span class="u-fs11-dim">Loading...</span>` : ""}
        ${modulesHasNext ? `<span class="trunc-note">Partial</span>` : ""}
      </div>`;
    }
    return html || `<div style="padding:10px;font-size:12px;color:var(--text-dim)">No modules found.</div>`;
  };

  const filterModules = (q) => {
    const sidebar = document.getElementById("pkg-sidebar-list");
    if (!sidebar) return;
    sidebar.innerHTML = renderSidebar(q || "");
  };
  const selectModule = async (modName) => {
    selectedModule = modName;
    activeModuleTab = "functions";
    expandedFunctions = new Set();
    filterModules(document.getElementById("pkg-mod-filter")?.value || "");
    const panel = document.getElementById("pkg-module-panel");
    if (!panel) return;
    panel.innerHTML = '<div class="loading u-p24">Loading...</div>';
    await loadModuleData(modName);
    filterModules(document.getElementById("pkg-mod-filter")?.value || "");
    panel.innerHTML = renderModulePanel();
  };
  const switchModuleTab = (tab) => {
    activeModuleTab = tab;
    const panel = document.getElementById("pkg-module-panel");
    if (panel) panel.innerHTML = renderModulePanel();
  };
  if (isPackage) {
    let depsLoaded = false;
    let depsHtml = "";
    tabContent.deps = () => {
      if (depsLoaded) return depsHtml;
      depsHtml = '<div class="loading">Loading dependencies...</div>';
      (async () => {
        try {
          const depData = await gql(`query($pkg: SuiAddress!) {
            object(address: $pkg) { asMovePackage { linkage { originalId upgradedId version } typeOrigins { module struct definingId } } }
          }`, { pkg: id });
          const linkage = depData.object?.asMovePackage?.linkage || [];
          const typeOrigins = depData.object?.asMovePackage?.typeOrigins || [];
          // Resolve MVR names for dependency packages
          const depAddrs = linkage.map(l => l.originalId).filter(Boolean);
          if (depAddrs.length) await resolvePackageNames(depAddrs);
          let html = "";
          if (linkage.length) {
            html += `<h4 style="font-size:13px;margin:0 0 8px;color:var(--text-dim)">Package Dependencies (${linkage.length})</h4>`;
            html += `<table><thead><tr><th>Package</th><th>Name</th><th class="u-ta-right">Linked Version</th></tr></thead><tbody>`;
            for (const l of linkage) {
              const name = mvrNameCache[l.originalId];
              const upgraded = l.originalId !== l.upgradedId;
              html += `<tr>
                <td>${hashLink(l.originalId, '/object/' + l.originalId)}</td>
                <td>${name ? `<span class="u-c-accent">@${name}</span>` : '<span class="u-c-dim">—</span>'}</td>
                <td class="u-ta-right-mono">v${l.version}${upgraded ? ` <span style="color:var(--yellow);font-size:11px">(upgraded to ${truncHash(l.upgradedId)})</span>` : ""}</td>
              </tr>`;
            }
            html += `</tbody></table>`;
          } else {
            html += `<div style="color:var(--text-dim);font-size:13px">No external dependencies.</div>`;
          }
          if (typeOrigins.length) {
            // Group by module
            const byMod = {};
            for (const to of typeOrigins) {
              if (!byMod[to.module]) byMod[to.module] = [];
              byMod[to.module].push(to.struct);
            }
            html += `<h4 style="font-size:13px;margin:16px 0 8px;color:var(--text-dim)">Type Origins (${typeOrigins.length} types across ${Object.keys(byMod).length} modules)</h4>`;
            html += `<div style="display:flex;flex-wrap:wrap;gap:6px">`;
            for (const [mod, structs] of Object.entries(byMod)) {
              for (const s of structs) {
                html += `<span style="display:inline-block;padding:3px 8px;border:1px solid var(--border);border-radius:4px;font-family:var(--mono);font-size:11px">${mod}::<span class="u-fw-600">${s}</span></span>`;
              }
            }
            html += `</div>`;
          }
          depsHtml = html;
          depsLoaded = true;
          if (document.getElementById("obj-tab-content") && document.querySelector('.inner-tab.active')?.textContent?.includes("Dependencies")) {
            document.getElementById("obj-tab-content").innerHTML = depsHtml;
          }
        } catch (e) {
          depsHtml = '<div class="empty">Failed to load dependencies.</div>';
          depsLoaded = true;
        }
      })();
      return depsHtml;
    };
  }

  // ── Object Version History (lazy-loaded + pagination) ──
  let historyLoaded = false;
  let historyLoading = false;
  let historyErr = "";
  let historyRows = [];
  let historyHasPrev = false;
  let historyCursor = null;
  function renderHistoryTable() {
    if (historyLoading && !historyRows.length) return '<div class="loading u-p24">Loading version history...</div>';
    if (historyErr) return renderEmpty(escapeHtml(historyErr));
    if (!historyRows.length) return renderEmpty("No version history available.");
    let html = `<table><thead><tr><th>Version</th><th>Digest</th><th>Modifying Transaction</th><th>Type</th></tr></thead><tbody>`;
    for (const v of historyRows) {
      const isCurrent = v.version == obj.version;
      html += `<tr${isCurrent ? ' style="background:var(--bg-light)"' : ''}>
        <td style="font-family:var(--mono);font-size:12px;font-weight:${isCurrent ? '600' : '400'}">${v.version}${isCurrent ? ' <span style="color:var(--accent);font-size:10px">current</span>' : ''}</td>
        <td class="u-mono-11-dim">${v.digest ? truncHash(v.digest) : "—"}</td>
        <td>${v.previousTransaction?.digest ? hashLink(v.previousTransaction.digest, '/tx/' + v.previousTransaction.digest) : "—"}</td>
        <td class="u-mono-11-dim">${shortType(v.asMoveObject?.contents?.type?.repr || "")}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
    if (historyHasPrev || historyLoading) {
      html += `<div style="padding:10px 0;display:flex;align-items:center;gap:10px">
        ${historyHasPrev ? `<button data-action="obj-load-history" class="btn-surface-sm">Load Older Versions</button>` : ""}
        ${historyLoading ? `<span class="u-fs12-dim">Loading...</span>` : ""}
        ${historyHasPrev ? `<span class="trunc-note">Partial</span>` : ""}
      </div>`;
    }
    return html;
  }
  async function loadHistoryPage(before = null) {
    if (historyLoading) return;
    historyLoading = true;
    historyErr = "";
    const activeEl = document.getElementById("obj-tab-content");
    if (activeEl && document.querySelector(".inner-tab.active")?.textContent?.includes("History")) {
      activeEl.innerHTML = renderHistoryTable();
    }
    try {
      const hData = await gql(`query($id: SuiAddress!, $before: String) {
        objectVersions(address: $id, last: 20, before: $before) {
          pageInfo { hasPreviousPage startCursor }
          nodes { address version digest previousTransaction { digest } ${GQL_F_MOVE_TYPE} }
        }
      }`, { id: idNorm, before });
      const conn = hData?.objectVersions;
      const batch = conn?.nodes || [];
      const byKey = new Map(historyRows.map(v => [`${v.version}:${v.digest || ""}`, v]));
      for (const v of batch) byKey.set(`${v.version}:${v.digest || ""}`, v);
      historyRows = [...byKey.values()].sort((a, b) => Number(a.version || 0) - Number(b.version || 0));
      historyHasPrev = !!conn?.pageInfo?.hasPreviousPage;
      historyCursor = conn?.pageInfo?.startCursor || null;
      historyLoaded = true;
    } catch (e) {
      historyErr = e?.message || "Failed to load version history.";
      historyLoaded = true;
    } finally {
      historyLoading = false;
      if (activeEl && document.querySelector(".inner-tab.active")?.textContent?.includes("History")) {
        activeEl.innerHTML = renderHistoryTable();
      }
    }
  }
  tabContent.history = () => {
    if (!historyLoaded && !historyLoading) loadHistoryPage(null);
    return renderHistoryTable();
  };

  // ── Package Version History (lazy-loaded + pagination) ──
  let pkgVersionsHasPrev = false;
  let pkgVersionsCursor = null;
  let loadPackageVersionsPage = async () => {};
  if (isPackage) {
    let pkgVersionsLoaded = false;
    let pkgVersionsLoading = false;
    let pkgVersionsErr = "";
    let pkgVersionRows = [];
    function renderPackageVersionsTable() {
      if (pkgVersionsLoading && !pkgVersionRows.length) return '<div class="loading u-p24">Loading package versions...</div>';
      if (pkgVersionsErr) return renderEmpty(escapeHtml(pkgVersionsErr));
      if (!pkgVersionRows.length) return renderEmpty("No package version history.");
      let html = `<div style="padding:12px 16px;font-size:13px;color:var(--text-dim)">${pkgVersionRows.length} version${pkgVersionRows.length > 1 ? 's' : ''} loaded</div>`;
      html += `<table><thead><tr><th>Version</th><th>Package Address</th><th>Publishing Transaction</th></tr></thead><tbody>`;
      for (const pv of pkgVersionRows) {
        const isCurrent = pv.address === idNorm;
        html += `<tr${isCurrent ? ' style="background:var(--bg-light)"' : ''}>
          <td style="font-family:var(--mono);font-size:12px;font-weight:${isCurrent ? '600' : '400'}">${pv.version}${isCurrent ? ' <span style="color:var(--accent);font-size:10px">current</span>' : ''}</td>
          <td>${isCurrent ? truncHash(pv.address) + ' ' + copyBtn(pv.address) : hashLink(pv.address, '/object/' + pv.address)}</td>
          <td>${pv.previousTransaction?.digest ? hashLink(pv.previousTransaction.digest, '/tx/' + pv.previousTransaction.digest) : "—"}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
      if (pkgVersionsHasPrev || pkgVersionsLoading) {
        html += `<div style="padding:10px 0;display:flex;align-items:center;gap:10px">
          ${pkgVersionsHasPrev ? `<button data-action="obj-load-package-versions" class="btn-surface-sm">Load Older Versions</button>` : ""}
          ${pkgVersionsLoading ? `<span class="u-fs12-dim">Loading...</span>` : ""}
          ${pkgVersionsHasPrev ? `<span class="trunc-note">Partial</span>` : ""}
        </div>`;
      }
      return html;
    }
    loadPackageVersionsPage = async (before = null) => {
      if (pkgVersionsLoading) return;
      pkgVersionsLoading = true;
      pkgVersionsErr = "";
      const activeEl = document.getElementById("obj-tab-content");
      if (activeEl && document.querySelector(".inner-tab.active")?.textContent?.includes("Versions")) {
        activeEl.innerHTML = renderPackageVersionsTable();
      }
      try {
        const pvData = await gql(`query($id: SuiAddress!, $before: String) {
          packageVersions(address: $id, last: 20, before: $before) {
            pageInfo { hasPreviousPage startCursor }
            nodes { address version previousTransaction { digest } }
          }
        }`, { id: idNorm, before });
        const conn = pvData?.packageVersions;
        const batch = conn?.nodes || [];
        const byKey = new Map(pkgVersionRows.map(v => [`${v.address}:${v.version}`, v]));
        for (const v of batch) byKey.set(`${v.address}:${v.version}`, v);
        pkgVersionRows = [...byKey.values()].sort((a, b) => Number(a.version || 0) - Number(b.version || 0));
        pkgVersionsHasPrev = !!conn?.pageInfo?.hasPreviousPage;
        pkgVersionsCursor = conn?.pageInfo?.startCursor || null;
        pkgVersionsLoaded = true;
      } catch (e) {
        pkgVersionsErr = e?.message || "Failed to load package versions.";
        pkgVersionsLoaded = true;
      } finally {
        pkgVersionsLoading = false;
        if (activeEl && document.querySelector(".inner-tab.active")?.textContent?.includes("Versions")) {
          activeEl.innerHTML = renderPackageVersionsTable();
        }
      }
    };
    tabContent.versions = () => {
      if (!pkgVersionsLoaded && !pkgVersionsLoading) loadPackageVersionsPage(null);
      return renderPackageVersionsTable();
    };
  }

  function renderTabs(active) {
    const tabs = isPackage ? ["modules", "deps", "versions", "dynamic"] : ["fields", "raw", "history", "dynamic"];
    const labels = { fields: "Fields", raw: "Raw JSON", dynamic: "Dynamic Fields", modules: "Modules", deps: "Dependencies", history: "History", versions: "Versions" };
    document.getElementById("obj-tabs").innerHTML = tabs.map(t =>
      `<div class="inner-tab ${t === active ? 'active' : ''}"
        data-action="obj-switch-tab" data-tab="${t}">${labels[t]}</div>`
    ).join("");
    const contentEl = document.getElementById("obj-tab-content");
    contentEl.style.padding = (isPackage && active === "modules") ? "0" : "";
    if (isPackage && active === "modules") {
      contentEl.innerHTML = `
        <div style="display:flex;min-height:500px;border-top:1px solid var(--border)">
          <div style="width:220px;min-width:180px;border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0">
            <div style="padding:8px;border-bottom:1px solid var(--border)">
              <input id="pkg-mod-filter" type="text" placeholder="Filter modules..."
                style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-family:var(--mono);box-sizing:border-box">
            </div>
            <div id="pkg-sidebar-list" style="overflow-y:auto;flex:1"></div>
          </div>
          <div id="pkg-module-panel" style="flex:1;min-width:0;overflow:hidden"></div>
        </div>`;
      // Render sidebar and panel after DOM is ready
      setTimeout(async () => {
        if (!isActiveRoute()) return;
        if (!modulesLoaded && !modulesLoading) loadMorePackageModules().catch(() => {});
        if (selectedModule) await loadModuleData(selectedModule);
        if (!isActiveRoute()) return;
        filterModules(document.getElementById("pkg-mod-filter")?.value || "");
        const panel = document.getElementById("pkg-module-panel");
        if (panel) panel.innerHTML = renderModulePanel();
      }, 0);
    } else {
      contentEl.innerHTML = tabContent[active]();
    }
    if (isActiveRoute()) scheduleVisibleObjectShellPrefetch(app);
  }

  app.innerHTML = `
    <div class="page-title">
      ${isPackage ? "Package" : "Object"}${mvrName ? ` <span style="color:var(--accent);font-weight:500">@${mvrName}</span>` : ""}
      <span class="type-tag">${isPackage ? "PKG" : "OBJ"}</span>
      ${copyLinkBtn()}${viewQueryBtn('object_detail', { id })}
    </div>
    <div class="card u-mb16">
      <div class="card-body">
        <div class="detail-row">
          <div class="detail-key">Object ID</div>
          <div class="detail-val">${fullHashLink(obj.address, '/object/' + obj.address)} ${copyBtn(obj.address)}</div>
        </div>
        ${typeRepr ? `<div class="detail-row">
          <div class="detail-key">Type</div>
          <div class="detail-val">${typeRepr}</div>
        </div>` : ""}
        <div class="detail-row">
          <div class="detail-key">Version</div>
          <div class="detail-val">${obj.version ?? "—"}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Digest</div>
          <div class="detail-val">${obj.digest || "—"} ${obj.digest ? copyBtn(obj.digest) : ""}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Owner</div>
          <div class="detail-val">${ownerDisplay}</div>
        </div>
        ${isPackage ? `<div class="detail-row">
          <div class="detail-key">Modules</div>
          <div class="detail-val normal-font">${modules.length}${modulesHasNext ? '+' : ''}${modulesHasNext ? ' <span class="trunc-note">Partial</span>' : ''}</div>
        </div>` : ""}
        <div class="detail-row">
          <div class="detail-key">Storage Rebate</div>
          <div class="detail-val normal-font">${fmtSui(obj.storageRebate)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Last Transaction</div>
          <div class="detail-val">${obj.previousTransaction
            ? fullHashLink(obj.previousTransaction.digest, '/tx/' + obj.previousTransaction.digest)
            : "—"}</div>
        </div>
      </div>
    </div>
    ${isPackage ? `<div class="card u-mb16" id="pkg-activity-card"><div class="card-body" style="padding:12px 16px;color:var(--text-dim);font-size:13px">Loading activity stats...</div></div>` : ""}
    <div class="card">
      <div id="obj-tabs" class="inner-tabs"></div>
      <div id="obj-tab-content" class="card-body"></div>
    </div>
  `;
  if (app._objectDetailClickHandler) app.removeEventListener("click", app._objectDetailClickHandler);
  app._objectDetailClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (!action) return;
    if (action === "obj-switch-tab") {
      ev.preventDefault();
      renderTabs(trigger.getAttribute("data-tab") || (isPackage ? "modules" : "fields"));
      return;
    }
    if (action === "obj-load-history") {
      ev.preventDefault();
      if (!historyHasPrev || !historyCursor) return;
      await loadHistoryPage(historyCursor);
      return;
    }
    if (action === "obj-load-package-versions") {
      ev.preventDefault();
      if (!isPackage || !pkgVersionsHasPrev || !pkgVersionsCursor) return;
      await loadPackageVersionsPage(pkgVersionsCursor);
      return;
    }
    if (action === "obj-load-dynamic") {
      ev.preventDefault();
      await loadMoreDynamicFields();
      return;
    }
    if (action === "obj-load-modules") {
      ev.preventDefault();
      await loadMorePackageModules();
      return;
    }
    if (action === "obj-toggle-fn") {
      ev.preventDefault();
      const fnName = trigger.getAttribute("data-fn") || "";
      if (!fnName) return;
      if (expandedFunctions.has(fnName)) {
        expandedFunctions.delete(fnName);
      } else {
        expandedFunctions.add(fnName);
      }
      const panel = document.getElementById("pkg-module-panel");
      if (panel) panel.innerHTML = renderModulePanel();
      return;
    }
    if (action === "obj-switch-mod-tab") {
      ev.preventDefault();
      switchModuleTab(trigger.getAttribute("data-tab") || "functions");
      return;
    }
    if (action === "obj-select-module") {
      ev.preventDefault();
      const modName = trigger.getAttribute("data-module") || "";
      if (!modName) return;
      await selectModule(modName);
    }
  };
  app.addEventListener("click", app._objectDetailClickHandler);
  if (app._objectDetailInputHandler) app.removeEventListener("input", app._objectDetailInputHandler);
  app._objectDetailInputHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.id !== "pkg-mod-filter") return;
    filterModules(target.value || "");
  };
  app.addEventListener("input", app._objectDetailInputHandler);
  if (app._objectDetailKeyHandler) app.removeEventListener("keydown", app._objectDetailKeyHandler);
  app._objectDetailKeyHandler = async (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const trigger = ev.target?.closest?.("[data-action='obj-select-module']");
    if (!trigger || !app.contains(trigger)) return;
    ev.preventDefault();
    const modName = trigger.getAttribute("data-module") || "";
    if (modName) await selectModule(modName);
  };
  app.addEventListener("keydown", app._objectDetailKeyHandler);
  renderTabs(isPackage ? "modules" : "fields");

  if (isPackage) {
    (async () => {
      const actCard = document.getElementById("pkg-activity-card");
      if (!actCard) return;
      try {
        const actData = await gql(`query($pkg: String!) {
          transactions(last: 50, filter: { function: $pkg }) {
            nodes {
              digest
              sender { address }
              effects {
                timestamp
                gasEffects { gasSummary { computationCost storageCost storageRebate } }
                objectChanges(first: 50) { nodes { address idCreated idDeleted outputState { ${GQL_F_MOVE_TYPE} } } }
                events(first: 50) { nodes { contents { type { repr } } } }
              }
            }
          }
        }`, { pkg: id });
        // Deduplicate: a tx can appear multiple times if it calls the package multiple times
        const seenDigests = new Set();
        const txNodes = (actData?.transactions?.nodes || []).filter(tx => {
          if (!tx.digest || seenDigests.has(tx.digest)) return false;
          seenDigests.add(tx.digest);
          return true;
        });
        if (!actCard.isConnected) return;
        // Per-tx stats
        const txStats = txNodes.map(tx => {
          const gs = tx.effects?.gasEffects?.gasSummary;
          const comp = gs ? BigInt(gs.computationCost ?? 0) : 0n;
          const stor = gs ? BigInt(gs.storageCost ?? 0) : 0n;
          const reb  = gs ? BigInt(gs.storageRebate ?? 0) : 0n;
          const gasUsed = comp + stor - reb;
          const changes = tx.effects?.objectChanges?.nodes || [];
          const txCreated = changes.filter(c => c.idCreated).map(c => c.address);
          const txDeleted = changes.filter(c => c.idDeleted).map(c => c.address);
          const txMutated = changes.filter(c => !c.idCreated && !c.idDeleted).map(c => c.address);
          // Per-tx events
          const txEvents = (tx.effects?.events?.nodes || []).map(ev => shortType(ev.contents?.type?.repr || "unknown"));
          // Per-tx object types from changes
          const txObjTypes = [...new Set(changes.map(c => c.outputState?.asMoveObject?.contents?.type?.repr).filter(Boolean).map(shortType))];
          return { digest: tx.digest, sender: tx.sender?.address || null, gasUsed, comp, stor, reb, txCreated, txDeleted, txMutated, txEvents, txObjTypes };
        });
        const txCount = txStats.length;
        if (txCount === 0) { actCard.remove(); return; }
        const totalGas = txStats.reduce((s, t) => s + t.gasUsed, 0n);
        const created = txStats.reduce((s, t) => s + t.txCreated.length, 0);
        const mutated = txStats.reduce((s, t) => s + t.txMutated.length, 0);
        const deleted = txStats.reduce((s, t) => s + t.txDeleted.length, 0);
        // Unique senders
        const senderSet = new Set(txNodes.map(tx => tx.sender?.address).filter(Boolean));
        const uniqueSenders = senderSet.size;
        // Event counts by type
        const eventCounts = {};
        let totalEvents = 0;
        for (const tx of txNodes) {
          for (const ev of (tx.effects?.events?.nodes || [])) {
            const t = shortType(ev.contents?.type?.repr || "unknown");
            eventCounts[t] = (eventCounts[t] || 0) + 1;
            totalEvents++;
          }
        }
        const topEvents = Object.entries(eventCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
        // Unique object types from changes
        const objTypeSet = new Set();
        for (const tx of txNodes) {
          for (const c of (tx.effects?.objectChanges?.nodes || [])) {
            const t = c.outputState?.asMoveObject?.contents?.type?.repr;
            if (t) objTypeSet.add(shortType(t));
          }
        }
        const uniqueObjTypes = [...objTypeSet].sort();
        // Time range
        const timestamps = txNodes.map(tx => new Date(tx.effects?.timestamp).getTime()).filter(Number.isFinite).sort((a, b) => a - b);
        const oldestTs = timestamps[0] || 0;
        const newestTs = timestamps[timestamps.length - 1] || 0;
        const spanMs = newestTs - oldestTs;
        let timeRangeLabel = "";
        if (spanMs > 0) {
          const mins = spanMs / 60000;
          if (mins < 60) timeRangeLabel = mins.toFixed(0) + " min";
          else if (mins < 1440) timeRangeLabel = (mins / 60).toFixed(1) + " hrs";
          else timeRangeLabel = (mins / 1440).toFixed(1) + " days";
        }

        const statCell = (label, value, sub) => `
          <div style="text-align:center;padding:10px 16px">
            <div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--text)">${value}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:3px">${label}</div>
            ${sub ? `<div style="font-size:10px;color:var(--text-dim);opacity:0.6;margin-top:1px">${sub}</div>` : ""}
          </div>`;

        const addrList = (addrs, color) => addrs.length
          ? addrs.map(a => `<div style="padding:1px 0">${hashLink(a, '/object/' + a)}</div>`).join("")
          : `<span style="color:var(--text-dim)">—</span>`;

        const txRows = txStats.map(t => {
          const hasChanges = t.txCreated.length || t.txMutated.length || t.txDeleted.length;
          const hasDetail = hasChanges || t.txEvents.length || t.txObjTypes.length;
          // Group per-tx events by type with counts
          const txEvCounts = {};
          for (const e of t.txEvents) txEvCounts[e] = (txEvCounts[e] || 0) + 1;
          const txEvEntries = Object.entries(txEvCounts).sort((a, b) => b[1] - a[1]);
          const changeDetail = hasDetail ? `
            <tr><td colspan="8" style="padding:0 0 6px 24px;background:var(--bg)">
              <details style="font-size:11px">
                <summary style="cursor:pointer;color:var(--text-dim);padding:4px 0;list-style:none;display:flex;align-items:center;gap:4px">
                  <span style="font-size:10px">▶</span> View details
                </summary>
                <div style="padding:6px 0 2px">
                  ${hasChanges ? '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px"><div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--green);margin-bottom:3px">Created (' + t.txCreated.length + ')</div>' + addrList(t.txCreated, "var(--green)") + '</div><div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--accent);margin-bottom:3px">Mutated (' + t.txMutated.length + ')</div>' + addrList(t.txMutated, "var(--accent)") + '</div><div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--red);margin-bottom:3px">Deleted (' + t.txDeleted.length + ')</div>' + addrList(t.txDeleted, "var(--red)") + '</div></div>' : ""}
                  ${txEvEntries.length ? '<div style="margin-bottom:8px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--purple);margin-bottom:3px">Events (' + t.txEvents.length + ')</div>' + txEvEntries.map(function(e) { return '<span class="badge" style="margin:2px 4px 2px 0;background:var(--purple)22;color:var(--purple);font-size:11px">' + escapeHtml(e[0]) + ' <span style="opacity:0.7">(' + e[1] + ')</span></span>'; }).join("") + '</div>' : ""}
                  ${t.txObjTypes.length ? '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--blue);margin-bottom:3px">Object Types (' + t.txObjTypes.length + ')</div>' + t.txObjTypes.map(function(ot) { return '<span class="badge" style="margin:2px 4px 2px 0;background:var(--blue)22;color:var(--blue);font-size:11px">' + escapeHtml(ot) + '</span>'; }).join("") + '</div>' : ""}
                </div>
              </details>
            </td></tr>` : "";
          const storNet  = t.stor > t.reb ? t.stor - t.reb : 0n;
          const compPct  = t.gasUsed > 0n ? Number(t.comp   * 1000n / t.gasUsed) / 10 : 0;
          const storPct  = t.gasUsed > 0n ? Number(storNet  * 1000n / t.gasUsed) / 10 : 0;
          const gasCell = `
            <div>
              <div style="font-family:var(--mono);font-size:12px;text-align:right">${fmtSui(t.gasUsed.toString())}</div>
              <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin-top:4px;background:var(--border)">
                <div style="width:${compPct}%;min-width:${compPct>0?3:0}px;background:var(--accent)"></div>
                <div style="width:${storPct}%;min-width:${storPct>0?3:0}px;background:var(--yellow)"></div>
              </div>
              <div style="display:flex;gap:8px;font-size:10px;color:var(--text-dim);margin-top:3px;justify-content:flex-end">
                <span style="display:flex;align-items:center;gap:3px"><span style="display:inline-block;width:8px;height:8px;border-radius:1px;background:var(--accent)"></span>comp</span>
                <span style="display:flex;align-items:center;gap:3px"><span style="display:inline-block;width:8px;height:8px;border-radius:1px;background:var(--yellow)"></span>stor</span>
              </div>
            </div>`;
          return `
            <tr style="border-bottom:1px solid var(--border)">
              <td class="u-mono-12">${fullHashLink(t.digest, '/tx/' + t.digest)}</td>
              <td class="u-mono-12">${t.sender ? hashLink(t.sender, '/address/' + t.sender) : "—"}</td>
              <td style="text-align:right;vertical-align:top">${gasCell}</td>
              <td style="text-align:center;font-family:var(--mono);font-size:12px;color:var(--purple)">${t.txEvents.length || "—"}</td>
              <td style="text-align:center;font-family:var(--mono);font-size:12px;color:var(--blue)">${t.txObjTypes.length || "—"}</td>
              <td style="text-align:center;font-family:var(--mono);font-size:12px;color:var(--green)">${t.txCreated.length || "—"}</td>
              <td style="text-align:center;font-family:var(--mono);font-size:12px;color:var(--accent)">${t.txMutated.length || "—"}</td>
              <td style="text-align:center;font-family:var(--mono);font-size:12px;color:var(--red)">${t.txDeleted.length || "—"}</td>
            </tr>${changeDetail}`;
        }).join("");

        actCard.innerHTML = `
          <div style="padding:10px 16px 8px;font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.07em;border-bottom:1px solid var(--border)">
            Recent Activity <span style="font-weight:400;text-transform:none;letter-spacing:0">(last ${txCount === 50 ? "50+" : txCount} txns${timeRangeLabel ? " over " + timeRangeLabel : ""})</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;justify-content:space-around;padding:4px 0;border-bottom:1px solid var(--border)">
            ${statCell("Transactions", txCount.toLocaleString(), txCount === 50 ? "50 sampled" : "")}
            ${statCell("Unique Senders", uniqueSenders.toLocaleString(), "")}
            ${statCell("Events", totalEvents.toLocaleString(), topEvents.length + " types")}
            ${statCell("Gas Burned", fmtSui(totalGas.toString()), "across sample")}
            ${statCell("Avg Gas / Tx", txCount > 0 ? fmtSui((totalGas / BigInt(txCount)).toString()) : "—", "")}
            ${statCell("Object Types", uniqueObjTypes.length.toLocaleString(), "")}
            ${statCell("Objects Created", created.toLocaleString(), "")}
            ${statCell("Objects Mutated", mutated.toLocaleString(), "")}
            ${statCell("Objects Deleted", deleted.toLocaleString(), "")}
          </div>
          ${topEvents.length ? '<div style="padding:10px 16px;border-bottom:1px solid var(--border)"><div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em">Event Types</div>' + topEvents.map(function(e) { return '<span class="badge" style="margin:2px 4px 2px 0;background:var(--purple)22;color:var(--purple);font-size:11px">' + escapeHtml(e[0]) + ' <span style="opacity:0.7">(' + e[1] + ')</span></span>'; }).join("") + '</div>' : ""}
          ${uniqueObjTypes.length ? '<div style="padding:10px 16px;border-bottom:1px solid var(--border)"><div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em">Object Types Modified</div>' + uniqueObjTypes.map(function(t) { return '<span class="badge" style="margin:2px 4px 2px 0;background:var(--blue)22;color:var(--blue);font-size:11px">' + escapeHtml(t) + '</span>'; }).join("") + '</div>' : ""}
          <details style="padding:0">
            <summary style="padding:8px 16px;font-size:12px;color:var(--text-dim);cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;user-select:none">
              <span style="font-size:10px">▶</span> Show transactions
            </summary>
            <div style="overflow-x:auto">
              <table style="margin:0">
                <thead><tr>
                  <th>Digest</th>
                  <th>Sender</th>
                  <th style="text-align:right">Gas Used</th>
                  <th style="text-align:center;color:var(--purple)">Events</th>
                  <th style="text-align:center;color:var(--blue)">Obj Types</th>
                  <th style="text-align:center;color:var(--green)">Created</th>
                  <th style="text-align:center;color:var(--accent)">Mutated</th>
                  <th style="text-align:center;color:var(--red)">Deleted</th>
                </tr></thead>
                <tbody>${txRows}</tbody>
              </table>
            </div>
          </details>`;
      } catch (e) {
        const actCard2 = document.getElementById("pkg-activity-card");
        if (actCard2) actCard2.innerHTML = `<div class="card-body" style="padding:10px 16px;color:var(--text-dim);font-size:12px">Activity stats unavailable: ${escapeHtml(e?.message || String(e))}</div>`;
      }
    })();
  }
}

// ── Epoch Detail ───────────────────────────────────────────────────────
async function fetchEpochDetailShell(epochId, force = false) {
  const id = parseInt(epochId);
  const epochStorageKey = persistedScalarCacheKey(PERSISTED_CACHE_KEYS.epochDetailPrefix, id);
  const epochState = getKeyedCacheState(epochDetailCache, id);
  hydratePersistedTimedCacheState(epochState, epochStorageKey, ENTITY_SHELL_TTL_MS);
  return withTimedCache(epochState, ENTITY_SHELL_TTL_MS, force, async () => {
    const result = await gql(`query($id: UInt53!) {
      epoch(epochId: $id) {
        epochId startTimestamp endTimestamp
        referenceGasPrice totalCheckpoints totalTransactions
        totalGasFees totalStakeRewards totalStakeSubsidies
        fundSize fundInflow fundOutflow netInflow
      }
    }`, { id });
    writePersistedTimedCacheRecord(epochStorageKey, result, 22000);
    return result;
  });
}

async function renderEpochDetail(app, epochId) {
  const data = await fetchEpochDetailShell(epochId, false);

  const ep = data.epoch;
  if (!ep) { app.innerHTML = renderEmpty("Epoch not found."); return; }

  const isActive = !ep.endTimestamp;
  const duration = ep.endTimestamp
    ? Math.round((new Date(ep.endTimestamp) - new Date(ep.startTimestamp)) / 3600000) + "h"
    : timeAgo(ep.startTimestamp) + " (ongoing)";

  const prevEpoch = parseInt(epochId) > 0 ? parseInt(epochId) - 1 : null;
  const nextEpoch = isActive ? null : parseInt(epochId) + 1;

  app.innerHTML = `
    <div class="page-title">
      Epoch <span class="type-tag">${isActive ? "ACTIVE" : "#" + ep.epochId}</span>
      ${copyLinkBtn()}
    </div>

    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Duration</div>
        <div class="stat-value">${duration}</div>
        <div class="stat-sub">${fmtTime(ep.startTimestamp)} &rarr; ${ep.endTimestamp ? fmtTime(ep.endTimestamp) : "now"}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Transactions</div>
        <div class="stat-value">${fmtNumber(ep.totalTransactions)}</div>
        <div class="stat-sub">${fmtNumber(ep.totalCheckpoints)} checkpoints</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Reference Gas Price</div>
        <div class="stat-value">${fmtNumber(ep.referenceGasPrice)} MIST</div>
        <div class="stat-sub">Total gas: ${fmtSui(ep.totalGasFees)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Stake Rewards</div>
        <div class="stat-value">${fmtSui(ep.totalStakeRewards)}</div>
        <div class="stat-sub">Subsidies: ${fmtSui(ep.totalStakeSubsidies)}</div>
      </div>
    </div>

    <div class="card u-mb16">
      <div class="card-header">Storage Fund</div>
      <div class="card-body">
        <div class="detail-row">
          <div class="detail-key">Fund Size</div>
          <div class="detail-val normal-font">${fmtSui(ep.fundSize)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Inflow</div>
          <div class="detail-val normal-font u-c-green">+${fmtSui(ep.fundInflow)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Outflow</div>
          <div class="detail-val normal-font u-c-red">-${fmtSui(ep.fundOutflow)}</div>
        </div>
        <div class="detail-row">
          <div class="detail-key">Net Inflow</div>
          <div class="detail-val normal-font u-fw-600">${fmtSui(ep.netInflow)}</div>
        </div>
      </div>
    </div>

    <div class="pagination" style="border-top:none;padding-top:0">
      <button ${prevEpoch == null ? "disabled" : ""} data-action="epoch-nav" data-epoch="${prevEpoch ?? ""}">&#x25C0; Epoch ${prevEpoch ?? ""}</button>
      <button ${nextEpoch == null ? "disabled" : ""} data-action="epoch-nav" data-epoch="${nextEpoch ?? ""}">Epoch ${nextEpoch ?? ""} &#x25B6;</button>
    </div>
  `;
  if (app._epochDetailClickHandler) app.removeEventListener("click", app._epochDetailClickHandler);
  app._epochDetailClickHandler = (ev) => {
    const trigger = ev.target?.closest?.("[data-action='epoch-nav']");
    if (!trigger || !app.contains(trigger)) return;
    ev.preventDefault();
    if (trigger.hasAttribute("disabled")) return;
    const epoch = trigger.getAttribute("data-epoch") || "";
    if (!epoch) return;
    navigate(`/epoch/${epoch}`);
  };
  app.addEventListener("click", app._epochDetailClickHandler);
}

// ── Named Queries (for "View Query" feature) ──────────────────────────
const QUERIES = {
  dashboard_checkpoint: {
    label: "Overview — Latest Checkpoint",
    query: `{
  checkpoint {
    sequenceNumber digest timestamp
    networkTotalTransactions
    rollingGasSummary { computationCost storageCost storageRebate }
  }
}`,
    variables: {},
  },
  dashboard_epoch: {
    label: "Overview — Current Epoch",
    query: `{
  epoch {
    epochId referenceGasPrice startTimestamp
    totalCheckpoints totalTransactions
  }
}`,
    variables: {},
  },
  transaction: {
    label: "Transaction Detail",
    query: `query($digest: String!) {
  transaction(digest: $digest) {
    digest
    sender { address }
    gasInput { gasPrice gasBudget gasPayment { nodes { address } } gasSponsor { address } }
    kind {
      ... on ProgrammableTransaction {
        inputs(first: 30) { pageInfo { hasNextPage } nodes {
          __typename
          ... on Pure { bytes }
          ... on OwnedOrImmutable { object { address } }
          ... on SharedInput { address initialSharedVersion mutable }
          ... on Receiving { object { address } }
        } }
        commands(first: 30) { pageInfo { hasNextPage } nodes {
          __typename
          ... on MoveCallCommand { function { module { name package { address } } name } }
          ... on TransferObjectsCommand { __typename }
          ... on SplitCoinsCommand { __typename }
          ... on MergeCoinsCommand { __typename }
          ... on PublishCommand { __typename }
          ... on UpgradeCommand { currentPackage }
          ... on MakeMoveVecCommand { __typename }
        } }
      }
    }
    effects {
      status timestamp
      executionError { message }
      checkpoint { sequenceNumber }
      epoch { epochId }
      gasEffects {
        gasSummary { computationCost storageCost storageRebate nonRefundableStorageFee }
        gasObject { address }
      }
      balanceChanges(first: 50) { pageInfo { hasNextPage } nodes { ${GQL_F_BAL_NODE} } }
      objectChanges(first: 50) { pageInfo { hasNextPage } nodes {
        address idCreated idDeleted
        inputState { version digest ${GQL_F_MOVE_TYPE} }
        outputState { version digest owner {
          ${GQL_F_OWNER}
        } ${GQL_F_MOVE_TYPE} }
      } }
      events(first: 50) { pageInfo { hasNextPage } nodes { ${GQL_F_EVENT_NODE} } }
    }
  }
}`,
    variables: { digest: "2nCB7sd9hVJqnnQCSuzbkTLk4DuWp2RhdKfdQPgqfA4x" },
  },
  checkpoint_detail: {
    label: "Checkpoint Detail",
    query: `query($seq: UInt53!) {
  checkpoint(sequenceNumber: $seq) {
    sequenceNumber digest timestamp previousCheckpointDigest
    networkTotalTransactions
    epoch { epochId }
    rollingGasSummary { computationCost storageCost storageRebate }
    transactions(first: 20) {
      nodes {
        digest
        sender { address }
        effects { status timestamp gasEffects { gasSummary { computationCost storageCost storageRebate } } }
      }
    }
  }
}`,
    variables: { seq: 0 },
  },
  address_detail: {
    label: "Address Detail",
    query: `query($addr: SuiAddress!) {
  address(address: $addr) {
    address
    defaultNameRecord { domain }
    balances(first: 20) { nodes { coinType { repr } totalBalance } }
    transactions(last: 20) {
      nodes {
        digest
        sender { address }
        kind {
          __typename
          ... on ProgrammableTransaction {
            commands(first: 3) { nodes { __typename ... on MoveCallCommand { function { name module { name package { address } } } } } }
          }
        }
        effects { status timestamp }
      }
    }
    objects(first: 20) { nodes { address version digest ${GQL_F_CONTENTS_TYPE_JSON} } }
  }
}`,
    variables: { addr: "0xffd4f043057226453aeba59732d41c6093516f54823ebc3a16d17f8a77d2f0ad" },
  },
  object_detail: {
    label: "Object Detail",
    query: `query($id: SuiAddress!) {
  object(address: $id) {
    address version digest storageRebate
    owner {
      ${GQL_F_OWNER}
    }
    previousTransaction { digest }
    asMoveObject { hasPublicTransfer ${GQL_F_CONTENTS_TYPE_JSON} }
    asMovePackage { modules(first: 50) { pageInfo { hasNextPage endCursor } nodes { name } } }
    dynamicFields(first: 10) { pageInfo { hasNextPage endCursor } nodes {
      name { type { repr } json }
      value {
        ... on MoveValue { type { repr } json }
        ... on MoveObject { address ${GQL_F_CONTENTS_TYPE_JSON} }
      }
    } }
  }
}`,
    variables: { id: "0x98cb609be3149a6b38f19117e61b6052054fd239427e8ab4439088525f2d7ed3" },
  },
  deepbook_trade_events: {
    label: "DeepBook — Recent Trade Fills",
    query: `{
  events(last: 20, filter: {
    type: "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::order_info::OrderFilled"
  }) {
    nodes {
      ${GQL_F_EVENT_NODE}
    }
  }
}`,
    variables: {},
  },
  deepbook_pool_object: {
    label: "DeepBook — SUI/USDC Pool + Recent Activity",
    query: `{
  object(address: "0xe05dafb5133bcffb8d59f4e12465dc0e9faeaa05e3e342a08fe135800e3e4407") {
    address version digest
    ${GQL_F_MOVE_TYPE_JSON}
    objectVersionsBefore(last: 5) {
      nodes {
        version digest
        previousTransaction {
          digest
          effects {
            status timestamp
            events(first: 10) {
              nodes {
                ${GQL_F_CONTENTS_TYPE_JSON}
              }
            }
          }
        }
      }
    }
  }
}`,
    variables: {},
  },
  sample: {
    label: "Sample — Latest Checkpoint",
    query: `{
  checkpoint {
    sequenceNumber
    digest
    timestamp
    networkTotalTransactions
    epoch { epochId }
  }
}`,
    variables: {},
  },
};

async function renderCoin(app, routeCoinType = "") {
  const routeParams = splitRouteAndParams(getRoute()).params;
  const requestedRaw = String(routeCoinType || routeParams.get("type") || "").trim();
  const scanMode = getCoinActivityScanMode(routeParams.get("mode"));
  const scanParam = String(routeParams.get("scan") || "").trim();
  const shouldScanActivity = scanParam !== "0";
  const shouldResolveSupply = shouldScanActivity || routeParams.get("supply") === "1";

  function renderSearchCard(currentValue = "", error = "") {
    return `
      <div class="card u-mb16">
        <div class="card-header">Coin Search</div>
        <div class="card-body">
          <form id="coin-search-form" class="coin-search-bar">
            <input
              id="coin-search-input"
              class="ui-control coin-search-input"
              type="search"
              value="${escapeAttr(currentValue)}"
              placeholder="0x...::module::Type"
              enterkeyhint="search"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
            />
            <button type="submit" class="btn-accent-sm">Load Coin</button>
          </form>
          <div id="coin-search-error" class="coin-search-error">${error ? escapeHtml(error) : ""}</div>
        </div>
      </div>
    `;
  }

  function bindCoinSearchForm() {
    const form = document.getElementById("coin-search-form");
    if (!form) return;
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const inputEl = document.getElementById("coin-search-input");
      const nextRaw = String(inputEl?.value || "").trim();
      if (!nextRaw) return;
      const nextCoinType = normalizeCoinTypeQueryInput(nextRaw);
      if (!nextCoinType) {
        const errEl = document.getElementById("coin-search-error");
        if (errEl) errEl.textContent = "Use full coin type format: 0x...::module::Type";
        return;
      }
      const nextHash = "#/coin?type=" + encodeURIComponent(nextCoinType);
      if (window.location.hash === nextHash) routeTo(getRoute());
      else navigate("/coin?type=" + encodeURIComponent(nextCoinType));
    };
  }

  if (!requestedRaw) {
    app.innerHTML = `
      <div class="page-title">Coin Search</div>
      ${renderSearchCard()}
      <div class="card">
        <div class="card-body">
          ${renderEmpty("Enter a full coin type (0x...::module::Type) to inspect supply and recent activity.")}
        </div>
      </div>
    `;
    bindCoinSearchForm();
    return;
  }

  const coinType = normalizeCoinTypeQueryInput(requestedRaw);
  if (!coinType) {
    app.innerHTML = `
      <div class="page-title">Coin Search</div>
      ${renderSearchCard(requestedRaw, "Invalid coin type format. Expected 0x...::module::Type")}
      <div class="card">
        <div class="card-body">
          ${renderEmpty("Coin type could not be parsed.")}
        </div>
      </div>
    `;
    bindCoinSearchForm();
    return;
  }

  if ((routeParams.get("type") || "") !== coinType) setRouteParams({ type: coinType });

  app.innerHTML = `
    <div class="page-title">Coin Search</div>
    ${renderSearchCard(coinType)}
    <div class="card">
      <div class="card-body">${renderLoading()}</div>
    </div>
  `;
  bindCoinSearchForm();

  const summarizeCoinJson = CoinSearchData.summarizeJson;
  const renderAddressList = CoinSearchData.renderAddressList;
  const parseOwnerInfo = CoinSearchData.parseOwnerInfo;
  const fmtCoinAbs = CoinSearchData.fmtCoinAbs;
  const fetchCoinObjectDigestCandidates = CoinSearchData.fetchObjectDigestCandidates;
  const fetchCoinTxMetaRowsByDigest = CoinSearchData.fetchTxMetaRowsByDigest;
  const fetchCoinTxDetailsByDigest = CoinSearchData.fetchTxDetailsByDigest;

  try {
    let coinMeta = await getCoinMeta(coinType).catch(() => null);
    const shortCoinType = normalizeCoinType(coinType);
    if (!coinMeta && shortCoinType && shortCoinType !== coinType) {
      coinMeta = await getCoinMeta(shortCoinType).catch(() => null);
    }

    const resolved = resolveCoinType(coinType);
    const symbol = String(coinMeta?.symbol || resolved?.symbol || coinType.split("::").pop() || "?");
    const name = String(coinMeta?.name || symbol);
    const decimals = Number.isFinite(Number(coinMeta?.decimals))
      ? Number(coinMeta.decimals)
      : Number(resolved?.decimals || 9);
    const iconUrl = String(coinMeta?.iconUrl || "");
    let canonicalSupplyRaw = null;
    let canonicalSupplySource = "";
    let canonicalSupplyNote = "";
    let canonicalUnavailableReason = "";
    let estimatedSupplyRaw = null;
    let estimatedSupplySource = "";
    let estimatedSupplyNote = "";
    let supplyLookupPending = false;
    function applyRpcSupplyResult(rpcSupply) {
      const hasValue = rpcSupply?.value != null;
      const isEstimated = !!rpcSupply?.estimated;
      const canonicalKnown = !!rpcSupply?.canonicalKnown && hasValue && !isEstimated;
      const source = String(rpcSupply?.source || "");
      const note = String(rpcSupply?.note || "");
      const canonicalReason = String(rpcSupply?.canonicalUnavailableReason || "");
      if (canonicalKnown) {
        canonicalSupplyRaw = parseBigIntSafe(rpcSupply.value);
        canonicalSupplySource = source || "suix_getTotalSupply";
        canonicalSupplyNote = note;
        canonicalUnavailableReason = "";
        estimatedSupplyRaw = null;
        estimatedSupplySource = "";
        estimatedSupplyNote = "";
        return;
      }
      canonicalSupplyRaw = null;
      canonicalSupplySource = "";
      canonicalSupplyNote = "";
      if (hasValue && isEstimated) {
        estimatedSupplyRaw = parseBigIntSafe(rpcSupply.value);
        estimatedSupplySource = source || "coinObjects.sum";
        estimatedSupplyNote = note || "Derived estimate from live Coin objects; wrapped Balance<T> may be excluded.";
      } else {
        estimatedSupplyRaw = null;
        estimatedSupplySource = "";
        estimatedSupplyNote = "";
      }
      canonicalUnavailableReason = canonicalReason || note || "Unknown Supply: canonical total supply is not tracked for this coin type (TreasuryCap may be managed externally).";
    }
    if (coinMeta?.supply != null) {
      canonicalSupplyRaw = parseBigIntSafe(coinMeta.supply);
      canonicalSupplySource = "coinMetadata.supply";
      canonicalSupplyNote = "";
      canonicalUnavailableReason = "";
      estimatedSupplyRaw = null;
      estimatedSupplySource = "";
      estimatedSupplyNote = "";
    } else if (shouldResolveSupply) {
      const rpcSupply = await fetchCoinTotalSupplyRpc(coinType, shortCoinType).catch(() => null);
      applyRpcSupplyResult(rpcSupply);
    } else {
      supplyLookupPending = true;
      canonicalUnavailableReason = "Deferred on-chain lookup.";
    }

    const typeParts = coinType.split("::");
    const packageAddr = normalizeSuiAddress(typeParts[0] || "");
    const moduleName = typeParts[1] || "";
    const structName = typeParts[2] || "";
    const targetKey = coinTypeKey(coinType);

    if (app._coinClickHandler) app.removeEventListener("click", app._coinClickHandler);
    app._coinClickHandler = null;

    function readSupplySnapshot() {
      const canonicalKnown = canonicalSupplyRaw != null;
      const estimatedKnown = estimatedSupplyRaw != null;
      const canonicalExactRaw = canonicalKnown ? scaledBigIntToText(canonicalSupplyRaw, decimals, 8) : "";
      const canonicalApprox = canonicalKnown ? scaledBigIntAbsToApprox(canonicalSupplyRaw, decimals, 8) : NaN;
      const canonicalDisplay = canonicalKnown
        ? (Number.isFinite(canonicalApprox) ? fmtCompact(canonicalApprox) : canonicalExactRaw)
        : (supplyLookupPending ? "Loading..." : "Unknown");
      const estimatedExactRaw = estimatedKnown ? scaledBigIntToText(estimatedSupplyRaw, decimals, 8) : "";
      const estimatedApprox = estimatedKnown ? scaledBigIntAbsToApprox(estimatedSupplyRaw, decimals, 8) : NaN;
      const estimatedDisplay = estimatedKnown
        ? (Number.isFinite(estimatedApprox) ? fmtCompact(estimatedApprox) : estimatedExactRaw)
        : "—";
      const canonicalUnknownReason = canonicalUnavailableReason || "Unknown Supply: canonical total supply is not tracked for this coin type (TreasuryCap may be managed externally).";
      const canonicalStatSub = canonicalKnown
        ? `${symbol} units (${canonicalSupplySource || "coinMetadata.supply"})`
        : (supplyLookupPending
          ? "Resolving canonical supply from on-chain sources..."
          : (estimatedKnown ? `${canonicalUnknownReason} Estimated: ${estimatedDisplay} ${symbol} (derived).` : canonicalUnknownReason));
      const canonicalExact = canonicalKnown ? `${canonicalExactRaw} ${symbol}` : "Unknown";
      const canonicalSource = canonicalKnown
        ? `${canonicalSupplySource || "coinMetadata.supply"}${canonicalSupplyNote ? ` (${canonicalSupplyNote})` : ""}`
        : (supplyLookupPending ? "Pending on-chain lookup..." : canonicalUnknownReason);
      const estimatedExact = estimatedKnown ? `${estimatedExactRaw} ${symbol}` : "—";
      const estimatedSource = estimatedKnown
        ? `${estimatedSupplySource || "coinObjects.sum"}${estimatedSupplyNote ? ` (${estimatedSupplyNote})` : ""}`
        : "—";
      return {
        canonicalDisplay,
        canonicalStatSub,
        canonicalExact,
        canonicalSource,
        estimatedDisplay,
        estimatedExact,
        estimatedSource,
      };
    }

    function applySupplySnapshotToDom() {
      const snap = readSupplySnapshot();
      const statVal = document.getElementById("coin-supply-canonical-stat-value");
      const statSub = document.getElementById("coin-supply-canonical-stat-sub");
      const canonicalExactEl = document.getElementById("coin-supply-canonical-exact");
      const canonicalSourceEl = document.getElementById("coin-supply-canonical-source");
      const estExactEl = document.getElementById("coin-supply-estimate-exact");
      const estSourceEl = document.getElementById("coin-supply-estimate-source");
      if (statVal) statVal.textContent = snap.canonicalDisplay;
      if (statSub) statSub.textContent = snap.canonicalStatSub;
      if (canonicalExactEl) canonicalExactEl.textContent = snap.canonicalExact;
      if (canonicalSourceEl) canonicalSourceEl.textContent = snap.canonicalSource;
      if (estExactEl) estExactEl.textContent = snap.estimatedExact;
      if (estSourceEl) estSourceEl.textContent = snap.estimatedSource;
    }

    if (!shouldScanActivity) {
      const snap = readSupplySnapshot();
      app.innerHTML = `
        <div class="page-title">Coin Search <span class="type-tag">${escapeHtml(symbol)}</span></div>
        ${renderSearchCard(coinType)}

        <div class="card u-mb16">
          <div class="card-header">Coin Overview</div>
          <div class="card-body">
            <div class="stats-grid u-mb16">
              <div class="stat-box">
                <div class="stat-label">Symbol</div>
                <div class="stat-value">${escapeHtml(symbol)}</div>
                <div class="stat-sub">${escapeHtml(name)}</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Decimals</div>
                <div class="stat-value">${fmtNumber(decimals)}</div>
                <div class="stat-sub">from CoinMetadata/registry</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Canonical Supply</div>
                <div class="stat-value" id="coin-supply-canonical-stat-value">${escapeHtml(snap.canonicalDisplay)}</div>
                <div class="stat-sub" id="coin-supply-canonical-stat-sub">${escapeHtml(snap.canonicalStatSub)}</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Matched Tx</div>
                <div class="stat-value">—</div>
                <div class="stat-sub">Activity scan deferred</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Transfers</div>
                <div class="stat-value">—</div>
                <div class="stat-sub">Click Load Activity</div>
              </div>
              <div class="stat-box">
                <div class="stat-label">Events / Objects</div>
                <div class="stat-value">— / —</div>
                <div class="stat-sub">Click Load Activity</div>
              </div>
            </div>

            <div class="detail-grid">
              <div class="detail-row">
                <div class="detail-key">Coin Type</div>
                <div class="detail-val">
                  <span class="coin-type-text">${escapeHtml(coinType)}</span> ${copyBtn(coinType)}
                </div>
              </div>
              <div class="detail-row">
                <div class="detail-key">Package / Module / Struct</div>
                <div class="detail-val">
                  ${packageAddr ? hashLink(packageAddr, "/object/" + packageAddr) : "—"} :: ${escapeHtml(moduleName || "—")} :: ${escapeHtml(structName || "—")}
                </div>
              </div>
              <div class="detail-row">
                <div class="detail-key">Canonical Supply</div>
                <div class="detail-val" id="coin-supply-canonical-exact">${escapeHtml(snap.canonicalExact)}</div>
              </div>
              <div class="detail-row">
                <div class="detail-key">Canonical Source</div>
                <div class="detail-val" id="coin-supply-canonical-source">${escapeHtml(snap.canonicalSource)}</div>
              </div>
              <div class="detail-row">
                <div class="detail-key">Estimated Supply</div>
                <div class="detail-val" id="coin-supply-estimate-exact">${escapeHtml(snap.estimatedExact)}</div>
              </div>
              <div class="detail-row">
                <div class="detail-key">Estimate Basis</div>
                <div class="detail-val" id="coin-supply-estimate-source">${escapeHtml(snap.estimatedSource)}</div>
              </div>
              <div class="detail-row">
                <div class="detail-key">Scan Scope</div>
                <div class="detail-val">Not scanned yet.</div>
              </div>
            </div>
            ${iconUrl ? `<div class="u-fs12-dim u-mt8">Icon: <a class="hash-link" href="${escapeAttr(iconUrl)}" target="_blank" rel="noopener">coinMetadata.iconUrl</a></div>` : ""}
            <div class="coin-scan-note">
              Activity scan is deferred to improve first render (default mode: Fast).
              <button class="btn-surface-sm" data-action="coin-load-activity-fast">Load Fast Activity</button>
              <button class="btn-surface-sm" data-action="coin-load-activity-full">Load Full Activity</button>
              ${!shouldResolveSupply ? '<button class="btn-surface-sm" data-action="coin-load-supply">Load Supply</button>' : ""}
            </div>
          </div>
        </div>

        <div class="coin-activity-grid">
          <div class="card">
            <div class="card-header">Most Recent Transfers</div>
            <div class="card-body">${renderEmpty("Activity scan is deferred. Click Load Fast Activity or Load Full Activity.")}</div>
          </div>
          <div class="card">
            <div class="card-header">Most Recent Events</div>
            <div class="card-body">${renderEmpty("Activity scan is deferred. Click Load Fast Activity or Load Full Activity.")}</div>
          </div>
          <div class="card">
            <div class="card-header">Most Recent Object Changes</div>
            <div class="card-body">${renderEmpty("Activity scan is deferred. Click Load Fast Activity or Load Full Activity.")}</div>
          </div>
          <div class="card">
            <div class="card-header">Recent Matched Transactions</div>
            <div class="card-body">${renderEmpty("Activity scan is deferred. Click Load Fast Activity or Load Full Activity.")}</div>
          </div>
        </div>
      `;
      bindCoinSearchForm();
      app._coinClickHandler = async (ev) => {
        const trigger = ev.target?.closest?.("[data-action]");
        if (!trigger || !app.contains(trigger)) return;
        const action = trigger.getAttribute("data-action");
        if (action === "coin-load-supply") {
          ev.preventDefault();
          setRouteParams({ supply: "1" });
          await routeTo(getRoute());
          return;
        }
        if (action === "coin-load-activity-fast") {
          ev.preventDefault();
          setRouteParams({ scan: "1", supply: "1", mode: "fast", refresh: null });
          await routeTo(getRoute());
          return;
        }
        if (action === "coin-load-activity-full") {
          ev.preventDefault();
          setRouteParams({ scan: "1", supply: "1", mode: "full", refresh: null });
          await routeTo(getRoute());
        }
      };
      app.addEventListener("click", app._coinClickHandler);
      if (supplyLookupPending) {
        fetchCoinTotalSupplyRpc(coinType, shortCoinType).then((rpcSupply) => {
          applyRpcSupplyResult(rpcSupply);
          supplyLookupPending = false;
          applySupplySnapshotToDom();
        }).catch(() => {
          supplyLookupPending = false;
          canonicalUnavailableReason = "Supply lookup unavailable for this coin type.";
          applySupplySnapshotToDom();
        });
      }
      return;
    }

    const scanProfile = COIN_ACTIVITY_SCAN_MODE_CONFIG[scanMode] || COIN_ACTIVITY_SCAN_MODE_CONFIG.fast;
    const RESULT_LIMIT = Number(scanProfile.resultLimit || 50);
    const PAGE_SIZE = Number(scanProfile.pageSize || 20);
    const GLOBAL_SCAN_MAX_TX = Number(scanProfile.globalScanMaxTx || 60);
    const GLOBAL_SCAN_EMPTY_PAGE_THRESHOLD = Number(scanProfile.globalScanEmptyPageThreshold || 2);
    const OBJECT_SCAN_MAX_PAGES = Number(scanProfile.objectScanMaxPages || 6);
    const OBJECT_SCAN_MAX_DIGESTS = Number(scanProfile.objectScanMaxDigests || 160);
    const OBJECT_TX_LOAD_LIMIT = Number(scanProfile.objectTxLoadLimit || 48);
    const forceScanRefresh = routeParams.get("refresh") === "1";
    const scanCacheKey = `${targetKey}|mode:${scanMode}|v2`;
    const scanData = await coinSearchLoadActivityScanCached(scanCacheKey, { force: forceScanRefresh }, async () => {
      let scannedTx = 0;
      let scannedPages = 0;
      let before = null;
      let hasPreviousPage = true;
      let globalSupplementApplied = false;
      let globalScanEarlyStop = false;
      let objectDigestHasNext = false;
      const matchedTx = new Set();
      const processedDigests = new Set();
      let truncatedBalances = false;
      let truncatedEvents = false;
      let truncatedObjects = false;
      const transferRows = [];
      const eventRows = [];
      const objectRows = [];
      const matchedActivityRows = [];
      const MAX_CONTEXT_EVENTS_PER_TX = 8;
      let objectFallbackScannedObjects = 0;
      let objectFallbackScannedPages = 0;
      let objectFallbackConsideredDigests = 0;
      let objectFallbackLoadedTx = 0;

      function ingestCoinTransaction(tx) {
        const txDigest = String(tx?.digest || "");
        if (txDigest && processedDigests.has(txDigest)) return;
        if (txDigest) processedDigests.add(txDigest);
        const eff = tx?.effects || {};
        const txEvents = eff?.events?.nodes || [];
        const txAction = classifyTransactionAction(tx);
        const txActionLabel = String(txAction?.label || "");
        const txActionKey = normalizeActionKey(txAction);
        let txHasTransferMatch = false;
        let txHasObjectMatch = false;
        let txHasDirectEventMatch = false;
        let txHasContextEventMatch = false;
        let txObjectMatchCount = 0;
        let txBalanceMatchCount = 0;
        const contextualEventCandidates = [];

        const coinBalanceRows = (eff?.balanceChanges?.nodes || [])
          .filter((bc) => coinTypeKey(bc?.coinType?.repr || "") === targetKey);
        if (coinBalanceRows.length) {
          txHasTransferMatch = true;
          txBalanceMatchCount = coinBalanceRows.length;
          if (eff?.balanceChanges?.pageInfo?.hasNextPage) truncatedBalances = true;
          let sentRaw = 0n;
          let recvRaw = 0n;
          const fromRows = [];
          const toRows = [];
          for (const bc of coinBalanceRows) {
            const raw = parseBigIntSafe(bc?.amount || 0);
            const owner = normalizeSuiAddress(bc?.owner?.address || "");
            if (raw < 0n) {
              sentRaw += -raw;
              if (owner) fromRows.push(owner);
            } else if (raw > 0n) {
              recvRaw += raw;
              if (owner) toRows.push(owner);
            }
          }
          const amountRaw = sentRaw > recvRaw ? sentRaw : recvRaw;
          if (amountRaw > 0n) {
            const flow = classifyCoinTransferFlow(eff, targetKey, sentRaw, recvRaw, txAction);
            transferRows.push({
              digest: txDigest,
              timestamp: eff?.timestamp || "",
              status: eff?.status || "",
              fromRows,
              toRows,
              amountRaw,
              kind: flow.flowKind,
              actionLabel: flow.actionLabel,
              actionKey: flow.actionKey,
              actionSource: flow.actionSource,
              actionConfidence: flow.actionConfidence,
              baseKind: flow.baseKind,
              actionReasons: flow.reasons,
            });
          }
        }

        if (eff?.events?.pageInfo?.hasNextPage) truncatedEvents = true;
        for (const ev of txEvents) {
          const typeRepr = String(ev?.contents?.type?.repr || "");
          const json = ev?.contents?.json;
          const row = {
            digest: txDigest,
            timestamp: ev?.timestamp || eff?.timestamp || "",
            status: eff?.status || "",
            sender: normalizeSuiAddress(ev?.sender?.address || tx?.sender?.address || ""),
            typeRepr,
            moduleName: ev?.transactionModule?.name || "",
            modulePackage: normalizeSuiAddress(ev?.transactionModule?.package?.address || ""),
            jsonPreview: summarizeCoinJson(json),
          };
          if (moveTypeStringHasCoinType(typeRepr, targetKey) || valueHasCoinType(json, targetKey)) {
            txHasDirectEventMatch = true;
            eventRows.push({ ...row, matchSource: "direct" });
          } else {
            contextualEventCandidates.push(row);
          }
        }

        if (eff?.objectChanges?.pageInfo?.hasNextPage) truncatedObjects = true;
        for (const oc of (eff?.objectChanges?.nodes || [])) {
          const inputType = String(oc?.inputState?.asMoveObject?.contents?.type?.repr || "");
          const outputType = String(oc?.outputState?.asMoveObject?.contents?.type?.repr || "");
          if (!moveTypeStringHasCoinType(inputType, targetKey) && !moveTypeStringHasCoinType(outputType, targetKey)) continue;
          txHasObjectMatch = true;
          txObjectMatchCount += 1;
          const inputOwner = parseOwnerInfo(oc?.inputState?.owner);
          const outputOwner = parseOwnerInfo(oc?.outputState?.owner);
          const ownerAddress = outputOwner.address;
          const ownerKind = outputOwner.kind;
          const objectId = normalizeSuiAddress(oc?.address || oc?.idCreated || oc?.idDeleted || "");
          const typeRepr = outputType || inputType || "";
          objectRows.push({
            digest: txDigest,
            timestamp: eff?.timestamp || "",
            status: eff?.status || "",
            objectId,
            changeKind: oc?.idCreated ? "Created" : (oc?.idDeleted ? "Deleted" : "Mutated"),
            typeRepr,
            ownerAddress,
            ownerKind,
          });

          const ownerChanged = (
            (inputOwner.address || outputOwner.address || inputOwner.kind || outputOwner.kind) &&
            (inputOwner.address !== outputOwner.address || inputOwner.kind !== outputOwner.kind)
          );
          const isCoinObject = /::coin::Coin\s*</.test(typeRepr);
          if (ownerChanged && isCoinObject) {
            txHasTransferMatch = true;
            const fromRows = inputOwner.address ? [inputOwner.address] : [];
            const toRows = outputOwner.address ? [outputOwner.address] : [];
            transferRows.push({
              digest: txDigest,
              timestamp: eff?.timestamp || "",
              status: eff?.status || "",
              fromRows,
              toRows,
              amountRaw: null,
              kind: "object-transfer",
              fromHint: !fromRows.length ? (inputOwner.kind || "") : "",
              toHint: !toRows.length ? (outputOwner.kind || "") : "",
              actionLabel: txActionLabel,
              actionKey: txActionKey,
              actionSource: String(txAction?.source || ""),
              actionConfidence: String(txAction?.confidence || ""),
              baseKind: "object-transfer",
              actionReasons: txActionKey ? [`action:${txActionKey}`, "base:object-transfer"] : ["base:object-transfer"],
            });
          }
        }

        if (!txHasDirectEventMatch && contextualEventCandidates.length && (txHasTransferMatch || txHasObjectMatch)) {
          const contextRows = contextualEventCandidates.slice(0, MAX_CONTEXT_EVENTS_PER_TX);
          if (contextualEventCandidates.length > MAX_CONTEXT_EVENTS_PER_TX) truncatedEvents = true;
          for (const row of contextRows) eventRows.push({ ...row, matchSource: "context" });
          if (contextRows.length) txHasContextEventMatch = true;
        }

        const txHasMatch = txHasTransferMatch || txHasObjectMatch || txHasDirectEventMatch || txHasContextEventMatch;
        if (txHasMatch && txDigest) {
          matchedTx.add(txDigest);
          const signals = [];
          if (txBalanceMatchCount) signals.push(`${fmtNumber(txBalanceMatchCount)} balance`);
          if (txObjectMatchCount) signals.push(`${fmtNumber(txObjectMatchCount)} object`);
          if (txActionLabel) signals.push(txActionLabel.toLowerCase());
          if (txHasDirectEventMatch) signals.push("direct event");
          if (txHasContextEventMatch) signals.push("context events");
          matchedActivityRows.push({
            digest: txDigest,
            timestamp: eff?.timestamp || "",
            status: eff?.status || "",
            sender: normalizeSuiAddress(tx?.sender?.address || ""),
            signals: signals.join(" · "),
          });
        }
      }

      const sortRecent = (a, b) => {
        const diff = parseTsMs(b?.timestamp) - parseTsMs(a?.timestamp);
        if (diff !== 0) return diff;
        return String(b?.digest || "").localeCompare(String(a?.digest || ""));
      };

      try {
        const digestCandidates = await fetchCoinObjectDigestCandidates(coinType, {
          maxPages: OBJECT_SCAN_MAX_PAGES,
          maxDigests: OBJECT_SCAN_MAX_DIGESTS,
        });
        objectFallbackScannedObjects = digestCandidates?.sampledObjects || 0;
        objectFallbackScannedPages = digestCandidates?.pages || 0;
        objectDigestHasNext = !!digestCandidates?.hasNext;
        const candidates = (digestCandidates?.digests || []).filter(Boolean);
        objectFallbackConsideredDigests = candidates.length;
        if (candidates.length) {
          const metaRows = await fetchCoinTxMetaRowsByDigest(candidates);
          metaRows.sort(sortRecent);
          const topDigests = metaRows.map((row) => row.digest).filter(Boolean).slice(0, OBJECT_TX_LOAD_LIMIT);
          const txRows = await fetchCoinTxDetailsByDigest(topDigests);
          objectFallbackLoadedTx = txRows.length;
          for (const tx of txRows) ingestCoinTransaction(tx);
        }
      } catch (_) { /* ignore object-linked scan failures */ }

      const shouldRunGlobalSupplement = (
        objectDigestHasNext
        || objectFallbackLoadedTx < Math.min(24, OBJECT_TX_LOAD_LIMIT)
        || matchedTx.size < Math.max(16, Math.floor(RESULT_LIMIT / 3))
      );

      if (shouldRunGlobalSupplement) {
        globalSupplementApplied = true;
        let emptyPages = 0;
        while (hasPreviousPage && scannedTx < GLOBAL_SCAN_MAX_TX) {
          const data = await gql(`query($before: String) {
            transactions(last: ${PAGE_SIZE}, before: $before, filter: { kind: PROGRAMMABLE_TX }) {
              pageInfo { hasPreviousPage startCursor }
              nodes {
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
              }
            }
          }`, { before });

          const conn = data?.transactions;
          const txs = conn?.nodes || [];
          if (!txs.length) break;

          scannedTx += txs.length;
          scannedPages += 1;
          const matchedBefore = matchedTx.size;
          for (const tx of txs) ingestCoinTransaction(tx);
          const gainedMatches = matchedTx.size > matchedBefore;
          emptyPages = gainedMatches ? 0 : (emptyPages + 1);

          hasPreviousPage = !!conn?.pageInfo?.hasPreviousPage;
          before = conn?.pageInfo?.startCursor || null;

          if (transferRows.length >= RESULT_LIMIT && eventRows.length >= RESULT_LIMIT && objectRows.length >= RESULT_LIMIT) break;
          if (emptyPages >= GLOBAL_SCAN_EMPTY_PAGE_THRESHOLD && matchedTx.size > 0) {
            globalScanEarlyStop = true;
            break;
          }
        }
      }

      transferRows.sort(sortRecent);
      eventRows.sort(sortRecent);
      objectRows.sort(sortRecent);
      matchedActivityRows.sort(sortRecent);
      const transfers = transferRows.slice(0, RESULT_LIMIT);
      const events = eventRows.slice(0, RESULT_LIMIT);
      const objects = objectRows.slice(0, RESULT_LIMIT);
      const matchedActivity = matchedActivityRows.slice(0, RESULT_LIMIT);

      const scanLimitReached = scannedTx >= GLOBAL_SCAN_MAX_TX && hasPreviousPage;
      const notes = [];
      if (objectDigestHasNext) notes.push(`Object-linked scan hit cap at ${fmtNumber(objectFallbackScannedObjects)} Coin objects; older activity may exist.`);
      if (scanLimitReached) notes.push(`Supplemental scan hit cap at ${fmtNumber(GLOBAL_SCAN_MAX_TX)} programmable transactions.`);
      if (globalSupplementApplied && scannedTx > 0) {
        notes.push(`Supplemental scan inspected ${fmtNumber(scannedTx)} programmable transactions across ${fmtNumber(scannedPages)} pages.`);
      }
      if (globalScanEarlyStop) notes.push("Supplemental scan stopped early after consecutive pages without new coin matches.");
      if (truncatedBalances || truncatedEvents || truncatedObjects) {
        const fields = [];
        if (truncatedBalances) fields.push("balanceChanges");
        if (truncatedEvents) fields.push("events");
        if (truncatedObjects) fields.push("objectChanges");
        notes.push(`Some matched transactions exceed per-query page size for ${fields.join(", ")}.`);
      }
      const usedObjectScan = objectFallbackLoadedTx > 0;
      if (usedObjectScan) {
        notes.push(`Object-linked scan sampled ${fmtNumber(objectFallbackScannedObjects)} Coin objects across ${fmtNumber(objectFallbackScannedPages)} pages and loaded ${fmtNumber(objectFallbackLoadedTx)} transactions.`);
      } else if (!transferRows.length && !eventRows.length && !objectRows.length && objectFallbackScannedObjects > 0) {
        notes.push(`Object-linked scan sampled ${fmtNumber(objectFallbackScannedObjects)} Coin objects but did not find recent transactions in the sample.`);
      }
      const directEventCount = events.filter((row) => row.matchSource === "direct").length;
      const contextEventCount = events.length - directEventCount;
      const transferEmptyLabel = matchedTx.size
        ? "No balance-change or coin-object ownership transfers found in sampled data. Recent activity can still appear in events/object changes below."
        : "No recent transfers found for this coin type in sampled data.";
      const eventEmptyLabel = matchedTx.size
        ? "No events directly referenced this coin type in sampled data."
        : "No recent events referencing this coin type in sampled data.";

      return {
        scanMode,
        resultLimit: RESULT_LIMIT,
        scannedTx,
        scannedPages,
        objectFallbackScannedObjects,
        objectFallbackScannedPages,
        objectFallbackConsideredDigests,
        objectFallbackLoadedTx,
        matchedTxCount: matchedTx.size,
        directEventCount,
        contextEventCount,
        transferEmptyLabel,
        eventEmptyLabel,
        notes,
        objectDigestHasNext,
        globalSupplementApplied,
        globalScanEarlyStop,
        truncatedBalances,
        truncatedEvents,
        truncatedObjects,
        scanLimitReached,
        usedObjectScan,
        transfers,
        events,
        objects,
        matchedActivity,
      };
    });
    const transfers = Array.isArray(scanData?.transfers) ? scanData.transfers : [];
    const events = Array.isArray(scanData?.events) ? scanData.events : [];
    const objects = Array.isArray(scanData?.objects) ? scanData.objects : [];
    const matchedActivity = Array.isArray(scanData?.matchedActivity) ? scanData.matchedActivity : [];
    const notes = Array.isArray(scanData?.notes) ? scanData.notes : [];
    const directEventCount = Number(scanData?.directEventCount || 0);
    const contextEventCount = Number(scanData?.contextEventCount || Math.max(0, events.length - directEventCount));
    const matchedTxCount = Number(scanData?.matchedTxCount || 0);
    const scannedTx = Number(scanData?.scannedTx || 0);
    const scannedPages = Number(scanData?.scannedPages || 0);
    const objectFallbackScannedObjects = Number(scanData?.objectFallbackScannedObjects || 0);
    const objectFallbackScannedPages = Number(scanData?.objectFallbackScannedPages || 0);
    const objectFallbackConsideredDigests = Number(scanData?.objectFallbackConsideredDigests || 0);
    const objectFallbackLoadedTx = Number(scanData?.objectFallbackLoadedTx || 0);
    const transferEmptyLabel = String(scanData?.transferEmptyLabel || "No recent transfers found for this coin type in sampled data.");
    const eventEmptyLabel = String(scanData?.eventEmptyLabel || "No recent events referencing this coin type in sampled data.");
    const activeMode = getCoinActivityScanMode(scanData?.scanMode || scanMode);
    const modeLabel = COIN_ACTIVITY_SCAN_MODE_CONFIG[activeMode]?.label || "Fast";
    const encodedCoinType = encodeURIComponent(coinType);
    const fastScanHref = `#/coin?type=${encodedCoinType}&scan=1&supply=1&mode=fast`;
    const fullScanHref = `#/coin?type=${encodedCoinType}&scan=1&supply=1&mode=full`;
    const refreshScanHref = `#/coin?type=${encodedCoinType}&scan=1&supply=1&mode=${encodeURIComponent(activeMode)}&refresh=1`;
    if (!notes.some((row) => String(row || "").toLowerCase().includes("scan mode"))) {
      notes.unshift(`Scan mode: ${modeLabel} (object pages ≤ ${fmtNumber(OBJECT_SCAN_MAX_PAGES)}, object digest candidates ≤ ${fmtNumber(OBJECT_SCAN_MAX_DIGESTS)}, supplemental programmable txs ≤ ${fmtNumber(GLOBAL_SCAN_MAX_TX)}).`);
    }
    const snap = readSupplySnapshot();

    app.innerHTML = `
      <div class="page-title">Coin Search <span class="type-tag">${escapeHtml(symbol)}</span></div>
      ${renderSearchCard(coinType)}

      <div class="card u-mb16">
        <div class="card-header">Coin Overview</div>
        <div class="card-body">
          <div class="stats-grid u-mb16">
            <div class="stat-box">
              <div class="stat-label">Symbol</div>
              <div class="stat-value">${escapeHtml(symbol)}</div>
              <div class="stat-sub">${escapeHtml(name)}</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Decimals</div>
              <div class="stat-value">${fmtNumber(decimals)}</div>
              <div class="stat-sub">from CoinMetadata/registry</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Canonical Supply</div>
              <div class="stat-value">${escapeHtml(snap.canonicalDisplay)}</div>
              <div class="stat-sub">${escapeHtml(snap.canonicalStatSub)}</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Matched Tx</div>
              <div class="stat-value">${fmtNumber(matchedTxCount)}</div>
              <div class="stat-sub">from ${fmtNumber(objectFallbackLoadedTx)} object-linked txs${scannedTx ? ` + ${fmtNumber(scannedTx)} supplemental txs` : ""}</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Transfers</div>
              <div class="stat-value">${fmtNumber(transfers.length)}</div>
              <div class="stat-sub">recent rows</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Events / Objects</div>
              <div class="stat-value">${fmtNumber(events.length)} / ${fmtNumber(objects.length)}</div>
              <div class="stat-sub">${fmtNumber(directEventCount)} direct · ${fmtNumber(contextEventCount)} context</div>
            </div>
          </div>

          <div class="detail-grid">
            <div class="detail-row">
              <div class="detail-key">Coin Type</div>
              <div class="detail-val">
                <span class="coin-type-text">${escapeHtml(coinType)}</span> ${copyBtn(coinType)}
              </div>
            </div>
            <div class="detail-row">
              <div class="detail-key">Package / Module / Struct</div>
              <div class="detail-val">
                ${packageAddr ? hashLink(packageAddr, "/object/" + packageAddr) : "—"} :: ${escapeHtml(moduleName || "—")} :: ${escapeHtml(structName || "—")}
              </div>
            </div>
            <div class="detail-row">
              <div class="detail-key">Canonical Supply</div>
              <div class="detail-val">${escapeHtml(snap.canonicalExact)}</div>
            </div>
            <div class="detail-row">
              <div class="detail-key">Canonical Source</div>
              <div class="detail-val">${escapeHtml(snap.canonicalSource)}</div>
            </div>
            <div class="detail-row">
              <div class="detail-key">Estimated Supply</div>
              <div class="detail-val">${escapeHtml(snap.estimatedExact)}</div>
            </div>
            <div class="detail-row">
              <div class="detail-key">Estimate Basis</div>
              <div class="detail-val">${escapeHtml(snap.estimatedSource)}</div>
            </div>
            <div class="detail-row">
              <div class="detail-key">Scan Scope</div>
              <div class="detail-val">
                ${escapeHtml(modeLabel)} mode:
                ${fmtNumber(objectFallbackScannedObjects)} Coin objects across ${fmtNumber(objectFallbackScannedPages)} pages (${fmtNumber(objectFallbackConsideredDigests)} candidate tx digests, ${fmtNumber(objectFallbackLoadedTx)} loaded txs)
                ${scannedTx ? `; supplemental programmable scan ${fmtNumber(scannedTx)} txs across ${fmtNumber(scannedPages)} pages` : ""}
              </div>
            </div>
          </div>
          ${iconUrl ? `<div class="u-fs12-dim u-mt8">Icon: <a class="hash-link" href="${escapeAttr(iconUrl)}" target="_blank" rel="noopener">coinMetadata.iconUrl</a></div>` : ""}
          ${notes.length ? `<div class="coin-scan-note">${notes.map(n => escapeHtml(n)).join(" ")}</div>` : ""}
          <div class="coin-scan-note">
            Activity scan mode:
            <span class="badge">${escapeHtml(modeLabel)}</span>
            <a class="btn-surface-sm" href="${fastScanHref}">Fast</a>
            <a class="btn-surface-sm" href="${fullScanHref}">Full</a>
            <a class="btn-surface-sm" href="${refreshScanHref}">Refresh</a>
          </div>
        </div>
      </div>

      <div class="coin-activity-grid">
        <div class="card">
          <div class="card-header">Most Recent Transfers</div>
          <div class="card-body">
            ${transfers.length ? `<table>
              <thead><tr><th>Kind</th><th>Action</th><th class="u-ta-right">Amount</th><th>From</th><th>To</th><th>Tx</th><th>Time</th></tr></thead>
              <tbody>
                ${transfers.map((row) => {
                  const kindMeta = getCoinTransferKindMeta(row.kind, row);
                  return `<tr>
                    <td><span class="coin-transfer-kind coin-transfer-kind-${kindMeta.kindClass}">${kindMeta.kindLabel}</span></td>
                    <td>${row.actionLabel ? `<span class="badge badge-success">${escapeHtml(row.actionLabel)}</span>` : '<span class="u-c-dim">—</span>'}</td>
                    <td class="u-ta-right-mono">${row.amountRaw == null ? '<span class="u-c-dim">Unknown</span>' : fmtCoinAbs(row.amountRaw, decimals)}</td>
                    <td>${renderAddressList(row.fromRows, kindMeta.fromFallback)}</td>
                    <td>${renderAddressList(row.toRows, kindMeta.toFallback)}</td>
                    <td>${row.digest ? hashLink(row.digest, "/tx/" + row.digest) : '<span class="u-c-dim">—</span>'}</td>
                    <td>${timeTag(row.timestamp)}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>` : renderEmpty(transferEmptyLabel)}
          </div>
        </div>

        <div class="card">
          <div class="card-header">Most Recent Events</div>
          <div class="card-body">
            ${events.length ? `<table>
              <thead><tr><th>Match</th><th>Event Type</th><th>Sender</th><th>Module</th><th>Tx</th><th>Time</th><th>Payload</th></tr></thead>
              <tbody>
                ${events.map((row) => {
                  const typeLabel = shortType(row.typeRepr) || row.typeRepr || "—";
                  const moduleLabel = row.modulePackage
                    ? `${hashLink(row.modulePackage, "/object/" + row.modulePackage)}::${escapeHtml(row.moduleName || "—")}`
                    : escapeHtml(row.moduleName || "—");
                  return `<tr>
                    <td><span class="badge ${row.matchSource === "direct" ? "badge-success" : ""}">${row.matchSource === "direct" ? "direct" : "context"}</span></td>
                    <td class="coin-type-cell" title="${escapeAttr(row.typeRepr || "")}">${escapeHtml(typeLabel)}</td>
                    <td>${row.sender ? hashLink(row.sender, "/address/" + row.sender) : '<span class="u-c-dim">—</span>'}</td>
                    <td>${moduleLabel}</td>
                    <td>${row.digest ? hashLink(row.digest, "/tx/" + row.digest) : '<span class="u-c-dim">—</span>'}</td>
                    <td>${timeTag(row.timestamp)}</td>
                    <td class="coin-json-preview">${row.jsonPreview ? escapeHtml(row.jsonPreview) : '<span class="u-c-dim">—</span>'}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>` : renderEmpty(eventEmptyLabel)}
          </div>
        </div>

        <div class="card">
          <div class="card-header">Most Recent Object Changes</div>
          <div class="card-body">
            ${objects.length ? `<table>
              <thead><tr><th>Object</th><th>Change</th><th>Type</th><th>Owner</th><th>Tx</th><th>Time</th></tr></thead>
              <tbody>
                ${objects.map((row) => {
                  const ownerLabel = row.ownerKind === "shared"
                    ? '<span class="badge">Shared</span>'
                    : (row.ownerKind === "immutable"
                      ? '<span class="badge">Immutable</span>'
                      : (row.ownerAddress ? hashLink(row.ownerAddress, "/address/" + row.ownerAddress) : '<span class="u-c-dim">—</span>'));
                  const changeClass = row.changeKind === "Created"
                    ? "badge-success"
                    : (row.changeKind === "Deleted" ? "badge-fail" : "");
                  return `<tr>
                    <td>${row.objectId ? hashLink(row.objectId, "/object/" + row.objectId) : '<span class="u-c-dim">—</span>'}</td>
                    <td><span class="badge ${changeClass}">${escapeHtml(row.changeKind)}</span></td>
                    <td class="coin-type-cell" title="${escapeAttr(row.typeRepr || "")}">${escapeHtml(shortType(row.typeRepr) || row.typeRepr || "—")}</td>
                    <td>${ownerLabel}</td>
                    <td>${row.digest ? hashLink(row.digest, "/tx/" + row.digest) : '<span class="u-c-dim">—</span>'}</td>
                    <td>${timeTag(row.timestamp)}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>` : renderEmpty("No recent object changes containing this coin type in sampled data.")}
          </div>
        </div>

        <div class="card">
          <div class="card-header">Recent Matched Transactions</div>
          <div class="card-body">
            ${matchedActivity.length ? `<table>
              <thead><tr><th>Tx</th><th>Sender</th><th>Signals</th><th>Status</th><th>Time</th></tr></thead>
              <tbody>
                ${matchedActivity.map((row) => `<tr>
                  <td>${row.digest ? hashLink(row.digest, "/tx/" + row.digest) : '<span class="u-c-dim">—</span>'}</td>
                  <td>${row.sender ? hashLink(row.sender, "/address/" + row.sender) : '<span class="u-c-dim">—</span>'}</td>
                  <td>${row.signals ? escapeHtml(row.signals) : '<span class="u-c-dim">—</span>'}</td>
                  <td>${statusBadge(row.status)}</td>
                  <td>${timeTag(row.timestamp)}</td>
                </tr>`).join("")}
              </tbody>
            </table>` : renderEmpty("No matched transactions found for this coin type in sampled data.")}
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    app.innerHTML = `
      <div class="page-title">Coin Search</div>
      ${renderSearchCard(coinType)}
      <div class="card">
        <div class="card-body">
          ${renderEmpty(`Failed to load coin activity: ${escapeHtml(e?.message || String(e))}`)}
        </div>
      </div>
    `;
  }

  bindCoinSearchForm();
}

// ── Top Token Transfers ────────────────────────────────────────────────
const TRACKED_TOKENS = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI": "SUI",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": "USDC",
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP": "DEEP",
  "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL": "WAL",
};

async function renderTransfers(app) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const data = await gql(`{
    transactions(last: 50, filter: { kind: PROGRAMMABLE_TX }) {
      nodes {
        digest
        sender { address }
        effects {
          status timestamp
          balanceChanges(first: 50) {
            nodes { ${GQL_F_BAL_NODE} }
          }
        }
      }
    }
  }`);

  const txs = (data.transactions?.nodes || []).reverse();
  syncPeggedPrices();
  const trackedCoinTypes = [...new Set(txs.flatMap(tx =>
    (tx.effects?.balanceChanges?.nodes || [])
      .map(bc => bc.coinType?.repr)
      .filter(ct => ct && TRACKED_TOKENS[ct])
  ))];
  let pricesLoading = false;

  function unresolvedTransferCoinTypes() {
    syncPeggedPrices();
    return trackedCoinTypes.filter((ct) => {
      const resolved = resolveCoinType(ct);
      return !(Number(defiPrices[resolved.symbol] || 0) > 0);
    });
  }

  function buildTransferSnapshot() {
    syncPeggedPrices();
    const transfers = [];
    const tokenCounts = {};
    let largest = { usd: 0, symbol: "", amount: 0 };

    // Group balance changes per tx per coin type to pair senders and receivers
    for (const tx of txs) {
      const bcs = tx.effects?.balanceChanges?.nodes || [];
      const byCoin = {};
      for (const bc of bcs) {
        const ct = bc.coinType?.repr;
        if (!ct || !TRACKED_TOKENS[ct]) continue;
        if (!byCoin[ct]) byCoin[ct] = [];
        byCoin[ct].push(bc);
      }
      for (const [ct, changes] of Object.entries(byCoin)) {
        const symbol = TRACKED_TOKENS[ct];
        const resolved = resolveCoinType(ct);
        const price = Number(defiPrices[symbol] || 0);
        const senders = changes.filter(c => Number(c.amount) < 0);
        const receivers = changes.filter(c => Number(c.amount) > 0);
        const totalSent = senders.reduce((s, c) => s + Math.abs(Number(c.amount)), 0);
        const humanAmount = totalSent / Math.pow(10, resolved.decimals);
        const usdValue = humanAmount * price;
        if (humanAmount === 0) continue;
        tokenCounts[symbol] = (tokenCounts[symbol] || 0) + 1;
        if (usdValue > largest.usd) largest = { usd: usdValue, symbol, amount: humanAmount };
        transfers.push({
          symbol, humanAmount, usdValue,
          from: senders.length ? senders[0].owner?.address : tx.sender?.address,
          to: receivers.length ? receivers[0].owner?.address : null,
          multiFrom: senders.length > 1 ? senders.map(s => s.owner?.address) : null,
          multiTo: receivers.length > 1 ? receivers.map(r => r.owner?.address) : null,
          digest: tx.digest, timestamp: tx.effects?.timestamp,
        });
      }
    }

    transfers.sort((a, b) => b.usdValue - a.usdValue);
    return {
      transfers,
      tokenEntries: Object.entries(tokenCounts).sort((a, b) => b[1] - a[1]),
      largest,
    };
  }

  function renderContent() {
    const { transfers, tokenEntries, largest } = buildTransferSnapshot();
    const pricingPending = pricesLoading && unresolvedTransferCoinTypes().length > 0;
    return `
      <div class="page-title">Top Token Transfers <span class="type-tag">Recent</span></div>
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">Total Transfers</div>
          <div class="stat-value">${fmtNumber(transfers.length)}</div>
          <div class="stat-sub">From ${txs.length} recent txs</div>
        </div>
        ${tokenEntries.map(([sym, count]) => {
          const price = Number(defiPrices[sym] || 0);
          const priceLabel = price > 0
            ? `$${price.toFixed(sym === "SUI" || sym === "DEEP" || sym === "WAL" ? 4 : 2)}`
            : (pricingPending ? "Loading price..." : "Price unavailable");
          return `
            <div class="stat-box">
              <div class="stat-label">${sym}</div>
              <div class="stat-value">${fmtNumber(count)}</div>
              <div class="stat-sub">${priceLabel}</div>
            </div>
          `;
        }).join("")}
        <div class="stat-box">
          <div class="stat-label">Largest Transfer</div>
          <div class="stat-value u-c-green">${largest.usd > 0 ? `$${fmtCompact(largest.usd)}` : "—"}</div>
          <div class="stat-sub">${largest.usd > 0
            ? `${largest.amount.toLocaleString(undefined, {maximumFractionDigits: 2})} ${largest.symbol}`
            : (pricingPending ? "Pricing recent transfers..." : "Price unavailable")}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">Transfers by USD Value</div>
        <div class="card-body">
          ${transfers.length ? `<table>
            <thead><tr><th>Token</th><th class="u-ta-right">Amount</th><th class="u-ta-right">USD Value</th><th>From</th><th>To</th><th>Tx</th><th>Time</th></tr></thead>
            <tbody>
              ${transfers.slice(0, 100).map(t => {
                const amtFmt = t.humanAmount < 0.001 ? t.humanAmount.toExponential(2) : t.humanAmount.toLocaleString(undefined, {maximumFractionDigits: 4});
                const fromLabel = t.multiFrom ? `${hashLink(t.from, '/address/' + t.from)} <span class="u-fs10-dim">+${t.multiFrom.length - 1}</span>` : (t.from ? hashLink(t.from, '/address/' + t.from) : "—");
                const toLabel = t.multiTo ? `${hashLink(t.to, '/address/' + t.to)} <span class="u-fs10-dim">+${t.multiTo.length - 1}</span>` : (t.to ? hashLink(t.to, '/address/' + t.to) : '<span class="u-c-dim">contract</span>');
                const usdLabel = t.usdValue > 0
                  ? `$${t.usdValue < 0.01 ? t.usdValue.toFixed(4) : fmtCompact(t.usdValue)}`
                  : (pricingPending ? '<span class="u-c-dim">Loading...</span>' : '<span class="u-c-dim">—</span>');
                return `<tr>
                  <td class="u-fw-600">${t.symbol}</td>
                  <td class="u-ta-right-mono">${amtFmt}</td>
                  <td style="text-align:right;font-family:var(--mono);color:var(--green)">${usdLabel}</td>
                  <td>${fromLabel}</td>
                  <td>${toLabel}</td>
                  <td>${hashLink(t.digest, '/tx/' + t.digest)}</td>
                  <td>${timeTag(t.timestamp)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty("No token transfers found in recent transactions.")}
        </div>
      </div>
    `;
  }

  async function hydrateTransferPrices(force = false) {
    const missing = unresolvedTransferCoinTypes();
    if (!missing.length || pricesLoading) return;
    pricesLoading = true;
    if (isActiveRoute()) app.innerHTML = renderContent();
    try {
      await fetchDefiPrices(force);
      await ensurePrices(missing);
    } catch (_) {
      // Keep the shell rendered even if pricing enrichment fails.
    } finally {
      pricesLoading = false;
      if (isActiveRoute()) app.innerHTML = renderContent();
    }
  }

  app.innerHTML = renderContent();
  if (unresolvedTransferCoinTypes().length) hydrateTransferPrices(false).catch(() => null);
}

// ── Validators / Staking ────────────────────────────────────────────────
async function renderValidators(app, opts = {}) {
  const fullMode = !!opts?.full;
  const seed = opts?.seed || null;
  const toValidatorRow = (v) => {
    const j = v?.contents?.json || {};
    const meta = j.metadata || {};
    const pool = j.staking_pool || {};
    const suiBal = Number(pool.sui_balance || 0);
    const rewards = Number(pool.rewards_pool || 0);
    const poolTokens = Number(pool.pool_token_balance || 0);
    const exchangeRate = poolTokens > 0 ? suiBal / poolTokens : 1;
    const pendingStake = Number(pool.pending_stake || 0);
    const pendingWithdraw = Number(pool.pending_total_sui_withdraw || 0);
    const nextEpochStake = Number(j.next_epoch_stake || 0);
    const nextGasPrice = Number(j.next_epoch_gas_price || 0);
    const nextCommission = Number(j.next_epoch_commission_rate || 0);
    return {
      name: meta.name || "Unknown",
      address: meta.sui_address || "",
      description: meta.description || "",
      imageUrl: meta.image_url || "",
      projectUrl: meta.project_url || "",
      votingPower: Number(j.voting_power || 0),
      gasPrice: Number(j.gas_price || 0),
      commission: Number(j.commission_rate || 0),
      stake: suiBal,
      rewards,
      exchangeRate,
      poolTokens,
      pendingStake,
      pendingWithdraw,
      nextEpochStake,
      nextGasPrice,
      nextCommission,
      activationEpoch: Number(pool.activation_epoch || 0),
      atRisk: v?.atRisk || 0,
    };
  };

  if (!fullMode) {
    app.innerHTML = `<div class="page-title">Validators</div><div class="card"><div class="card-body">${renderLoading()}</div></div>`;
    const firstPage = await gql(`{
      epoch {
        epochId
        startTimestamp
        referenceGasPrice
        validatorSet {
          activeValidators(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes { atRisk contents { json } }
          }
        }
      }
    }`);
    const ep = firstPage?.epoch || {};
    const firstConn = ep?.validatorSet?.activeValidators || {};
    const firstNodes = firstConn?.nodes || [];
    const quickValidators = firstNodes.map(toValidatorRow).sort((a, b) => b.stake - a.stake);
    const quickStake = quickValidators.reduce((s, v) => s + v.stake, 0);
    app.innerHTML = `
      <div class="page-title">Validators <span class="type-tag">Epoch ${fmtNumber(ep.epochId)}</span></div>
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">Loaded Validators</div>
          <div class="stat-value">${fmtNumber(quickValidators.length)}</div>
          <div class="stat-sub">${firstConn?.pageInfo?.hasNextPage ? "Loading remaining pages..." : "Page 1 complete"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Loaded Stake</div>
          <div class="stat-value">${fmtCompact(quickStake / 1e9)}</div>
          <div class="stat-sub">SUI (partial)</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Reference Gas Price</div>
          <div class="stat-value">${fmtNumber(ep.referenceGasPrice)}</div>
          <div class="stat-sub">MIST</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">Validator Set (Progressive Load)</div>
        <div class="card-body">
          <div class="u-fs12-dim u-mb12">Rendering first validator page immediately. Full analytics and remaining validators are loading in background.</div>
          <table>
            <thead><tr><th>#</th><th>Validator</th><th class="u-ta-right">Stake (SUI)</th><th class="u-ta-right">Voting %</th><th class="u-ta-right">Commission</th><th class="u-ta-right">Gas Price</th></tr></thead>
            <tbody>
              ${quickValidators.map((v, i) => `<tr>
                <td class="u-c-dim">${i + 1}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    ${v.imageUrl ? `<img src="${v.imageUrl}" data-hide-on-error="1" style="width:20px;height:20px;border-radius:50%;object-fit:cover">` : ""}
                    <div>
                      <div style="font-weight:500">${v.name}</div>
                      <div class="u-fs11-dim">${truncHash(v.address)}</div>
                    </div>
                  </div>
                </td>
                <td class="u-ta-right-mono">${fmtCompact(v.stake / 1e9)}</td>
                <td class="u-ta-right-mono">${(v.votingPower / 100).toFixed(2)}%</td>
                <td class="u-ta-right-mono">${(v.commission / 100).toFixed(1)}%</td>
                <td class="u-ta-right-mono">${fmtNumber(v.gasPrice)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
    Promise.resolve().then(() => renderValidators(app, {
      full: true,
      seed: {
        epochId: ep?.epochId,
        referenceGasPrice: ep?.referenceGasPrice,
        startTimestamp: ep?.startTimestamp,
        nodes: firstNodes,
        hasNextPage: !!firstConn?.pageInfo?.hasNextPage,
        endCursor: firstConn?.pageInfo?.endCursor || null,
      },
    })).catch(() => null);
    return;
  }

  app.innerHTML = `<div class="page-title">Validators</div><div class="card"><div class="card-body">${renderLoading()}</div></div>`;
  // Fetch current epoch validators (paginated) + previous epoch for APY + epoch economics
  let allValNodes = Array.isArray(seed?.nodes) ? [...seed.nodes] : [];
  let cursor = seed?.endCursor || null;
  let epochId = Number(seed?.epochId || 0);
  let refGas = seed?.referenceGasPrice || "0";
  let startTs = seed?.startTimestamp || "";
  if (!allValNodes.length) {
    const firstPage = await gql(`{
      epoch {
        epochId
        startTimestamp
        referenceGasPrice
        validatorSet {
          activeValidators(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes { atRisk contents { json } }
          }
        }
      }
    }`);
    const ep = firstPage?.epoch || {};
    const firstConn = ep?.validatorSet?.activeValidators || {};
    epochId = Number(ep?.epochId || 0);
    refGas = ep?.referenceGasPrice || "0";
    startTs = ep?.startTimestamp || "";
    allValNodes = firstConn?.nodes || [];
    cursor = firstConn?.pageInfo?.hasNextPage ? (firstConn?.pageInfo?.endCursor || null) : null;
  }
  for (let page = 0; page < 5 && cursor; page++) {
    const afterClause = cursor ? `, after: "${cursor}"` : "";
    const q = `{ epoch { epochId startTimestamp referenceGasPrice validatorSet { activeValidators(first: 50${afterClause}) { pageInfo { hasNextPage endCursor } nodes { atRisk contents { json } } } } } }`;
    const curEpoch = await gql(q);
    epochId = curEpoch.epoch.epochId;
    refGas = curEpoch.epoch.referenceGasPrice;
    startTs = curEpoch.epoch.startTimestamp;
    const av = curEpoch.epoch.validatorSet?.activeValidators;
    allValNodes.push(...(av?.nodes || []));
    if (!av?.pageInfo?.hasNextPage) break;
    cursor = av.pageInfo.endCursor;
  }
  // Fetch previous epoch for APY + economics
  const prevEpoch = await gql(`{ epoch(epochId: ${epochId - 1}) {
    totalStakeRewards totalStakeSubsidies totalGasFees fundSize
    fundInflow fundOutflow netInflow
    totalTransactions totalCheckpoints
    startTimestamp endTimestamp
  } }`);
  const prev = prevEpoch.epoch;

  const validators = allValNodes.map((v) => toValidatorRow(v)).sort((a, b) => b.stake - a.stake);

  const totalStake = validators.reduce((s, v) => s + v.stake, 0);
  const totalRewardsPool = validators.reduce((s, v) => s + v.rewards, 0);
  const totalPendingStake = validators.reduce((s, v) => s + v.pendingStake, 0);
  const totalPendingWithdraw = validators.reduce((s, v) => s + v.pendingWithdraw, 0);

  // Network APY from previous completed epoch
  const prevRewards = Number(prev?.totalStakeRewards || 0);
  const prevSubsidies = Number(prev?.totalStakeSubsidies || 0);
  const prevGasFees = Number(prev?.totalGasFees || 0);
  const prevFundSize = Number(prev?.fundSize || 0);
  const prevFundInflow = Number(prev?.fundInflow || 0);
  const prevFundOutflow = Number(prev?.fundOutflow || 0);
  const prevNetInflow = Number(prev?.netInflow || 0);
  const prevTxs = Number(prev?.totalTransactions || 0);
  const prevCheckpoints = Number(prev?.totalCheckpoints || 0);
  const epochDurationMs = prev?.endTimestamp && prev?.startTimestamp
    ? new Date(prev.endTimestamp).getTime() - new Date(prev.startTimestamp).getTime() : 86400000;
  const epochDurationHrs = epochDurationMs / 3600000;
  const epochsPerYear = (365.25 * 24 * 3600 * 1000) / epochDurationMs;
  const networkApy = totalStake > 0 ? (prevRewards / totalStake) * epochsPerYear * 100 : 0;

  // Epoch elapsed
  const epochElapsedMs = Date.now() - new Date(startTs).getTime();
  const epochElapsedHrs = epochElapsedMs / 3600000;
  const epochProgress = Math.min(100, (epochElapsedHrs / epochDurationHrs) * 100);

  // Gas price distribution
  const gasPrices = validators.map(v => v.gasPrice);
  const medianGas = gasPrices.sort((a, b) => a - b)[Math.floor(gasPrices.length / 2)];
  const minGas = Math.min(...gasPrices);
  const maxGas = Math.max(...gasPrices);

  // Gas price histogram bins (grouped by 50 MIST)
  const gasBinned = {};
  for (const gp of gasPrices) {
    const bin = Math.floor(gp / 50) * 50;
    gasBinned[bin] = (gasBinned[bin] || 0) + 1;
  }
  const gasBins = Object.entries(gasBinned).map(([price, count]) => ({ price: Number(price), count })).sort((a, b) => a.price - b.price);
  const maxBinCount = Math.max(...gasBins.map(b => b.count), 1);

  app.innerHTML = `
    <div class="page-title">Validators <span class="type-tag">Epoch ${epochId}</span></div>

    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Active Validators</div>
        <div class="stat-value">${validators.length}</div>
        <div class="stat-sub">${validators.filter(v => v.atRisk > 0).length} at risk</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Total Stake</div>
        <div class="stat-value">${fmtCompact(totalStake / 1e9)}</div>
        <div class="stat-sub">SUI</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Network APY</div>
        <div class="stat-value u-c-green">${networkApy.toFixed(2)}%</div>
        <div class="stat-sub">epoch ${epochId - 1} rewards</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Reference Gas Price</div>
        <div class="stat-value">${fmtNumber(refGas)}</div>
        <div class="stat-sub">MIST</div>
      </div>
    </div>

    <div class="card u-mb16">
      <div class="card-header">Epoch Economics <span class="type-tag">Epoch ${epochId - 1} (completed)</span></div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px">
          <div>
            <div class="u-fs11-dim-mb2">Stake Rewards</div>
            <div style="font-family:var(--mono);font-size:14px;font-weight:600;color:var(--green)">${fmtCompact(prevRewards / 1e9)} SUI</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Stake Subsidies</div>
            <div class="u-mono-14">${fmtCompact(prevSubsidies / 1e9)} SUI</div>
            <div class="u-fs10-dim">${prevRewards > 0 ? ((prevSubsidies / prevRewards) * 100).toFixed(1) : 0}% of rewards</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Gas Fees Collected</div>
            <div class="u-mono-14">${fmtCompact(prevGasFees / 1e9)} SUI</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Storage Fund</div>
            <div class="u-mono-14">${fmtCompact(prevFundSize / 1e9)} SUI</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Fund Net Inflow</div>
            <div style="font-family:var(--mono);font-size:14px;color:${prevNetInflow >= 0 ? 'var(--green)' : 'var(--red)'}">${prevNetInflow >= 0 ? '+' : ''}${fmtCompact(prevNetInflow / 1e9)} SUI</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Epoch Duration</div>
            <div class="u-mono-14">${epochDurationHrs.toFixed(1)}h</div>
            <div class="u-fs10-dim">${fmtNumber(prevCheckpoints)} checkpoints</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Transactions</div>
            <div class="u-mono-14">${fmtNumber(prevTxs)}</div>
            <div class="u-fs10-dim">${(prevTxs / (epochDurationMs / 1000)).toFixed(1)} tx/s avg</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Rewards Pool</div>
            <div class="u-mono-14">${fmtCompact(totalRewardsPool / 1e9)} SUI</div>
            <div class="u-fs10-dim">accumulated</div>
          </div>
        </div>
        <div style="margin-top:8px">
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">Current Epoch Progress (${epochElapsedHrs.toFixed(1)}h / ~${epochDurationHrs.toFixed(0)}h)</div>
          <div style="background:var(--bg);border-radius:4px;height:8px;overflow:hidden">
            <div style="background:var(--accent);height:100%;width:${epochProgress}%;border-radius:4px;transition:width 0.3s"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="card u-mb16">
      <div class="card-header">Staking Activity</div>
      <div class="card-body">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">
          <div>
            <div class="u-fs11-dim-mb2">Pending Stake</div>
            <div style="font-family:var(--mono);font-size:14px;color:var(--green)">+${fmtCompact(totalPendingStake / 1e9)} SUI</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Pending Withdrawals</div>
            <div style="font-family:var(--mono);font-size:14px;color:var(--red)">-${fmtCompact(totalPendingWithdraw / 1e9)} SUI</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Net Stake Change</div>
            <div style="font-family:var(--mono);font-size:14px;color:${(totalPendingStake - totalPendingWithdraw) >= 0 ? 'var(--green)' : 'var(--red)'}">${(totalPendingStake - totalPendingWithdraw) >= 0 ? '+' : ''}${fmtCompact((totalPendingStake - totalPendingWithdraw) / 1e9)} SUI</div>
          </div>
          <div>
            <div class="u-fs11-dim-mb2">Gas Price Range</div>
            <div class="u-mono-14">${fmtNumber(minGas)} — ${fmtNumber(maxGas)}</div>
            <div class="u-fs10-dim">median: ${fmtNumber(medianGas)} MIST</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card u-mb16">
      <div class="card-header">Gas Price Distribution <span class="type-tag">${gasBins.length} distinct prices</span></div>
      <div class="card-body">
        <div style="display:flex;gap:16px;align-items:flex-end;margin-bottom:12px">
          <div><span class="u-fs11-dim">Reference Gas Price:</span> <span style="font-family:var(--mono);font-weight:600">${fmtNumber(refGas)} MIST</span></div>
          <div><span class="u-fs11-dim">Median:</span> <span style="font-family:var(--mono);font-weight:600">${fmtNumber(medianGas)} MIST</span></div>
          <div><span class="u-fs11-dim">Range:</span> <span style="font-family:var(--mono)">${fmtNumber(minGas)} — ${fmtNumber(maxGas)}</span></div>
        </div>
        ${(() => {
          const H = 150, pad = 30, barPad = 4;
          const barW = Math.max(20, Math.min(50, 500 / gasBins.length));
          const totalW = gasBins.length * (barW + barPad) + pad * 2;
          const refBin = Math.floor(refGas / 50) * 50;
          const medBin = Math.floor(medianGas / 50) * 50;
          const bars = gasBins.map((b, i) => {
            const x = pad + i * (barW + barPad);
            const barH = Math.max(2, (b.count / maxBinCount) * (H - 60));
            const y = H - 40 - barH;
            const isRef = b.price === refBin;
            const isMed = b.price === medBin;
            const color = isRef ? "var(--accent)" : isMed ? "var(--green)" : "var(--blue)";
            const label = b.price + "-" + (b.price + 49);
            return "<g>" +
              "<rect x=\"" + x + "\" y=\"" + y + "\" width=\"" + barW + "\" height=\"" + barH + "\" fill=\"" + color + "\" rx=\"2\" opacity=\"" + (isRef || isMed ? 1 : 0.7) + "\" />" +
              "<text x=\"" + (x + barW / 2) + "\" y=\"" + (y - 4) + "\" text-anchor=\"middle\" fill=\"var(--text)\" style=\"font-size:13px;font-family:var(--mono);font-weight:600\">" + b.count + "</text>" +
              "<text x=\"" + (x + barW / 2) + "\" y=\"" + (H - 26) + "\" text-anchor=\"end\" fill=\"var(--text-dim)\" style=\"font-size:12px;font-family:var(--mono)\" transform=\"rotate(-45 " + (x + barW / 2) + " " + (H - 26) + ")\">" + label + "</text>" +
              "</g>";
          }).join("");
          return "<div style=\"overflow-x:auto\"><svg viewBox=\"0 0 " + totalW + " " + H + "\" width=\"100%\" height=\"" + H + "\" preserveAspectRatio=\"xMinYMid meet\">" + bars + "</svg></div>";
        })()}
        <div style="display:flex;gap:16px;font-size:11px;color:var(--text-dim);margin-top:6px">
          <span><span style="display:inline-block;width:10px;height:10px;background:var(--accent);border-radius:2px;vertical-align:middle;margin-right:4px"></span>Reference Gas Price</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:var(--green);border-radius:2px;vertical-align:middle;margin-right:4px"></span>Median</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:var(--blue);opacity:0.6;border-radius:2px;vertical-align:middle;margin-right:4px"></span>Other</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Validator Set <span class="type-tag">${validators.length} active</span></div>
      <div class="card-body">
        <table>
          <thead><tr>
            <th>#</th><th>Validator</th><th class="u-ta-right">Stake (SUI)</th>
            <th class="u-ta-right">Rewards Pool</th>
            <th class="u-ta-right">Voting %</th><th class="u-ta-right">Commission</th>
            <th class="u-ta-right">Est. APY</th><th class="u-ta-right">Gas Price</th>
            <th class="u-ta-right">Status</th>
          </tr></thead>
          <tbody>
            ${validators.map((v, i) => {
              const stakeSui = v.stake / 1e9;
              const rewardsSui = v.rewards / 1e9;
              const votingPct = (v.votingPower / 100).toFixed(2);
              const estApy = networkApy * (1 - v.commission / 10000);
              const statusColor = v.atRisk > 0 ? "var(--red)" : "var(--green)";
              const statusLabel = v.atRisk > 0 ? `At Risk (${v.atRisk})` : "Active";
              const nextChanges = [];
              if (v.nextGasPrice !== v.gasPrice) nextChanges.push(`gas: ${v.nextGasPrice}`);
              if (v.nextCommission !== v.commission) nextChanges.push(`comm: ${(v.nextCommission / 100).toFixed(1)}%`);
              const pendingNet = v.pendingStake - v.pendingWithdraw;
              return `<tr style="cursor:pointer" data-action="validator-open-detail" data-idx="${i}">
                <td class="u-c-dim">${i + 1}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    ${v.imageUrl ? `<img src="${v.imageUrl}" data-hide-on-error="1" style="width:20px;height:20px;border-radius:50%;object-fit:cover">` : ""}
                    <div>
                      <div style="font-weight:500">${v.name}</div>
                      <div class="u-fs11-dim">${truncHash(v.address)}${nextChanges.length ? ` <span class="u-c-yellow" title="Next epoch changes">&Delta;</span>` : ""}</div>
                    </div>
                  </div>
                </td>
                <td class="u-ta-right-mono" data-sort-value="${stakeSui}">${fmtCompact(stakeSui)}${pendingNet !== 0 ? `<div style="font-size:10px;color:${pendingNet > 0 ? 'var(--green)' : 'var(--red)'}">${pendingNet > 0 ? '+' : ''}${fmtCompact(pendingNet / 1e9)}</div>` : ""}</td>
                <td style="text-align:right;font-family:var(--mono);font-size:12px;color:var(--text-dim)" data-sort-value="${rewardsSui}">${fmtCompact(rewardsSui)}</td>
                <td class="u-ta-right-mono" data-sort-value="${v.votingPower}">${votingPct}%</td>
                <td class="u-ta-right-mono" data-sort-value="${v.commission}">${(v.commission / 100).toFixed(1)}%</td>
                <td style="text-align:right;font-family:var(--mono);color:var(--green)" data-sort-value="${estApy}">${estApy.toFixed(2)}%</td>
                <td class="u-ta-right-mono" data-sort-value="${v.gasPrice}">${fmtNumber(v.gasPrice)}</td>
                <td style="text-align:right;color:${statusColor};font-size:12px">${statusLabel}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div id="validator-detail-modal" data-action="validator-close-overlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:1000;display:none;align-items:center;justify-content:center">
      <div id="validator-detail-content" style="background:var(--card-bg);border:1px solid var(--border);border-radius:8px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;padding:24px"></div>
    </div>
  `;

  const showValidatorDetail = (idx) => {
    const v = validators[idx];
    if (!v) return;
    const estApy = networkApy * (1 - v.commission / 10000);
    const stakeSui = v.stake / 1e9;
    const rewardsSui = v.rewards / 1e9;
    const pendingStakeSui = v.pendingStake / 1e9;
    const pendingWithdrawSui = v.pendingWithdraw / 1e9;
    const nextStakeSui = v.nextEpochStake / 1e9;
    const nextChanges = [];
    if (v.nextGasPrice !== v.gasPrice) nextChanges.push(`Gas Price: ${fmtNumber(v.gasPrice)} → ${fmtNumber(v.nextGasPrice)} MIST`);
    if (v.nextCommission !== v.commission) nextChanges.push(`Commission: ${(v.commission / 100).toFixed(1)}% → ${(v.nextCommission / 100).toFixed(1)}%`);

    document.getElementById("validator-detail-content").innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        ${v.imageUrl ? `<img src="${v.imageUrl}" data-hide-on-error="1" style="width:40px;height:40px;border-radius:50%;object-fit:cover">` : ""}
        <div>
          <div style="font-size:18px;font-weight:600">${v.name}</div>
          <div style="font-size:12px;color:var(--text-dim);font-family:var(--mono)">${v.address}</div>
          ${v.projectUrl ? `<a href="${v.projectUrl}" target="_blank" style="font-size:11px;color:var(--accent)">${v.projectUrl}</a>` : ""}
        </div>
        <button data-action="validator-close" style="margin-left:auto;background:none;border:none;color:var(--text-dim);font-size:20px;cursor:pointer">&times;</button>
      </div>
      ${v.description ? `<div style="font-size:13px;color:var(--text-dim);margin-bottom:16px;line-height:1.4">${v.description}</div>` : ""}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div style="padding:12px;background:var(--bg);border-radius:6px">
          <div class="u-fs11-dim">Stake</div>
          <div style="font-family:var(--mono);font-size:16px;font-weight:600">${fmtCompact(stakeSui)} SUI</div>
          <div class="u-fs11-dim">Voting Power: ${(v.votingPower / 100).toFixed(2)}%</div>
        </div>
        <div style="padding:12px;background:var(--bg);border-radius:6px">
          <div class="u-fs11-dim">Est. APY</div>
          <div style="font-family:var(--mono);font-size:16px;font-weight:600;color:var(--green)">${estApy.toFixed(2)}%</div>
          <div class="u-fs11-dim">Commission: ${(v.commission / 100).toFixed(1)}%</div>
        </div>
        <div style="padding:12px;background:var(--bg);border-radius:6px">
          <div class="u-fs11-dim">Rewards Pool</div>
          <div style="font-family:var(--mono);font-size:16px;font-weight:600">${fmtCompact(rewardsSui)} SUI</div>
          <div class="u-fs11-dim">Exchange Rate: ${v.exchangeRate.toFixed(4)}</div>
        </div>
        <div style="padding:12px;background:var(--bg);border-radius:6px">
          <div class="u-fs11-dim">Gas Price</div>
          <div style="font-family:var(--mono);font-size:16px;font-weight:600">${fmtNumber(v.gasPrice)} MIST</div>
          <div class="u-fs11-dim">Since epoch ${v.activationEpoch}</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:12px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">Pending Changes</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
          <div><span class="u-c-dim">Pending Stake:</span> <span style="color:var(--green);font-family:var(--mono)">+${fmtCompact(pendingStakeSui)} SUI</span></div>
          <div><span class="u-c-dim">Pending Withdraw:</span> <span style="color:var(--red);font-family:var(--mono)">-${fmtCompact(pendingWithdrawSui)} SUI</span></div>
          <div><span class="u-c-dim">Next Epoch Stake:</span> <span class="u-mono">${fmtCompact(nextStakeSui)} SUI</span></div>
        </div>
      </div>
      ${nextChanges.length ? `<div style="border-top:1px solid var(--border);padding-top:12px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;color:var(--yellow)">Next Epoch Changes</div>
        ${nextChanges.map(c => `<div style="font-size:13px;font-family:var(--mono);padding:2px 0">${c}</div>`).join("")}
      </div>` : ""}
    `;
    document.getElementById("validator-detail-modal").style.display = "flex";
  };
  if (app._validatorsClickHandler) app.removeEventListener("click", app._validatorsClickHandler);
  app._validatorsClickHandler = (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (!action) return;
    if (action === "validator-open-detail") {
      ev.preventDefault();
      const idx = Number(trigger.getAttribute("data-idx"));
      if (!Number.isNaN(idx)) showValidatorDetail(idx);
      return;
    }
    if (action === "validator-close") {
      ev.preventDefault();
      const modal = document.getElementById("validator-detail-modal");
      if (modal) modal.style.display = "none";
      return;
    }
    if (action === "validator-close-overlay" && ev.target === trigger) {
      const modal = document.getElementById("validator-detail-modal");
      if (modal) modal.style.display = "none";
    }
  };
  app.addEventListener("click", app._validatorsClickHandler);
}

// ── Object Congestion ──────────────────────────────────────────────────
async function renderCongestion(app) {
  app.innerHTML = `<div class="page-title">Object Congestion</div><div class="card"><div class="card-body">${renderLoading()}</div></div>`;

  // Step 1: Fetch recent checkpoints with transaction digests
  const cpData = await gql(`{
    checkpoints(last: 10) {
      nodes {
        sequenceNumber timestamp networkTotalTransactions
        transactions(first: 50) { nodes { digest } }
      }
    }
  }`);

  const checkpoints = cpData.checkpoints?.nodes || [];
  const allDigests = [];
  for (const cp of checkpoints) {
    const digests = (cp.transactions?.nodes || []).map(t => t.digest);
    for (const d of digests) allDigests.push(d);
  }

  // Step 2: Batch-fetch objectChanges via multiGetTransactionEffects (parallel batches)
  const BATCH = 25;
  const touches = {}; // addr -> { count, type, ownerStr, isShared, digests[], uniqueTxs }
  let totalTxs = 0;
  let totalObjectChanges = 0;

  const batchPromises = [];
  for (let i = 0; i < allDigests.length; i += BATCH) {
    const batch = allDigests.slice(i, i + BATCH);
    batchPromises.push(multiGetTransactionEffectsWithObjectChanges(batch, 50).catch(() => null));
  }
  const batchResults = await Promise.all(batchPromises);

  for (let b = 0; b < batchResults.length; b++) {
    const effList = batchResults[b];
    if (!effList) continue;
    for (const fx of effList) {
      if (!fx) continue;
      totalTxs++;
      const changes = fx.objectChanges?.nodes || [];
      totalObjectChanges += changes.length;
      for (const obj of changes) {
        const addr = obj.address;
        if (!addr) continue;
        if (!touches[addr]) {
          const owner = obj.outputState?.owner;
          let ownerStr = "Unknown";
          if (owner?.initialSharedVersion != null) ownerStr = "Shared";
          else if (owner?.address?.address) ownerStr = truncHash(owner.address.address, 6);
          else if (owner?.__typename === "Immutable") ownerStr = "Immutable";
          touches[addr] = {
            count: 0, type: obj.outputState?.asMoveObject?.contents?.type?.repr || "",
            ownerStr, isShared: owner?.initialSharedVersion != null, digests: [], digestSet: new Set(), uniqueTxs: 0,
          };
        }
        touches[addr].count++;
        if (!touches[addr].digestSet.has(fx.digest)) {
          touches[addr].digestSet.add(fx.digest);
          touches[addr].digests.push(fx.digest);
          touches[addr].uniqueTxs++;
        }
        if (!touches[addr].type && obj.outputState?.asMoveObject?.contents?.type?.repr) {
          touches[addr].type = obj.outputState.asMoveObject.contents.type.repr;
        }
      }
    }
  }

  const cpDigests = checkpoints.map(c => ({
    seq: c.sequenceNumber,
    count: (c.transactions?.nodes || []).length,
    ts: c.timestamp,
  }));

  const sorted = Object.entries(touches)
    .map(([addr, info]) => ({ addr, ...info, digestSet: undefined }))
    .sort((a, b) => b.count - a.count);

  // Resolve MVR names for package addresses in type strings
  const pkgAddrs = [...new Set(sorted.slice(0, 50).map(o => {
    const m = o.type.match(/^(0x[0-9a-f]+)::/);
    return m ? m[1] : null;
  }).filter(Boolean))];
  if (pkgAddrs.length) await resolvePackageNames(pkgAddrs);

  const most = sorted[0];
  const sharedObjects = sorted.filter(o => o.isShared);
  const sharedCount = sharedObjects.length;
  const avgObjPerTx = totalTxs > 0 ? (totalObjectChanges / totalTxs).toFixed(1) : "0";
  const hotShared = sharedObjects.filter(o => o.uniqueTxs > 1).sort((a, b) => b.uniqueTxs - a.uniqueTxs);

  // Time span
  const timestamps = checkpoints.map(c => new Date(c.timestamp).getTime()).filter(t => !isNaN(t));
  const spanMs = timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  const spanSec = spanMs / 1000;
  const tps = spanSec > 0 ? (totalTxs / spanSec).toFixed(1) : "—";

  app.innerHTML = `
    <div class="page-title">Object Congestion <span class="type-tag">Last ${checkpoints.length} Checkpoints</span></div>
    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Transactions Analyzed</div>
        <div class="stat-value">${fmtNumber(totalTxs)}</div>
        <div class="stat-sub">${checkpoints.length} checkpoints &middot; ~${tps} tx/s</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Object Changes</div>
        <div class="stat-value">${fmtNumber(totalObjectChanges)}</div>
        <div class="stat-sub">${avgObjPerTx} avg per tx</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Unique Objects</div>
        <div class="stat-value">${fmtNumber(sorted.length)}</div>
        <div class="stat-sub">${most ? "peak " + most.count + "x touches" : "—"}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Shared Objects</div>
        <div class="stat-value u-c-yellow">${sharedCount}</div>
        <div class="stat-sub">${hotShared.length} contested (&gt;1 tx)</div>
      </div>
    </div>

    <div class="card u-mb16">
      <div class="card-header">Checkpoint Breakdown</div>
      <div class="card-body">
        <table>
          <thead><tr><th>Checkpoint</th><th class="u-ta-right">Transactions</th><th>Time</th></tr></thead>
          <tbody>
            ${cpDigests.reverse().map(c => `<tr>
              <td><a class="hash-link" href="#/checkpoint/${c.seq}">${fmtNumber(c.seq)}</a></td>
              <td class="u-ta-right-mono">${c.count}</td>
              <td>${timeTag(c.ts)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>

    ${hotShared.length ? `<div class="card u-mb16">
      <div class="card-header">Hot Shared Objects <span class="type-tag">${hotShared.length} contested</span></div>
      <div class="card-body">
        <table>
          <thead><tr><th>Object ID</th><th>Type</th><th class="u-ta-right">Unique Txs</th><th class="u-ta-right">Total Touches</th><th class="u-ta-right">% of All Txs</th></tr></thead>
          <tbody>
            ${hotShared.slice(0, 20).map(o => {
              const pkgMatch = o.type.match(/^(0x[0-9a-f]+)::/);
              const mvrName = pkgMatch ? mvrNameCache[pkgMatch[1]] : null;
              const st = shortType(o.type);
              const typeLabel = mvrName
                ? `<span class="u-c-accent">@${mvrName}</span>::${st.split("::").slice(1).join("::") || st}`
                : st || '<span class="u-c-dim">—</span>';
              const pct = totalTxs > 0 ? ((o.uniqueTxs / totalTxs) * 100).toFixed(1) : "0";
              const pctColor = pct >= 20 ? "var(--red)" : pct >= 5 ? "var(--yellow)" : "var(--text-dim)";
              return `<tr>
                <td>${hashLink(o.addr, '/object/' + o.addr)}</td>
                <td class="u-fs12">${typeLabel}</td>
                <td style="text-align:right;font-family:var(--mono);font-weight:600">${o.uniqueTxs}</td>
                <td class="u-ta-right-mono">${o.count}</td>
                <td style="text-align:right;font-family:var(--mono);color:${pctColor}">${pct}%</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>` : ""}

    <div class="card">
      <div class="card-header">All Objects by Touch Count</div>
      <div class="card-body">
        ${sorted.length ? `<table>
          <thead><tr><th>Object ID</th><th>Type</th><th>Owner</th><th class="u-ta-right">Touches</th><th class="u-ta-right">Txs</th><th>Transactions</th></tr></thead>
          <tbody>
            ${sorted.slice(0, 50).map(o => {
              const pkgMatch = o.type.match(/^(0x[0-9a-f]+)::/);
              const mvrName = pkgMatch ? mvrNameCache[pkgMatch[1]] : null;
              const st = shortType(o.type);
              const typeLabel = mvrName
                ? `<span class="u-c-accent">@${mvrName}</span>::${st.split("::").slice(1).join("::") || st}`
                : st || '<span class="u-c-dim">—</span>';
              const ownerColor = o.isShared ? "var(--yellow)" : "var(--text-dim)";
              const txLinks = o.digests.slice(0, 3).map(d => hashLink(d, '/tx/' + d)).join(" ");
              const more = o.digests.length > 3 ? ` <span style="color:var(--text-dim);font-size:11px">+${o.digests.length - 3}</span>` : "";
              return `<tr>
                <td>${hashLink(o.addr, '/object/' + o.addr)}</td>
                <td class="u-fs12">${typeLabel}</td>
                <td style="color:${ownerColor};font-size:12px">${o.ownerStr}</td>
                <td style="text-align:right;font-family:var(--mono);font-weight:600">${o.count}</td>
                <td class="u-ta-right-mono">${o.uniqueTxs}</td>
                <td>${txLinks}${more}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>` : renderEmpty("No object changes found.")}
      </div>
    </div>
  `;
}

// ── Global Events ─────────────────────────────────────────────────────
async function renderEvents(app) {
  const routeParams = splitRouteAndParams(getRoute()).params;
  let eventTypeFilter = routeParams.get("type") || "";
  let senderFilter = routeParams.get("sender") || "";
  let eventsData = [];
  let fetchedAt = "";
  const eventJsonCacheByTx = {};
  const eventJsonInFlightByTx = {};

  function packEventJsonPayload(value) {
    if (value == null) return "";
    try {
      return JSON.stringify(value);
    } catch (_) {
      return "";
    }
  }

  function unpackEventJsonPayload(value) {
    if (typeof value !== "string") return value;
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  async function loadEvents() {
    const filters = [];
    if (eventTypeFilter) filters.push(`type: ${JSON.stringify(String(eventTypeFilter || ""))}`);
    const senderNorm = senderFilter ? normalizeSuiAddress(senderFilter) : "";
    if (senderFilter && !senderNorm) {
      eventsData = [];
      fetchedAt = new Date().toISOString();
      return;
    }
    if (senderNorm) filters.push(`sender: ${JSON.stringify(senderNorm)}`);
    const filterArg = filters.length ? `filter: { ${filters.join(", ")} }` : "";
    const data = await gql(`{ events(last: 50 ${filterArg}) { nodes { contents { type { repr } } sender { address } timestamp transaction { digest } transactionModule { name package { address } } } } }`);
    eventsData = data?.events?.nodes || [];
    for (const key of Object.keys(eventJsonCacheByTx)) delete eventJsonCacheByTx[key];
    for (const key of Object.keys(eventJsonInFlightByTx)) delete eventJsonInFlightByTx[key];
    fetchedAt = new Date().toISOString();
  }

  await loadEvents();

  // Resolve MVR names for emitting packages AND packages in event type reprs
  async function resolveEventPkgs() {
    const emitPkgs = eventsData.map(e => e.transactionModule?.package?.address).filter(Boolean);
    const typePkgs = eventsData.map(e => { const m = e.contents?.type?.repr?.match(/^(0x[0-9a-f]{64})::/); return m ? m[1] : null; }).filter(Boolean);
    const allPkgs = [...new Set([...emitPkgs, ...typePkgs])];
    if (allPkgs.length) await resolvePackageNames(allPkgs);
  }
  async function ensureEventJsonForTx(digest) {
    const key = String(digest || "");
    if (!key) return [];
    if (Array.isArray(eventJsonCacheByTx[key])) return eventJsonCacheByTx[key];
    if (eventJsonInFlightByTx[key]) return eventJsonInFlightByTx[key];
    eventJsonInFlightByTx[key] = (async () => {
      try {
        const data = await gql(`query($digest: String!) {
          transaction(digest: $digest) {
            effects {
              events(first: 100) {
                nodes { contents { json } }
              }
            }
          }
        }`, { digest: key });
        const rows = data?.transaction?.effects?.events?.nodes || [];
        const payloads = rows.map((row) => packEventJsonPayload(row?.contents?.json ?? null));
        eventJsonCacheByTx[key] = payloads;
        return payloads;
      } catch (_) {
        eventJsonCacheByTx[key] = [];
        return [];
      } finally {
        delete eventJsonInFlightByTx[key];
      }
    })();
    return eventJsonInFlightByTx[key];
  }

  // Helper: replace package address in type repr with MVR name
  function mvrType(repr) {
    if (!repr) return "";
    return repr.replace(/^(0x[0-9a-f]{64})::/, (_, addr) => {
      const name = mvrNameCache[addr];
      return name ? `@${name}::` : shortType(repr).split("::")[0] + "...::";
    });
  }

  function computeStats() {
    return {
      uniqueTypes: [...new Set(eventsData.map(e => e.contents?.type?.repr).filter(Boolean))],
      uniqueSenders: [...new Set(eventsData.map(e => e.sender?.address).filter(Boolean))],
      uniquePkgs: [...new Set(eventsData.map(e => e.transactionModule?.package?.address).filter(Boolean))],
      uniqueTxs: [...new Set(eventsData.map(e => e.transaction?.digest).filter(Boolean))],
    };
  }

  function groupByTx() {
    const groups = [];
    const map = new Map();
    for (const ev of eventsData) {
      const digest = ev.transaction?.digest || "unknown";
      if (!map.has(digest)) {
        const group = { digest, events: [], sender: ev.sender?.address, timestamp: ev.timestamp };
        map.set(digest, group);
        groups.push(group);
      }
      map.get(digest).events.push(ev);
    }
    return groups;
  }

  function renderEventsContent() {
    const stats = computeStats();
    const txGroups = groupByTx();
    let html = `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">${copyLinkBtn()}</div>`;
    html += `<h2 class="u-mb12">Global Events</h2>`;
    html += renderDefiScopeBar({
      sampleLabel: `Last ${fmtNumber(eventsData.length)} events in ${fmtNumber(txGroups.length)} transactions`,
      fetchedAt,
      sourceLabel: "Sui GraphQL Mainnet · events",
    });

    // Filters
    html += `<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
      <input id="evt-type-filter" type="text" placeholder="Filter by event type..." value="${eventTypeFilter}" aria-label="Filter events by type" style="flex:1;min-width:200px;padding:6px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:var(--mono)" />
      <input id="evt-sender-filter" type="text" placeholder="Filter by sender..." value="${senderFilter}" aria-label="Filter events by sender address" style="width:200px;padding:6px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:var(--mono)" />
      <button data-action="events-apply-filter" style="padding:6px 16px;background:var(--accent);color:#000;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">Filter</button>
    </div>`;

    // Stats
    html += `<div class="stats-grid u-mb16">
      <div class="stat-box"><div class="stat-label">Events Shown</div><div class="stat-value">${eventsData.length}</div></div>
      <div class="stat-box"><div class="stat-label">Transactions</div><div class="stat-value">${txGroups.length}</div></div>
      <div class="stat-box"><div class="stat-label">Unique Types</div><div class="stat-value">${stats.uniqueTypes.length}</div></div>
      <div class="stat-box"><div class="stat-label">Unique Senders</div><div class="stat-value">${stats.uniqueSenders.length}</div></div>
    </div>`;

    // Grouped by transaction
    if (!eventsData.length) {
      html += renderEmpty("No events found." + (eventTypeFilter || senderFilter ? " Try adjusting filters." : ""));
    } else {
      let evtIdx = 0;
      for (const group of txGroups) {
        const sender = group.sender;
        const groupId = `evt-group-${group.digest.slice(0, 8)}`;
        html += `<div class="card u-mb16" style="border-left:3px solid var(--accent)">
          <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer" data-action="events-toggle-group" data-group-id="${groupId}">
            <div style="display:flex;align-items:center;gap:8px">
              ${hashLink(group.digest, '/tx/' + group.digest)}
              <span class="badge" style="background:var(--accent)20;color:var(--accent)">${group.events.length} event${group.events.length > 1 ? 's' : ''}</span>
            </div>
            <div style="display:flex;align-items:center;gap:12px">
              ${sender ? `<span class="u-fs12-dim">from</span> ${hashLink(sender, '/address/' + sender)}` : ""}
              <span style="white-space:nowrap">${timeTag(group.timestamp)}</span>
            </div>
          </div>
          <div class="card-body" id="${groupId}" style="padding:0">
            <table style="margin:0"><thead><tr><th>Event Type</th><th>Module</th><th>Data</th></tr></thead><tbody>`;
        for (let groupEventIdx = 0; groupEventIdx < group.events.length; groupEventIdx += 1) {
          const ev = group.events[groupEventIdx];
          const typeRepr = ev.contents?.type?.repr || "—";
          const modName = ev.transactionModule?.name || "—";
          const typeShort = typeRepr.replace(/^0x[0-9a-f]{64}::/, "");
          const typeDisplay = (() => {
            const typePkgMatch = typeRepr.match(/^(0x[0-9a-f]{64})::/);
            if (typePkgMatch && mvrNameCache[typePkgMatch[1]]) return `@${mvrNameCache[typePkgMatch[1]]}::${typeShort}`;
            return typeShort;
          })();
          const rowId = `evt-row-${evtIdx++}`;
          const payloads = eventJsonCacheByTx[group.digest];
          const payloadKnown = Array.isArray(payloads) && groupEventIdx < payloads.length;
          const payload = payloadKnown ? unpackEventJsonPayload(payloads[groupEventIdx]) : undefined;
          const dataBtnLabel = payloadKnown
            ? (payload ? "View JSON" : "No JSON")
            : "Load JSON";
          html += `<tr>
            <td style="font-family:var(--mono);font-size:11px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${typeRepr}">${typeDisplay}</td>
            <td class="u-fs12-dim">${modName}</td>
            <td><button data-action="events-toggle-json" data-row-id="${rowId}" data-tx-digest="${escapeAttr(group.digest)}" data-event-idx="${groupEventIdx}" aria-expanded="false" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--accent);font-size:11px;padding:2px 10px;cursor:pointer;font-family:var(--mono)">${dataBtnLabel}</button></td>
          </tr>`;
          const payloadHtml = !payloadKnown
            ? `<div class="u-fs12-dim">JSON payload not loaded.</div>`
            : (payload ? jsonTreeBlock(payload, 280) : `<div class="u-fs12-dim">No JSON payload for this event.</div>`);
          html += `<tr id="${rowId}" style="display:none"><td colspan="3" style="padding:0 8px 8px">${payloadHtml}</td></tr>`;
        }
        html += `</tbody></table></div></div>`;
      }
    }
    return html;
  }

  const applyEventFilter = async () => {
    eventTypeFilter = document.getElementById("evt-type-filter")?.value?.trim() || "";
    senderFilter = document.getElementById("evt-sender-filter")?.value?.trim() || "";
    setRouteParams({
      type: eventTypeFilter || null,
      sender: senderFilter || null,
    });
    app.innerHTML = renderLoading();
    await loadEvents();
    app.innerHTML = renderEventsContent();
    resolveEventPkgs().then(() => {
      if (parseRoute(getRoute()).page !== "events") return;
      app.innerHTML = renderEventsContent();
    }).catch(() => null);
  };

  if (app._eventsClickHandler) app.removeEventListener("click", app._eventsClickHandler);
  app._eventsClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (action === "events-apply-filter") {
      ev.preventDefault();
      await applyEventFilter();
      return;
    }
    if (action === "events-toggle-json") {
      ev.preventDefault();
      const rowId = trigger.getAttribute("data-row-id") || "";
      if (!rowId) return;
      const row = document.getElementById(rowId);
      if (!row) return;
      const expanded = row.style.display === "table-row";
      if (expanded) {
        row.style.display = "none";
        trigger.setAttribute("aria-expanded", "false");
        return;
      }
      const digest = trigger.getAttribute("data-tx-digest") || "";
      const eventIdx = Number(trigger.getAttribute("data-event-idx"));
      const validIdx = Number.isFinite(eventIdx) ? Math.max(0, Math.floor(eventIdx)) : 0;
      if (!Array.isArray(eventJsonCacheByTx[digest])) {
        trigger.setAttribute("disabled", "disabled");
        const prevLabel = trigger.textContent;
        trigger.textContent = "Loading...";
        await ensureEventJsonForTx(digest);
        trigger.removeAttribute("disabled");
        const payloads = eventJsonCacheByTx[digest];
        const payload = Array.isArray(payloads) ? unpackEventJsonPayload(payloads[validIdx]) : undefined;
        trigger.textContent = payload === undefined
          ? (prevLabel || "Load JSON")
          : (payload ? "View JSON" : "No JSON");
      }
      const payloads = eventJsonCacheByTx[digest];
      const payload = Array.isArray(payloads) ? unpackEventJsonPayload(payloads[validIdx]) : undefined;
      row.innerHTML = `<td colspan="3" style="padding:0 8px 8px">${
        payload === undefined
          ? '<div class="u-fs12-dim">JSON payload unavailable.</div>'
          : (payload ? jsonTreeBlock(payload, 280) : '<div class="u-fs12-dim">No JSON payload for this event.</div>')
      }</td>`;
      row.style.display = "table-row";
      trigger.setAttribute("aria-expanded", "true");
    }
    if (action === "events-toggle-group") {
      ev.preventDefault();
      const groupId = trigger.getAttribute("data-group-id") || "";
      if (!groupId) return;
      const body = document.getElementById(groupId);
      if (!body) return;
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
    }
  };
  app.addEventListener("click", app._eventsClickHandler);
  app.innerHTML = renderEventsContent();
  resolveEventPkgs().then(() => {
    if (parseRoute(getRoute()).page !== "events") return;
    app.innerHTML = renderEventsContent();
  }).catch(() => null);
}

function defiCategoryColor(category) {
  if (category === "lending") return "var(--yellow)";
  if (category === "dex") return "var(--accent)";
  if (category === "staking") return "var(--green)";
  if (category === "perps") return "var(--red)";
  if (category === "stablecoin") return "var(--blue)";
  return "var(--text-dim)";
}

function defiSeverityBadge(severity) {
  if (severity === "high") return `<span class="badge badge-fail">High</span>`;
  if (severity === "medium") return `<span class="badge" style="color:var(--yellow);background:var(--yellow)20">Medium</span>`;
  return `<span class="badge">Low</span>`;
}

function defiConfidenceBadge(level) {
  const v = level === "high" || level === "medium" ? level : "low";
  if (v === "high") return `<span class="badge" style="color:var(--green);background:var(--green)20">High</span>`;
  if (v === "medium") return `<span class="badge" style="color:var(--yellow);background:var(--yellow)20">Medium</span>`;
  return `<span class="badge" style="color:var(--text-dim);background:var(--border)">Low</span>`;
}

function renderDefiScopeBar({ sampleLabel = "Snapshot", fetchedAt = "", ttlMs = 0, refreshAction = "", leftControls = "", sourceLabel = "Sui GraphQL Mainnet" } = {}) {
  const ttlSec = ttlMs > 0 ? Math.round(ttlMs / 1000) : 0;
  const refreshButton = refreshAction
    ? `<button data-action="${escapeAttr(refreshAction)}" class="btn-accent-sm">Refresh</button>`
    : "";
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="badge" style="background:var(--surface2);color:var(--text)">${escapeHtml(sampleLabel)}</span>
        ${ttlSec ? `<span class="badge" style="background:var(--surface2);color:var(--text-dim)">TTL ${ttlSec}s</span>` : ""}
        ${sourceLabel ? `<span class="badge" style="background:var(--surface2);color:var(--text-dim)">${escapeHtml(sourceLabel)}</span>` : ""}
        ${leftControls || ""}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="u-fs12-dim">Updated ${fetchedAt ? timeAgo(fetchedAt) : "—"}${fetchedAt ? ` · ${fmtTime(fetchedAt)}` : ""}</span>
        ${refreshButton}
      </div>
    </div>
  `;
}

function renderDefiSignalsCard(signals = [], title = "Top 3 Signals Now") {
  const rows = (signals || []).filter(Boolean).slice(0, 3);
  return `
    <div class="card u-mb16">
      <div class="card-header">${title}</div>
      <div class="card-body" style="padding:8px 16px">
        ${rows.length ? rows.map((s, i) => `
          <div style="padding:8px 0;${i < rows.length - 1 ? "border-bottom:1px solid var(--border);" : ""}">
            <span style="font-family:var(--mono);color:var(--accent);margin-right:6px">${i + 1}.</span>${escapeHtml(s)}
          </div>`).join("") : `<div class="empty" style="margin:6px 0">No live signals available.</div>`}
      </div>
    </div>
  `;
}

function renderDefiMethodCard(lines = [], title = "How Computed") {
  if (uiViewMode !== "advanced") {
    return `
      <div class="card u-mb16">
        <div class="card-header">${title}</div>
        <div class="card-body" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="u-fs12-dim">Hidden in Simple view. Switch to Advanced for full methodology details.</span>
          <button data-action="set-view-mode-advanced" class="btn-surface-sm">Switch to Advanced</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="card u-mb16">
      <div class="card-header">${title}</div>
      <div class="card-body u-p12-16">
        ${lines?.length ? `<ul style="margin:0;padding-left:18px;display:grid;gap:6px;font-size:12px;color:var(--text-dim)">
          ${lines.map(line => `<li>${escapeHtml(line)}</li>`).join("")}
        </ul>` : `<div class="empty">No computation metadata available.</div>`}
      </div>
    </div>
  `;
}

function renderDefiParityGuardCard(parity = {}, title = "Cross-Page Parity Guard") {
  if (uiViewMode !== "advanced") return "";
  const p = parity || {};
  if (p.loading) {
    return `
      <div class="card u-mb16">
        <div class="card-header">${title}</div>
        <div class="card-body u-p12-16">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="badge" style="background:var(--blue)22;color:var(--blue)">Loading</span>
            <span class="u-fs12-dim">Window: ${escapeHtml(p.windowLabel || "—")} (${escapeHtml(p.windowKey || "—")})</span>
          </div>
          <div style="font-size:12px;color:var(--text-dim);margin-top:8px">Package and DEX parity is loading asynchronously after first paint.</div>
        </div>
      </div>
    `;
  }
  if (p.error) {
    return `
      <div class="card u-mb16">
        <div class="card-header">${title}</div>
        <div class="card-body u-p12-16">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="badge" style="background:var(--yellow)22;color:var(--yellow)">Unavailable</span>
            <span class="u-fs12-dim">Window: ${escapeHtml(p.windowLabel || "—")} (${escapeHtml(p.windowKey || "—")})</span>
          </div>
          <div style="font-size:12px;color:var(--yellow);margin-top:8px">${escapeHtml(p.error)}</div>
        </div>
      </div>
    `;
  }
  const mismatches = Array.isArray(p.mismatches) ? p.mismatches : [];
  const ok = !mismatches.length;
  const statusColor = ok ? "var(--green)" : "var(--yellow)";
  return `
    <div class="card u-mb16">
      <div class="card-header">${title}</div>
      <div class="card-body u-p12-16">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <span class="badge" style="background:${ok ? "var(--green)22" : "var(--yellow)22"};color:${statusColor}">${ok ? "OK" : "Mismatch"}</span>
          <span class="u-fs12-dim">Window: ${escapeHtml(p.windowLabel || "—")} (${escapeHtml(p.windowKey || "—")})</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;margin-bottom:${mismatches.length ? "10px" : "0"}">
          <div class="u-fs12-dim">Packages rows: <span class="u-c-text">${fmtNumber(p.packagesRowsOverview || 0)}</span> (overview) vs <span class="u-c-text">${fmtNumber(p.packagesRowsPackages || 0)}</span> (packages)</div>
          <div class="u-fs12-dim">DEX protocols: <span class="u-c-text">${fmtNumber(p.dexProtocolsOverview || 0)}</span> (overview) vs <span class="u-c-text">${fmtNumber(p.dexProtocolsDex || 0)}</span> (dex)</div>
          <div class="u-fs12-dim">DEX tracked txs: <span class="u-c-text">${fmtNumber(p.dexTrackedTxOverview || 0)}</span> (overview) vs <span class="u-c-text">${fmtNumber(p.dexTrackedTxDex || 0)}</span> (dex)</div>
        </div>
        ${mismatches.length
          ? `<div style="font-size:12px;color:var(--yellow)">${mismatches.map(m => escapeHtml(m)).join(" · ")}</div>`
          : `<div style="font-size:12px;color:var(--green)">All parity checks passed for the selected window.</div>`}
      </div>
    </div>
  `;
}

function fmtHistoryMetricValue(metric, v) {
  if (!Number.isFinite(v)) return "—";
  if (metric === "network") return fmtCompact(Math.round(v));
  const abs = Math.abs(v);
  if (abs >= 1e9) return fmtCompact(v);
  if (abs >= 1e6) return fmtCompact(v);
  if (abs >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return v.toExponential(2);
}

function renderHistoryLineChart(series, opts = {}) {
  const rows = Array.isArray(series) ? series : [];
  const metric = opts.metric === "network" ? "network" : "object";
  if (!rows.length) return renderEmpty("No historical rows.");
  const valid = rows.map((r, i) => ({ ...r, i })).filter(r => Number.isFinite(r.value));
  if (!valid.length) return renderEmpty("No numeric historical values for the selected range.");

  const W = 860, H = 220, PX = 52, PY = 18;
  const n = rows.length;
  const xAt = (i) => (PX + ((n <= 1 ? 0 : i * ((W - PX * 2) / (n - 1)))));
  let minV = Math.min(...valid.map(r => r.value));
  let maxV = Math.max(...valid.map(r => r.value));
  if (minV === maxV) {
    const pad = Math.abs(minV || 1) * 0.02;
    minV -= pad;
    maxV += pad;
  }
  const yAt = (v) => {
    const t = (v - minV) / (maxV - minV);
    return PY + ((H - PY * 2) * (1 - t));
  };

  const points = valid.map(r => `${xAt(r.i).toFixed(2)},${yAt(r.value).toFixed(2)}`).join(" ");
  const first = valid[0];
  const last = valid[valid.length - 1];
  const area = points
    ? `${xAt(first.i).toFixed(2)},${(H - PY).toFixed(2)} ${points} ${xAt(last.i).toFixed(2)},${(H - PY).toFixed(2)}`
    : "";
  const yTop = fmtHistoryMetricValue(metric, maxV);
  const yBot = fmtHistoryMetricValue(metric, minV);
  const midIdx = Math.floor((rows.length - 1) / 2);

  const labelAt = (idx) => {
    const row = rows[idx];
    return row?.ts ? fmtDayShort(row.ts) : `D-${Math.max(0, rows.length - 1 - idx)}`;
  };
  const markerRows = valid.length <= 24
    ? valid
    : [first, valid[Math.floor(valid.length / 2)], last];
  const crosshairId = `hist-crosshair-${sparklineSeq++}`;
  const tooltipTargets = valid.map(r => {
    const ts = r.ts ? fmtTime(r.ts) : `Index ${r.i + 1}`;
    const cp = Number.isFinite(r.checkpoint) ? ` | checkpoint ${fmtNumber(r.checkpoint)}` : "";
    const val = fmtHistoryMetricValue(metric, r.value);
    const tip = `${ts}${cp} | ${val}`;
    return `<circle cx="${xAt(r.i).toFixed(2)}" cy="${yAt(r.value).toFixed(2)}" r="8" fill="transparent" data-chart-tooltip="${escapeAttr(tip)}" data-chart-crosshair-id="${crosshairId}" data-chart-crosshair-x="${xAt(r.i).toFixed(2)}" />`;
  }).join("");

  return `
    <div style="overflow:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="220" preserveAspectRatio="none" style="background:linear-gradient(180deg, var(--surface2) 0%, var(--surface) 100%);border:1px solid var(--border);border-radius:8px">
        <line x1="${PX}" y1="${PY}" x2="${PX}" y2="${H - PY}" stroke="var(--border)" />
        <line x1="${PX}" y1="${H - PY}" x2="${W - PX}" y2="${H - PY}" stroke="var(--border)" />
        <line x1="${PX}" y1="${PY}" x2="${W - PX}" y2="${PY}" stroke="var(--border)" stroke-dasharray="3 4" opacity="0.6" />
        <line x1="${PX}" y1="${(H - PY + PY) / 2}" x2="${W - PX}" y2="${(H - PY + PY) / 2}" stroke="var(--border)" stroke-dasharray="3 4" opacity="0.4" />
        <line id="${crosshairId}" x1="${PX}" y1="${PY}" x2="${PX}" y2="${H - PY}" stroke="${metric === "network" ? "var(--accent)" : "var(--green)"}" stroke-dasharray="3 3" opacity="0.7" style="display:none" />
        ${area ? `<polygon points="${area}" fill="${metric === "network" ? "rgba(88,166,255,0.16)" : "rgba(63,185,80,0.16)"}"></polygon>` : ""}
        ${points ? `<polyline fill="none" stroke="${metric === "network" ? "var(--accent)" : "var(--green)"}" stroke-width="2.5" points="${points}" />` : ""}
        ${markerRows.map(m => `<circle cx="${xAt(m.i).toFixed(2)}" cy="${yAt(m.value).toFixed(2)}" r="3.2" fill="${metric === "network" ? "var(--accent)" : "var(--green)"}" />`).join("")}
        ${tooltipTargets}

        <text x="10" y="${PY + 4}" fill="var(--text-dim)" font-size="11">${escapeHtml(yTop)}</text>
        <text x="10" y="${H - PY}" fill="var(--text-dim)" font-size="11">${escapeHtml(yBot)}</text>

        <text x="${xAt(0).toFixed(2)}" y="${H - 4}" text-anchor="middle" fill="var(--text-dim)" font-size="11">${escapeHtml(labelAt(0))}</text>
        <text x="${xAt(midIdx).toFixed(2)}" y="${H - 4}" text-anchor="middle" fill="var(--text-dim)" font-size="11">${escapeHtml(labelAt(midIdx))}</text>
        <text x="${xAt(rows.length - 1).toFixed(2)}" y="${H - 4}" text-anchor="middle" fill="var(--text-dim)" font-size="11">${escapeHtml(labelAt(rows.length - 1))}</text>
      </svg>
    </div>
  `;
}

function packageSourceBadge(source) {
  if (source === "mvr") return `<span class="badge" style="color:var(--green);background:var(--green)20">MVR</span>`;
  if (source === "override") return `<span class="badge" style="color:var(--yellow);background:var(--yellow)20">Override</span>`;
  return `<span class="badge" style="color:var(--text-dim);background:var(--border)">Unknown</span>`;
}

// ── Packages ────────────────────────────────────────────────────────────
async function renderPackages(app) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const routeParams = splitRouteAndParams(getRoute()).params;
  let windowKey = normalizeDefiWindowKey(routeParams.get("w"));
  let data = await fetchPackageActivitySnapshot(windowKey);
  let query = routeParams.get("q") || "";
  let sourceFilter = ["all", "mvr", "override", "unknown"].includes(routeParams.get("src")) ? routeParams.get("src") : "all";
  let categoryFilter = routeParams.get("cat") || "all";
  let sortKey = ["tx", "calls", "latest", "success", "senders"].includes(routeParams.get("sort")) ? routeParams.get("sort") : "tx";
  let selectedPkg = normalizeSuiAddress(routeParams.get("pkg")) || data?.packages?.[0]?.package || "";
  let detailData = null;
  let detailErr = "";
  let detailLoading = !!selectedPkg;
  let detailReqId = 0;
  let initialDetailLoadPromise = null;

  function persistPackagesState() {
    setRouteParams({
      w: windowKey !== DEFI_WINDOW_DEFAULT_KEY ? windowKey : null,
      q: query || null,
      src: sourceFilter !== "all" ? sourceFilter : null,
      cat: categoryFilter !== "all" ? categoryFilter : null,
      sort: sortKey !== "tx" ? sortKey : null,
      pkg: selectedPkg || null,
    });
  }

  function filteredRows() {
    let rows = [...(data?.packages || [])];
    if (sourceFilter !== "all") rows = rows.filter(r => r.source === sourceFilter);
    if (categoryFilter !== "all") rows = rows.filter(r => String(r.category || "").toLowerCase() === categoryFilter);
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(r => {
        if (String(r.display || "").toLowerCase().includes(q)) return true;
        if (String(r.rawName || "").toLowerCase().includes(q)) return true;
        if (String(r.package || "").toLowerCase().includes(q)) return true;
        if ((r.topModules || []).some(x => String(x.value || "").toLowerCase().includes(q))) return true;
        if ((r.topFunctions || []).some(x => String(x.value || "").toLowerCase().includes(q))) return true;
        return false;
      });
    }
    if (sortKey === "calls") rows.sort((a, b) => (b.callCount - a.callCount) || (b.txCount - a.txCount));
    else if (sortKey === "latest") rows.sort((a, b) => new Date(b.latestTs || 0).getTime() - new Date(a.latestTs || 0).getTime());
    else if (sortKey === "success") rows.sort((a, b) => (b.successRate - a.successRate) || (b.txCount - a.txCount));
    else if (sortKey === "senders") rows.sort((a, b) => (b.uniqueSenders - a.uniqueSenders) || (b.txCount - a.txCount));
    else rows.sort((a, b) => (b.txCount - a.txCount) || (b.callCount - a.callCount));
    return rows;
  }

  async function loadDetail(pkg, force = false, rerender = true) {
    const nextPkg = normalizeSuiAddress(pkg);
    if (!nextPkg) {
      selectedPkg = "";
      persistPackagesState();
      detailData = null;
      detailErr = "";
      detailLoading = false;
      if (rerender && isActiveRoute()) app.innerHTML = renderContent();
      return;
    }
    selectedPkg = nextPkg;
    persistPackagesState();
    const reqId = ++detailReqId;
    detailLoading = true;
    detailErr = "";
    if (rerender && isActiveRoute()) app.innerHTML = renderContent();
    try {
      const d = await fetchPackageUpgradeSnapshot(nextPkg, force);
      if (reqId !== detailReqId) return;
      detailData = d;
      detailErr = "";
    } catch (e) {
      if (reqId !== detailReqId) return;
      detailData = null;
      detailErr = e?.message || "Failed to load package upgrade details.";
    } finally {
      if (reqId === detailReqId) {
        detailLoading = false;
        if (rerender && isActiveRoute()) app.innerHTML = renderContent();
      }
    }
  }

  async function ensureInitialPackageDetail(force = false) {
    if (!selectedPkg) return null;
    if (initialDetailLoadPromise && !force) return initialDetailLoadPromise;
    initialDetailLoadPromise = (async () => {
      try {
        await loadDetail(selectedPkg, force, false);
      } finally {
        if (isActiveRoute()) app.innerHTML = renderContent();
      }
    })();
    return initialDetailLoadPromise;
  }

  function renderTopList(title, rows, kind = "text") {
    const items = Array.isArray(rows) ? rows : [];
    return `
      <div class="card u-mb12">
        <div class="card-header">${title}</div>
        <div class="card-body">
          ${items.length ? `<table>
            <thead><tr><th>Value</th><th class="u-ta-right">Count</th></tr></thead>
            <tbody>
              ${items.slice(0, 8).map(r => {
                const v = String(r.value || "");
                const label = (kind === "object" && v.startsWith("0x")) ? hashLink(v, "/object/" + v) : `<span class="u-mono-12">${escapeHtml(v)}</span>`;
                return `<tr>
                  <td>${label}</td>
                  <td class="u-ta-right-mono">${fmtNumber(r.count)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty("No rows.")}
        </div>
      </div>
    `;
  }

  function renderUpgradeCard() {
    if (detailLoading) return `<div style="padding:12px 0">${renderLoading()}</div>`;
    if (detailErr) return renderEmpty(escapeHtml(detailErr));
    if (!detailData) return renderEmpty("No package version details loaded.");
    const versions = detailData.versions || [];
    const diff = detailData.moduleDiff;
    return `
      <div class="card" style="margin-top:12px">
        <div class="card-header">Upgrade History <span class="type-tag">Package Versions</span></div>
        <div class="card-body">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <div class="u-fs12-dim">${fmtNumber(versions.length)} version${versions.length === 1 ? "" : "s"} found</div>
            <button data-action="packages-refresh-detail" class="btn-surface-sm">Refresh Versions</button>
          </div>
          ${versions.length ? `<table style="margin-bottom:10px">
            <thead><tr><th>Version</th><th>Address</th><th>Publish Tx</th></tr></thead>
            <tbody>
              ${versions.slice().reverse().slice(0, 10).map(v => `<tr>
                <td class="u-mono">${fmtNumber(v.version)}</td>
                <td>${hashLink(v.address, "/object/" + v.address)}</td>
                <td>${v.txDigest ? hashLink(v.txDigest, "/tx/" + v.txDigest) : '<span class="u-c-dim">—</span>'}</td>
              </tr>`).join("")}
            </tbody>
          </table>` : renderEmpty("No package versions returned.")}
          ${diff ? `
            <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px">
              Module diff v${fmtNumber(diff.fromVersion)} → v${fmtNumber(diff.toVersion)}:
              +${fmtNumber(diff.addedModules.length)} / -${fmtNumber(diff.removedModules.length)} / ${fmtNumber(diff.unchangedCount)} unchanged
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div style="border:1px solid var(--border);border-radius:8px;padding:8px">
                <div style="font-size:12px;color:var(--green);margin-bottom:6px">Added Modules</div>
                ${diff.addedModules.length
                  ? diff.addedModules.slice(0, 30).map(m => `<span class="badge" style="margin:2px;color:var(--green);background:var(--green)20">${escapeHtml(m)}</span>`).join("")
                  : `<span class="u-fs12-dim">None</span>`}
              </div>
              <div style="border:1px solid var(--border);border-radius:8px;padding:8px">
                <div style="font-size:12px;color:var(--red);margin-bottom:6px">Removed Modules</div>
                ${diff.removedModules.length
                  ? diff.removedModules.slice(0, 30).map(m => `<span class="badge" style="margin:2px;color:var(--red);background:var(--red)20">${escapeHtml(m)}</span>`).join("")
                  : `<span class="u-fs12-dim">None</span>`}
              </div>
            </div>
          ` : `<div class="u-fs12-dim">No module diff available (need at least two versions).</div>`}
        </div>
      </div>
    `;
  }

  function renderContent() {
    const rows = filteredRows();
    if (selectedPkg && !data.packages.some(r => r.package === selectedPkg) && data.packages.length) {
      selectedPkg = data.packages[0].package;
    }
    if (!selectedPkg && rows.length) selectedPkg = rows[0].package;
    persistPackagesState();
    const selected = data.packages.find(r => r.package === selectedPkg) || rows[0] || null;
    const cov = data.coverage || {};
    const unresolvedRows = data.unresolvedPackages || [];
    const categories = [...new Set((data.packages || []).map(r => String(r.category || "").toLowerCase()).filter(Boolean))].sort();
    const unknownTxPct = cov.txWithAnyPackage ? ((cov.txUnknownOnly || 0) / cov.txWithAnyPackage * 100) : 0;
    const sourceSegments = [
      { label: "MVR", value: cov.mvrResolvedPackages || 0, color: "var(--green)" },
      { label: "Override", value: cov.overrideResolvedPackages || 0, color: "var(--yellow)" },
      { label: "Unknown", value: cov.unresolvedPackages || 0, color: "var(--red)" },
    ];
    const sampleCoverage = data?.window || cov?.sampleCoverage || {};
    const emptyReason = emptyStateReason(sampleCoverage, rows.length, cov.unresolvedPackages || 0);
    const scope = renderDefiScopeBar({
      sampleLabel: `${sampleCoverage.windowLabel || "Fast"} window · ${fmtNumber(data.sampleSize || 0)} programmable txs`,
      fetchedAt: data.fetchedAt,
      ttlMs: PACKAGE_ACTIVITY_TTL_MS,
      refreshAction: "packages-refresh",
      leftControls: `
        ${renderDefiWindowSelect(windowKey, "packages-window")}
        <input type="text" data-action="packages-query" value="${escapeAttr(query)}" placeholder="Filter package/module/function..." class="ui-control" style="min-width:190px" />
        <span class="u-fs12-dim">Source</span>
        <select data-action="packages-source" class="ui-control">
          <option value="all" ${sourceFilter === "all" ? "selected" : ""}>All</option>
          <option value="mvr" ${sourceFilter === "mvr" ? "selected" : ""}>MVR</option>
          <option value="override" ${sourceFilter === "override" ? "selected" : ""}>Override</option>
          <option value="unknown" ${sourceFilter === "unknown" ? "selected" : ""}>Unknown</option>
        </select>
        <span class="u-fs12-dim">Category</span>
        <select data-action="packages-category" class="ui-control">
          <option value="all" ${categoryFilter === "all" ? "selected" : ""}>All</option>
          ${categories.map(c => `<option value="${escapeAttr(c)}" ${categoryFilter === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
        </select>
        <span class="u-fs12-dim">Sort</span>
        <select data-action="packages-sort" class="ui-control">
          <option value="tx" ${sortKey === "tx" ? "selected" : ""}>Tx Count</option>
          <option value="calls" ${sortKey === "calls" ? "selected" : ""}>Calls</option>
          <option value="latest" ${sortKey === "latest" ? "selected" : ""}>Latest</option>
          <option value="success" ${sortKey === "success" ? "selected" : ""}>Success</option>
          <option value="senders" ${sortKey === "senders" ? "selected" : ""}>Senders</option>
        </select>
      `,
    });
    const methods = renderDefiMethodCard([
      "Package rows are derived deterministically from recent programmable transaction move-call commands.",
      "The same checkpoint/time window sampler is shared with DeFi Overview, DEX, and Flows pages for parity.",
      "Source labels: MVR = reverse-resolved name, Override = deterministic local package map, Unknown = unresolved package.",
      "Object and event rows are attributed by exact package address extracted from type strings (no semantic heuristics).",
      "Upgrade diff compares module sets between the latest two package versions returned by packageVersions.",
    ], "How Package Tagging Works");

    return `
      <div class="page-title">Packages <span class="type-tag">Activity Registry</span></div>
      ${scope}
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-label">Unique Packages</div><div class="stat-value">${fmtNumber(cov.uniquePackages || 0)}</div><div class="stat-sub">in current tx sample</div></div>
        <div class="stat-box"><div class="stat-label">Resolved (MVR)</div><div class="stat-value">${fmtNumber(cov.mvrResolvedPackages || 0)}</div><div class="stat-sub">reverse registry coverage</div></div>
        <div class="stat-box"><div class="stat-label">Resolved (Override)</div><div class="stat-value">${fmtNumber(cov.overrideResolvedPackages || 0)}</div><div class="stat-sub">deterministic local map</div></div>
        <div class="stat-box"><div class="stat-label">Unresolved</div><div class="stat-value" style="color:${(cov.unresolvedPackages || 0) > 0 ? "var(--yellow)" : "var(--text)"}">${fmtNumber(cov.unresolvedPackages || 0)}</div><div class="stat-sub">packages without labels</div></div>
        <div class="stat-box"><div class="stat-label">Txs With Resolved Pkg</div><div class="stat-value">${fmtNumber(cov.txWithResolvedPackage || 0)}</div><div class="stat-sub">${cov.txResolvedPct?.toFixed ? cov.txResolvedPct.toFixed(1) : "0.0"}% of txs with package calls</div></div>
        <div class="stat-box"><div class="stat-label">Unknown-Only Txs</div><div class="stat-value" style="color:${unknownTxPct > 40 ? "var(--yellow)" : "var(--text)"}">${fmtNumber(cov.txUnknownOnly || 0)}</div><div class="stat-sub">${unknownTxPct.toFixed(1)}% of txs with package calls</div></div>
      </div>
      ${renderDefiCoveragePanel(sampleCoverage, "Package Sampling Coverage")}
      <div class="card u-mb16">
        <div class="card-header">Package Resolution Coverage</div>
        <div class="card-body u-p12-16">
          ${renderStackBar(sourceSegments, { empty: '<div class="u-fs12-dim">No package coverage rows.</div>' })}
        </div>
      </div>

      <div class="card u-mb16">
        <div class="card-header">Package Activity Overview</div>
        <div class="card-body">
          ${rows.length ? `<table>
            <thead><tr><th>Package</th><th>Source</th><th>Category</th><th>Conf.</th><th class="u-ta-right">Txs</th><th class="u-ta-right">Calls</th><th class="u-ta-right">Success</th><th class="u-ta-right">Senders</th><th class="u-ta-right">Events</th><th class="u-ta-right">Obj Types</th><th>Latest</th></tr></thead>
            <tbody>
              ${rows.map(r => {
                const isSel = selected?.package === r.package;
                const succ = (r.successRate || 0) * 100;
                const catColor = defiCategoryColor(r.category);
                return `<tr${isSel ? ` style="background:var(--bg-light)"` : ""}>
                  <td>
                    <button data-action="packages-select" data-package="${escapeAttr(r.package)}" style="background:none;border:none;padding:0;margin:0;color:var(--accent);cursor:pointer;font-weight:600">${escapeHtml(r.display || truncHash(r.package, 6))}</button>
                    <div style="font-size:11px;color:var(--text-dim);font-family:var(--mono)">${r.package}</div>
                  </td>
                  <td>${packageSourceBadge(r.source)}</td>
                  <td><span class="badge" style="color:${catColor};background:${catColor}22">${escapeHtml(r.category || "other")}</span></td>
                  <td>${defiConfidenceBadge(r.confidence)}</td>
                  <td class="u-ta-right-mono">${fmtNumber(r.txCount)}</td>
                  <td class="u-ta-right-mono">${fmtNumber(r.callCount)}</td>
                  <td class="u-ta-right-mono">${succ.toFixed(1)}%</td>
                  <td class="u-ta-right-mono">${fmtNumber(r.uniqueSenders)}</td>
                  <td class="u-ta-right-mono">${fmtNumber((r.topEventTypes || []).reduce((s, e) => s + e.count, 0))}</td>
                  <td class="u-ta-right-mono">${fmtNumber((r.topObjectTypes || []).length)}</td>
                  <td>${timeTag(r.latestTs)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty(`${emptyReason}${query || sourceFilter !== "all" || categoryFilter !== "all" ? " Try adjusting filters." : ""}`)}
        </div>
      </div>

      ${methods}

      <div class="card u-mb16">
        <div class="card-header">Package Detail ${selected ? `<span class="type-tag">${escapeHtml(selected.display || truncHash(selected.package, 6))}</span>` : ""}</div>
        <div class="card-body">
          ${selected ? `
            <div class="stats-grid u-mb12">
              <div class="stat-box"><div class="stat-label">Package</div><div class="stat-value" style="font-size:16px">${hashLink(selected.package, "/object/" + selected.package)}</div><div class="stat-sub">${selected.rawName ? escapeHtml(selected.rawName) : "Unresolved package name"}</div></div>
              <div class="stat-box"><div class="stat-label">Source</div><div class="stat-value">${packageSourceBadge(selected.source)}</div><div class="stat-sub">${selected.canonical ? "protocol: " + escapeHtml(selected.canonical) : "protocol unresolved"}</div></div>
              <div class="stat-box"><div class="stat-label">Tx Count</div><div class="stat-value">${fmtNumber(selected.txCount)}</div><div class="stat-sub">selected window</div></div>
              <div class="stat-box"><div class="stat-label">Call Count</div><div class="stat-value">${fmtNumber(selected.callCount)}</div><div class="stat-sub">move call executions</div></div>
              <div class="stat-box"><div class="stat-label">Success Rate</div><div class="stat-value">${((selected.successRate || 0) * 100).toFixed(1)}%</div><div class="stat-sub">${fmtNumber(selected.successCount)} success / ${fmtNumber(selected.txCount)} txs</div></div>
              <div class="stat-box"><div class="stat-label">Unique Senders</div><div class="stat-value">${fmtNumber(selected.uniqueSenders || 0)}</div><div class="stat-sub">addresses interacting</div></div>
            </div>
            <div class="card" style="margin-bottom:12px;border-left:3px solid var(--accent)">
              <div class="card-header">Activity Summary</div>
              <div class="card-body">
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:12px">
                  <div><div class="u-fs11-dim-mb2">Avg Gas / PTB</div><div class="u-mono-14">${selected.avgGas > 0 ? fmtSui(selected.avgGas) : "—"}</div></div>
                  <div><div class="u-fs11-dim-mb2">Unique Senders</div><div class="u-mono-14">${fmtNumber(selected.uniqueSenders || 0)}</div></div>
                  <div><div class="u-fs11-dim-mb2">Event Types</div><div class="u-mono-14">${fmtNumber((selected.topEventTypes || []).length)}</div></div>
                  <div><div class="u-fs11-dim-mb2">Object Types Modified</div><div class="u-mono-14">${fmtNumber((selected.topObjectTypes || []).length)}</div></div>
                </div>
                ${(selected.topObjectTypes || []).length ? `<div style="margin-bottom:8px"><div class="u-fs11-dim-mb2">Object Types Touched</div>${(selected.topObjectTypes || []).map(o => '<span class="badge" style="margin:2px 4px 2px 0;background:var(--blue)22;color:var(--blue);font-size:11px">' + escapeHtml(o.value) + ' <span style="opacity:0.7">(' + o.count + ')</span></span>').join("")}</div>` : ""}
                ${(selected.topEventTypes || []).length ? `<div><div class="u-fs11-dim-mb2">Event Types Emitted</div>${(selected.topEventTypes || []).map(o => '<span class="badge" style="margin:2px 4px 2px 0;background:var(--purple)22;color:var(--purple);font-size:11px">' + escapeHtml(o.value) + ' <span style="opacity:0.7">(' + o.count + ')</span></span>').join("")}</div>` : ""}
              </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px">
              ${renderTopList("Top Modules", selected.topModules || [], "text")}
              ${renderTopList("Top Functions", selected.topFunctions || [], "text")}
              ${renderTopList("Event Types", selected.topEventTypes || [], "text")}
              ${renderTopList("Key Objects", selected.topObjects || [], "object")}
            </div>
            <div class="card" style="margin-top:12px">
              <div class="card-header">Recent Transactions</div>
              <div class="card-body">
                ${(selected.recentTxs || []).length ? `<table>
                  <thead><tr><th>Digest</th><th>Status</th><th>Sender</th><th class="u-ta-right">Calls</th><th>Modules</th><th>Time</th></tr></thead>
                  <tbody>
                    ${(selected.recentTxs || []).map(tx => `<tr>
                      <td>${hashLink(tx.digest, "/tx/" + tx.digest)}</td>
                      <td>${statusBadge(tx.status)}</td>
                      <td>${tx.sender ? hashLink(tx.sender, "/address/" + tx.sender) : '<span class="u-c-dim">—</span>'}</td>
                      <td class="u-ta-right-mono">${fmtNumber(tx.callCount)}</td>
                      <td class="u-fs12-dim">${escapeHtml((tx.modules || []).slice(0, 4).join(", ") || "—")}</td>
                      <td>${timeTag(tx.timestamp)}</td>
                    </tr>`).join("")}
                  </tbody>
                </table>` : renderEmpty("No recent package transactions.")}
              </div>
            </div>
            ${renderUpgradeCard()}
          ` : renderEmpty("Select a package to inspect detailed activity.")}
        </div>
      </div>

      <div class="card">
        <div class="card-header">Unresolved Package Queue <span class="type-tag">Top Unknowns</span></div>
        <div class="card-body">
          ${unresolvedRows.length ? `<table>
            <thead><tr><th>Package</th><th class="u-ta-right">Tx Count</th><th class="u-ta-right">Call Count</th></tr></thead>
            <tbody>
              ${unresolvedRows.map(r => `<tr>
                <td>${hashLink(r.package, "/object/" + r.package)}</td>
                <td class="u-ta-right-mono">${fmtNumber(r.txCount)}</td>
                <td class="u-ta-right-mono">${fmtNumber(r.callCount)}</td>
              </tr>`).join("")}
            </tbody>
          </table>` : renderEmpty("No unresolved packages in current sample.")}
        </div>
      </div>
    `;
  }

  const setPackagesQuery = (v) => {
    query = v || "";
    persistPackagesState();
    app.innerHTML = renderContent();
  };
  const setPackagesSource = (v) => {
    sourceFilter = ["all", "mvr", "override", "unknown"].includes(v) ? v : "all";
    persistPackagesState();
    app.innerHTML = renderContent();
  };
  const setPackagesCategory = (v) => {
    categoryFilter = v || "all";
    persistPackagesState();
    app.innerHTML = renderContent();
  };
  const setPackagesSort = (v) => {
    sortKey = ["tx", "calls", "latest", "success", "senders"].includes(v) ? v : "tx";
    persistPackagesState();
    app.innerHTML = renderContent();
  };
  const setPackagesWindow = async (v) => {
    windowKey = normalizeDefiWindowKey(v);
    persistPackagesState();
    app.innerHTML = renderLoading();
    data = await fetchPackageActivitySnapshot(windowKey, false);
    if (!isActiveRoute()) return;
    if (!data.packages.some(r => r.package === selectedPkg)) selectedPkg = data.packages[0]?.package || "";
    detailData = null;
    detailErr = "";
    detailLoading = !!selectedPkg;
    initialDetailLoadPromise = null;
    app.innerHTML = renderContent();
    if (selectedPkg) ensureInitialPackageDetail(false).catch(() => {});
  };
  const selectPackage = async (pkg) => {
    await loadDetail(pkg, false);
  };
  const refreshPackageDetail = async () => {
    await loadDetail(selectedPkg, true);
  };
  const refreshPackages = async () => {
    app.innerHTML = renderLoading();
    data = await fetchPackageActivitySnapshot(windowKey, true);
    if (!isActiveRoute()) return;
    if (!data.packages.some(r => r.package === selectedPkg)) selectedPkg = data.packages[0]?.package || "";
    detailData = null;
    detailErr = "";
    detailLoading = !!selectedPkg;
    initialDetailLoadPromise = null;
    app.innerHTML = renderContent();
    if (selectedPkg) ensureInitialPackageDetail(true).catch(() => {});
  };
  if (app._packagesInputHandler) app.removeEventListener("input", app._packagesInputHandler);
  const _debouncedPkgQuery = debounce((val) => setPackagesQuery(val), 300);
  app._packagesInputHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute("data-action") !== "packages-query") return;
    _debouncedPkgQuery(target.value || "");
  };
  app.addEventListener("input", app._packagesInputHandler);
  if (app._packagesChangeHandler) app.removeEventListener("change", app._packagesChangeHandler);
  app._packagesChangeHandler = async (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "packages-source") {
      setPackagesSource(target.value);
      return;
    }
    if (action === "packages-category") {
      setPackagesCategory(target.value);
      return;
    }
    if (action === "packages-sort") {
      setPackagesSort(target.value);
      return;
    }
    if (action === "packages-window") {
      await setPackagesWindow(target.value);
    }
  };
  app.addEventListener("change", app._packagesChangeHandler);
  if (app._packagesClickHandler) app.removeEventListener("click", app._packagesClickHandler);
  app._packagesClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (!action) return;
    if (action === "packages-select") {
      ev.preventDefault();
      const pkg = trigger.getAttribute("data-package") || "";
      if (!pkg) return;
      await selectPackage(pkg);
      return;
    }
    if (action === "packages-refresh-detail") {
      ev.preventDefault();
      await refreshPackageDetail();
      return;
    }
    if (action === "packages-refresh") {
      ev.preventDefault();
      await refreshPackages();
    }
  };
  app.addEventListener("click", app._packagesClickHandler);

  app.innerHTML = renderContent();
  setTimeout(() => {
    if (!isActiveRoute() || !selectedPkg) return;
    ensureInitialPackageDetail(false).catch(() => {});
  }, 0);
}

// ── DeFi Overview ──────────────────────────────────────────────────────
async function renderDefiOverview(app) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const routeParams = splitRouteAndParams(getRoute()).params;
  let windowKey = normalizeDefiWindowKey(routeParams.get("w"));
  let data = await fetchDefiOverviewSnapshot(windowKey);
  let categoryFilter = routeParams.get("cat") || "all";
  let sortKey = ["tx", "success", "latest", "name"].includes(routeParams.get("sort")) ? routeParams.get("sort") : "tx";
  let historyMetric = routeParams.get("metric") === "object" ? "object" : "network";
  let historyRange = DEFI_HISTORY_PRESETS[routeParams.get("range")] ? routeParams.get("range") : "1W";
  let historyObject = routeParams.get("obj") || DEFAULT_DEFI_HISTORY_OBJECT;
  let historyFormat = routeParams.get("fmt") || DEFAULT_DEFI_HISTORY_FORMAT;
  let historyData = null;
  let historyErr = "";
  let historyLoading = false;
  let historyReqId = 0;
  let parityData = null;
  let parityErr = "";
  let parityLoading = false;
  let parityReqId = 0;

  function persistDefiOverviewState() {
    setRouteParams({
      w: windowKey !== DEFI_WINDOW_DEFAULT_KEY ? windowKey : null,
      cat: categoryFilter !== "all" ? categoryFilter : null,
      sort: sortKey !== "tx" ? sortKey : null,
      metric: historyMetric !== "network" ? historyMetric : null,
      range: historyRange !== "1W" ? historyRange : null,
      obj: historyObject !== DEFAULT_DEFI_HISTORY_OBJECT ? historyObject : null,
      fmt: historyFormat !== DEFAULT_DEFI_HISTORY_FORMAT ? historyFormat : null,
    });
  }

  async function loadHistory(force = false, rerender = true) {
    const reqId = ++historyReqId;
    historyLoading = true;
    historyErr = "";
    if (rerender && isActiveRoute()) app.innerHTML = renderContent();
    try {
      const next = await fetchDefiHistorySnapshot({
        metric: historyMetric,
        range: historyRange,
        objectId: historyObject,
        formatExpr: historyFormat,
      }, force);
      if (reqId !== historyReqId) return;
      historyData = next;
      historyErr = "";
    } catch (e) {
      if (reqId !== historyReqId) return;
      historyData = null;
      historyErr = e?.message || "Failed to load historical snapshots.";
    } finally {
      if (reqId === historyReqId) {
        historyLoading = false;
        if (rerender && isActiveRoute()) app.innerHTML = renderContent();
      }
    }
  }

  async function loadParity(force = false, rerender = true) {
    const reqId = ++parityReqId;
    parityLoading = true;
    parityErr = "";
    if (rerender && isActiveRoute()) app.innerHTML = renderContent();
    try {
      const next = await fetchDefiOverviewParity(windowKey, force);
      if (reqId !== parityReqId) return;
      parityData = next;
      parityErr = "";
    } catch (e) {
      if (reqId !== parityReqId) return;
      parityData = null;
      parityErr = e?.message || "Failed to load cross-page parity.";
    } finally {
      if (reqId === parityReqId) {
        parityLoading = false;
        if (rerender && isActiveRoute()) app.innerHTML = renderContent();
      }
    }
  }

  function topRows() {
    let rows = [...(data.topProtocols || [])];
    if (categoryFilter !== "all") rows = rows.filter(p => p.category === categoryFilter);
    if (sortKey === "success") rows.sort((a, b) => ((b.txCount ? b.successCount / b.txCount : 0) - (a.txCount ? a.successCount / a.txCount : 0)));
    else if (sortKey === "latest") rows.sort((a, b) => new Date(b.latestTs || 0).getTime() - new Date(a.latestTs || 0).getTime());
    else if (sortKey === "name") rows.sort((a, b) => String(a.display || "").localeCompare(String(b.display || "")));
    else rows.sort((a, b) => (b.txCount || 0) - (a.txCount || 0));
    return rows;
  }

  function renderContent() {
    const top = topRows();
    const cats = data.categoryRows || [];
    const coverage = data.coverage || {};
    const tracked = coverage.trackedTxs || 0;
    const totalCategoryTx = cats.reduce((s, c) => s + c.txCount, 0) || 1;
    const lowShare = tracked ? ((coverage.lowConfidenceTx || 0) / tracked * 100) : 0;
    const sampleCoverage = data?.window || coverage?.sampleCoverage || {};
    const scope = renderDefiScopeBar({
      sampleLabel: `${sampleCoverage.windowLabel || "Fast"} window · ${fmtNumber(data.activity.sampleSize)} programmable txs`,
      fetchedAt: data.fetchedAt,
      ttlMs: DEFI_OVERVIEW_TTL_MS,
      refreshAction: "defi-overview-refresh",
      leftControls: `
        ${renderDefiWindowSelect(windowKey, "defi-overview-window")}
        <span class="u-fs12-dim">Category</span>
        <select data-action="defi-overview-category" class="ui-control">
          <option value="all" ${categoryFilter === "all" ? "selected" : ""}>All</option>
          ${cats.map(c => `<option value="${escapeAttr(c.category)}" ${categoryFilter === c.category ? "selected" : ""}>${escapeHtml(c.category)}</option>`).join("")}
        </select>
        <span class="u-fs12-dim">Sort</span>
        <select data-action="defi-overview-sort" class="ui-control">
          <option value="tx" ${sortKey === "tx" ? "selected" : ""}>Tx Count</option>
          <option value="success" ${sortKey === "success" ? "selected" : ""}>Success %</option>
          <option value="latest" ${sortKey === "latest" ? "selected" : ""}>Latest</option>
          <option value="name" ${sortKey === "name" ? "selected" : ""}>Name</option>
        </select>
      `,
    });
    const methods = renderDefiMethodCard([
      "Protocol identity is resolved via MVR reverse resolution from move-call package addresses.",
      "Overview, DEX, Flows, and Packages use the same deterministic window sampler (fast/1H/6H/24H).",
      "Coverage scores are computed from mapping confidence (high/medium/low) on each tracked transaction row.",
      "Overview combines activity sample, lending state, stablecoin supply, and LST snapshot using cached GraphQL responses.",
      "SUI spot price is sourced from DeepBook SUI/USDC pool events and used for derived USD metrics.",
    ]);
    const signals = renderDefiSignalsCard(data.signals || []);
    const parityCard = renderDefiParityGuardCard(
      parityLoading
        ? {
            loading: true,
            windowKey,
            windowLabel: sampleCoverage.windowLabel || "",
          }
        : (parityErr
          ? {
              error: parityErr,
              windowKey,
              windowLabel: sampleCoverage.windowLabel || "",
            }
          : (parityData || {
              loading: true,
              windowKey,
              windowLabel: sampleCoverage.windowLabel || "",
            }))
    );
    const hs = historyData?.stats || {};
    const hc = historyData?.coverage || {};
    const hp = historyData?.performance || {};
    const latestVal = Number.isFinite(hs.latest) ? fmtHistoryMetricValue(historyMetric, hs.latest) : "—";
    const deltaVal = Number.isFinite(hs.delta) ? fmtHistoryMetricValue(historyMetric, hs.delta) : "—";
    const deltaColor = Number.isFinite(hs.delta) ? (hs.delta >= 0 ? "var(--green)" : "var(--red)") : "var(--text)";
    const driftP95 = Number.isFinite(hc.driftP95Min) ? `${Math.round(hc.driftP95Min)} min` : "—";
    const historyCard = `
      <div class="card u-mb16">
        <div class="card-header">Historical Snapshots <span class="type-tag">Checkpoint Daily</span></div>
        <div class="card-body u-p12-16">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
            <span class="u-fs12-dim">Metric</span>
            <select data-action="defi-history-metric" class="ui-control">
              <option value="network" ${historyMetric === "network" ? "selected" : ""}>Network Tx/Day</option>
              <option value="object" ${historyMetric === "object" ? "selected" : ""}>Object Snapshot</option>
            </select>
            <span class="u-fs12-dim">Range</span>
            <select data-action="defi-history-range" class="ui-control">
              ${Object.keys(DEFI_HISTORY_PRESETS).map(k => `<option value="${k}" ${historyRange === k ? "selected" : ""}>${k}</option>`).join("")}
            </select>
            <button data-action="defi-history-refresh" class="btn-surface-sm">Reload</button>
          </div>
          ${historyMetric === "object" ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
            <input id="defi-hist-object" value="${escapeAttr(historyObject)}" placeholder="Object address" style="flex:1;min-width:260px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 10px;font-size:12px" />
            <input id="defi-hist-format" value="${escapeAttr(historyFormat)}" placeholder="format() path, e.g. {state.total_supply:json}" style="flex:1;min-width:260px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px 10px;font-size:12px" />
            <button data-action="defi-history-apply" class="btn-accent-sm">Apply</button>
          </div>` : ""}
          ${historyLoading ? `<div style="padding:12px 0">${renderLoading()}</div>` : ""}
          ${!historyLoading && historyErr ? `<div style="padding:8px 0">${renderEmpty(escapeHtml(historyErr))}</div>` : ""}
          ${!historyLoading && !historyErr && historyData ? `
            <div class="stats-grid u-mb12">
              <div class="stat-box"><div class="stat-label">Latest</div><div class="stat-value">${latestVal}</div><div class="stat-sub">${historyMetric === "network" ? "transactions/day" : "snapshot value"}</div></div>
              <div class="stat-box"><div class="stat-label">Delta (Last Step)</div><div class="stat-value" style="color:${deltaColor}">${deltaVal}</div><div class="stat-sub">${Number.isFinite(hs.deltaPct) ? `${hs.deltaPct >= 0 ? "+" : ""}${hs.deltaPct.toFixed(2)}%` : "—"}</div></div>
              <div class="stat-box"><div class="stat-label">Coverage</div><div class="stat-value">${fmtNumber(hc.validValues || 0)}</div><div class="stat-sub">${fmtNumber(hc.resolvedPoints || 0)} resolved / ${fmtNumber(hc.requestedPoints || 0)} requested</div></div>
              <div class="stat-box"><div class="stat-label">Drift (P95)</div><div class="stat-value">${driftP95}</div><div class="stat-sub">time alignment vs day targets</div></div>
              <div class="stat-box"><div class="stat-label">GraphQL Calls</div><div class="stat-value">${fmtNumber(hp.queryCount || 0)}</div><div class="stat-sub">batch max ${fmtNumber(hp.maxBatch || 0)}</div></div>
              <div class="stat-box"><div class="stat-label">Total Load</div><div class="stat-value">${Number.isFinite(hp.totalMs) ? `${hp.totalMs.toFixed(0)} ms` : "—"}</div><div class="stat-sub">mapping ${Number.isFinite(hp.mappingMs) ? hp.mappingMs.toFixed(0) : "—"}ms · data ${Number.isFinite(hp.dataMs) ? hp.dataMs.toFixed(0) : "—"}ms</div></div>
            </div>
            ${renderHistoryLineChart(historyData.series, { metric: historyMetric })}
            <div style="font-size:12px;color:var(--text-dim);margin-top:8px">
              ${historyMetric === "network"
                ? "Computed from checkpoint cumulative network totals (daily delta across mapped checkpoints)."
                : "Computed from checkpoint.query.object(...) using MoveValue.format(...) at each mapped daily checkpoint."}
            </div>
          ` : ""}
          ${!historyLoading && !historyErr && !historyData ? renderEmpty("No historical snapshot data loaded.") : ""}
        </div>
      </div>
    `;

    return `
      <div class="page-title">DeFi Overview <span class="type-tag">GraphQL</span></div>
      ${scope}
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">Protocols Seen</div>
          <div class="stat-value">${top.length}</div>
          <div class="stat-sub">${fmtNumber(data.activity.uniquePackages)} unique packages</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">DeFi Tx Sample</div>
          <div class="stat-value">${fmtNumber(data.activity.sampleSize)}</div>
          <div class="stat-sub">${(data.activity.successRate * 100).toFixed(1)}% success</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Resolved Packages</div>
          <div class="stat-value">${fmtNumber(coverage.resolvedPackages || 0)}</div>
          <div class="stat-sub">${fmtNumber(coverage.unresolvedPackages || 0)} unresolved</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Low-Confidence Txs</div>
          <div class="stat-value" style="color:${lowShare > 25 ? "var(--yellow)" : "var(--text)"}">${fmtNumber(coverage.lowConfidenceTx || 0)}</div>
          <div class="stat-sub">${lowShare.toFixed(1)}% of tracked txs</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Lending Markets Live</div>
          <div class="stat-value">${fmtNumber(data.lendingLive)}</div>
          <div class="stat-sub">SUI + USDC lenses</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Stablecoin Supply</div>
          <div class="stat-value">$${fmtCompact(data.stableTotalSupply)}</div>
          <div class="stat-sub">on-chain aggregate</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">LST TVL Proxy</div>
          <div class="stat-value">$${fmtCompact(data.lstTotalMcap)}</div>
          <div class="stat-sub">supply * implied price</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">SUI Spot</div>
          <div class="stat-value">$${data.suiPrice ? data.suiPrice.toFixed(4) : "—"}</div>
          <div class="stat-sub">DeepBook routed</div>
        </div>
      </div>
      ${renderDefiCoveragePanel(sampleCoverage, "DeFi Overview Sampling Coverage")}
      ${parityCard}

      ${historyCard}
      ${signals}
      ${methods}

      <div class="card u-mb16">
        <div class="card-header">Top Protocol Activity <span class="type-tag">Selected Window</span></div>
        <div class="card-body">
          ${top.length ? `<table>
            <thead><tr><th>Protocol</th><th>Category</th><th>Confidence</th><th class="u-ta-right">Tx Count</th><th class="u-ta-right">Success</th><th>Package</th><th>Latest Tx</th><th>Time</th></tr></thead>
            <tbody>
              ${top.map(p => {
                const succ = p.txCount ? (p.successCount / p.txCount * 100) : 0;
                const color = defiCategoryColor(p.category);
                return `<tr>
                  <td class="u-fw-600">${escapeHtml(p.display)}</td>
                  <td><span class="badge" style="color:${color};background:${color}22">${escapeHtml(p.category)}</span></td>
                  <td>${defiConfidenceBadge(p.confidence)}</td>
                  <td class="u-ta-right-mono">${fmtNumber(p.txCount)}</td>
                  <td class="u-ta-right-mono">${succ.toFixed(1)}%</td>
                  <td>${p.package ? hashLink(p.package, '/object/' + p.package) : '<span class="u-c-dim">—</span>'}</td>
                  <td>${p.latestTx ? hashLink(p.latestTx, '/tx/' + p.latestTx) : '<span class="u-c-dim">—</span>'}</td>
                  <td>${timeTag(p.latestTs)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty("No protocol activity detected in the selected window.")}
        </div>
      </div>

      <div class="card u-mb16">
        <div class="card-header">Category Breakdown</div>
        <div class="card-body">
          ${cats.length ? `<table>
            <thead><tr><th>Category</th><th class="u-ta-right">Tx Count</th><th class="u-ta-right">Share</th></tr></thead>
            <tbody>
              ${cats.map(c => {
                const share = c.txCount / totalCategoryTx * 100;
                const color = defiCategoryColor(c.category);
                return `<tr>
                  <td><span class="badge" style="color:${color};background:${color}22">${escapeHtml(c.category)}</span></td>
                  <td class="u-ta-right-mono">${fmtNumber(c.txCount)}</td>
                  <td class="u-ta-right-mono">${share.toFixed(1)}%</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty("No category data available.")}
        </div>
      </div>

      <div class="card">
        <div class="card-header">DeFi Quick Views</div>
        <div class="card-body" style="padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px">
          <a href="#/defi-rates" class="hash-link u-panel-sm">Lending Markets</a>
          <a href="#/defi-dex" class="hash-link u-panel-sm">DEX</a>
          <a href="#/defi-stablecoins" class="hash-link u-panel-sm">Stablecoins</a>
          <a href="#/defi-flows" class="hash-link u-panel-sm">Volume</a>
        </div>
      </div>
    `;
  }

  const setDefiOverviewCategory = (v) => {
    categoryFilter = v || "all";
    persistDefiOverviewState();
    app.innerHTML = renderContent();
  };
  const setDefiOverviewSort = (v) => {
    sortKey = v || "tx";
    persistDefiOverviewState();
    app.innerHTML = renderContent();
  };
  const setDefiOverviewWindow = async (v) => {
    windowKey = normalizeDefiWindowKey(v);
    persistDefiOverviewState();
    app.innerHTML = renderLoading();
    data = await fetchDefiOverviewSnapshot(windowKey, false);
    if (!isActiveRoute()) return;
    historyReqId += 1;
    parityReqId += 1;
    historyData = null;
    historyErr = "";
    historyLoading = true;
    parityData = null;
    parityErr = "";
    parityLoading = true;
    app.innerHTML = renderContent();
    setTimeout(() => {
      if (!isActiveRoute()) return;
      loadHistory(false).catch(() => {});
      loadParity(false).catch(() => {});
    }, 0);
  };
  const setDefiHistoryMetric = async (v) => {
    historyMetric = v === "object" ? "object" : "network";
    persistDefiOverviewState();
    await loadHistory(false);
  };
  const setDefiHistoryRange = async (v) => {
    historyRange = DEFI_HISTORY_PRESETS[v] ? v : "1W";
    persistDefiOverviewState();
    await loadHistory(false);
  };
  const applyDefiHistoryObject = async () => {
    const obj = document.getElementById("defi-hist-object")?.value?.trim() || "";
    const fmt = document.getElementById("defi-hist-format")?.value?.trim() || "";
    if (obj) historyObject = obj;
    if (fmt) historyFormat = fmt;
    persistDefiOverviewState();
    await loadHistory(true);
  };
  const refreshDefiHistory = async () => {
    await loadHistory(true);
  };
  const refreshDefiOverview = async () => {
    app.innerHTML = renderLoading();
    data = await fetchDefiOverviewSnapshot(windowKey, true);
    if (!isActiveRoute()) return;
    historyReqId += 1;
    parityReqId += 1;
    historyData = null;
    historyErr = "";
    historyLoading = true;
    parityData = null;
    parityErr = "";
    parityLoading = true;
    app.innerHTML = renderContent();
    setTimeout(() => {
      if (!isActiveRoute()) return;
      loadHistory(true).catch(() => {});
      loadParity(true).catch(() => {});
    }, 0);
  };
  if (app._defiOverviewChangeHandler) app.removeEventListener("change", app._defiOverviewChangeHandler);
  app._defiOverviewChangeHandler = async (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "defi-overview-category") {
      setDefiOverviewCategory(target.value);
      return;
    }
    if (action === "defi-overview-sort") {
      setDefiOverviewSort(target.value);
      return;
    }
    if (action === "defi-overview-window") {
      await setDefiOverviewWindow(target.value);
      return;
    }
    if (action === "defi-history-metric") {
      await setDefiHistoryMetric(target.value);
      return;
    }
    if (action === "defi-history-range") {
      await setDefiHistoryRange(target.value);
    }
  };
  app.addEventListener("change", app._defiOverviewChangeHandler);
  if (app._defiOverviewClickHandler) app.removeEventListener("click", app._defiOverviewClickHandler);
  app._defiOverviewClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (!action) return;
    if (action === "defi-history-apply") {
      ev.preventDefault();
      await applyDefiHistoryObject();
      return;
    }
    if (action === "defi-history-refresh") {
      ev.preventDefault();
      await refreshDefiHistory();
      return;
    }
    if (action === "defi-overview-refresh") {
      ev.preventDefault();
      await refreshDefiOverview();
    }
  };
  app.addEventListener("click", app._defiOverviewClickHandler);
  historyLoading = true;
  parityLoading = true;
  app.innerHTML = renderContent();
  setTimeout(() => {
    if (!isActiveRoute()) return;
    loadHistory(false).catch(() => {});
    loadParity(false).catch(() => {});
  }, 0);
}

// ── DeFi DEX ───────────────────────────────────────────────────────────
async function renderDefiDex(app) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const routeParams = splitRouteAndParams(getRoute()).params;
  let windowKey = normalizeDefiWindowKey(routeParams.get("w"));
  let data = await fetchDefiDexSnapshot(windowKey);
  let unresolvedFallback = [];
  let fallbackLoaded = false;
  let fallbackLoading = false;

  async function loadDexFallback(force = false) {
    if (fallbackLoading) return Promise.resolve();
    if (fallbackLoaded && !force) return Promise.resolve();
    fallbackLoading = true;
    try {
      const pkg = await fetchPackageActivitySnapshot(windowKey, force);
      unresolvedFallback = (pkg?.unresolvedPackages || []).slice(0, 20);
      fallbackLoaded = true;
    } catch (e) { /* ignore */ }
    finally {
      fallbackLoading = false;
    }
  }

  if (!(data?.dexProtocols || []).length) {
    const cachedFallback = peekTimedCache(getKeyedCacheState(packageActivityCacheByWindow, windowKey), PACKAGE_ACTIVITY_TTL_MS);
    if (cachedFallback) {
      unresolvedFallback = (cachedFallback.unresolvedPackages || []).slice(0, 20);
      fallbackLoaded = true;
    }
  }
  let query = routeParams.get("q") || "";
  let sortKey = ["tx", "success", "latest", "name"].includes(routeParams.get("sort")) ? routeParams.get("sort") : "tx";
  let statusFilter = ["all", "success", "failed"].includes(routeParams.get("status")) ? routeParams.get("status") : "all";

  function persistDefiDexState() {
    setRouteParams({
      w: windowKey !== DEFI_WINDOW_DEFAULT_KEY ? windowKey : null,
      q: query || null,
      sort: sortKey !== "tx" ? sortKey : null,
      status: statusFilter !== "all" ? statusFilter : null,
    });
  }

  function rankedProtocols() {
    let rows = [...(data.dexProtocols || [])];
    if (query) rows = rows.filter(r => String(r.display || "").toLowerCase().includes(query.toLowerCase()));
    if (sortKey === "success") rows.sort((a, b) => ((b.txCount ? b.successCount / b.txCount : 0) - (a.txCount ? a.successCount / a.txCount : 0)));
    else if (sortKey === "latest") rows.sort((a, b) => new Date(b.latestTs || 0).getTime() - new Date(a.latestTs || 0).getTime());
    else if (sortKey === "name") rows.sort((a, b) => String(a.display || "").localeCompare(String(b.display || "")));
    else rows.sort((a, b) => (b.txCount || 0) - (a.txCount || 0));
    return rows;
  }

  function recentRows() {
    let rows = [...(data.dexTxRows || [])];
    if (statusFilter !== "all") rows = rows.filter(r => statusFilter === "success" ? r.status === "SUCCESS" : r.status !== "SUCCESS");
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(tx => {
        const labels = tx.protocols.filter(p => p.category === "dex").map(p => p.display.toLowerCase());
        return labels.some(v => v.includes(q));
      });
    }
    rows.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return rows;
  }

  function renderContent() {
    const top = rankedProtocols();
    const recent = recentRows();
    const fallbackRows = unresolvedFallback
      .filter(r => !query || String(r.package || "").toLowerCase().includes(query.toLowerCase()))
      .slice(0, 15);
    const coverage = data.coverage || {};
    const sampleCoverage = data.window || {};
    const tracked = coverage.trackedTxs || 0;
    const lowShare = tracked ? (coverage.lowConfidenceTx || 0) / tracked * 100 : 0;
    const dexEmptyReason = emptyStateReason(sampleCoverage, top.length, coverage.unresolvedProtocols || fallbackRows.length);
    const scope = renderDefiScopeBar({
      sampleLabel: `${sampleCoverage.windowLabel || "Fast"} window · ${fmtNumber(data.sampleSize)} programmable txs`,
      fetchedAt: data.fetchedAt,
      ttlMs: DEFI_DEX_TTL_MS,
      refreshAction: "defi-dex-refresh",
      leftControls: `
        ${renderDefiWindowSelect(windowKey, "defi-dex-window")}
        <input type="text" data-action="defi-dex-query" value="${escapeAttr(query)}" placeholder="Filter protocol..." class="ui-control" style="min-width:150px" />
        <span class="u-fs12-dim">Sort</span>
        <select data-action="defi-dex-sort" class="ui-control">
          <option value="tx" ${sortKey === "tx" ? "selected" : ""}>Tx Count</option>
          <option value="success" ${sortKey === "success" ? "selected" : ""}>Success %</option>
          <option value="latest" ${sortKey === "latest" ? "selected" : ""}>Latest</option>
          <option value="name" ${sortKey === "name" ? "selected" : ""}>Name</option>
        </select>
        <span class="u-fs12-dim">Status</span>
        <select data-action="defi-dex-status" class="ui-control">
          <option value="all" ${statusFilter === "all" ? "selected" : ""}>All</option>
          <option value="success" ${statusFilter === "success" ? "selected" : ""}>Success</option>
          <option value="failed" ${statusFilter === "failed" ? "selected" : ""}>Failed</option>
        </select>
      `,
    });
    const methods = renderDefiMethodCard([
      "DEX rows are filtered from recent programmable transactions by mapped protocol category = dex.",
      "Sampling uses the same deterministic window dataset shared across DeFi pages.",
      "Protocol identity is inferred from move-call package addresses and MVR reverse resolution.",
      "Coverage tracks how many DEX rows are high/medium/low-confidence mappings.",
      "SUI spot price is included for cross-page context (DeepBook SUI/USDC pool).",
    ]);
    const signals = renderDefiSignalsCard(data.signals || []);

    return `
      <div class="page-title">DeFi DEX <span class="type-tag">Activity Snapshot</span></div>
      ${scope}
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-label">DEX Protocols Active</div><div class="stat-value">${fmtNumber(top.length)}</div><div class="stat-sub">in filtered view</div></div>
        <div class="stat-box"><div class="stat-label">DEX Txs In Sample</div><div class="stat-value">${fmtNumber(data.dexTxCount)}</div><div class="stat-sub">from ${fmtNumber(data.sampleSize)} txs</div></div>
        <div class="stat-box"><div class="stat-label">DEX Success Rate</div><div class="stat-value">${(data.successRate * 100).toFixed(1)}%</div><div class="stat-sub">programmable txs</div></div>
        <div class="stat-box"><div class="stat-label">Low-Confidence DEX Txs</div><div class="stat-value" style="color:${lowShare > 25 ? "var(--yellow)" : "var(--text)"}">${fmtNumber(coverage.lowConfidenceTx || 0)}</div><div class="stat-sub">${lowShare.toFixed(1)}% of tracked</div></div>
        <div class="stat-box"><div class="stat-label">Resolved Protocols</div><div class="stat-value">${fmtNumber(coverage.resolvedProtocols || 0)}</div><div class="stat-sub">${fmtNumber(coverage.unresolvedProtocols || 0)} unresolved</div></div>
        <div class="stat-box"><div class="stat-label">SUI Spot</div><div class="stat-value">$${data.suiPrice ? data.suiPrice.toFixed(4) : "—"}</div><div class="stat-sub">DeepBook SUI/USDC</div></div>
      </div>
      ${renderDefiCoveragePanel(sampleCoverage, "DEX Sampling Coverage")}

      ${signals}
      ${methods}

      <div class="card u-mb16">
        <div class="card-header">DEX Protocol Rankings</div>
        <div class="card-body">
          ${top.length ? `<table>
            <thead><tr><th>Protocol</th><th>Confidence</th><th class="u-ta-right">Tx Count</th><th class="u-ta-right">Success</th><th>Package</th><th>Latest Tx</th><th>Time</th></tr></thead>
            <tbody>
              ${top.map(p => {
                const succ = p.txCount ? (p.successCount / p.txCount * 100) : 0;
                return `<tr>
                  <td class="u-fw-600">${escapeHtml(p.display)}</td>
                  <td>${defiConfidenceBadge(p.confidence)}</td>
                  <td class="u-ta-right-mono">${fmtNumber(p.txCount)}</td>
                  <td class="u-ta-right-mono">${succ.toFixed(1)}%</td>
                  <td>${p.package ? hashLink(p.package, '/object/' + p.package) : "—"}</td>
                  <td>${p.latestTx ? hashLink(p.latestTx, '/tx/' + p.latestTx) : "—"}</td>
                  <td>${timeTag(p.latestTs)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty(dexEmptyReason)}
        </div>
      </div>

      ${!top.length && (fallbackRows.length || fallbackLoading) ? `
      <div class="card u-mb16">
        <div class="card-header">Active Unclassified Packages <span class="type-tag">Fallback</span></div>
        <div class="card-body">
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">No DEX-tagged protocols were resolved. Showing high-activity unresolved packages from the same sampling window.</div>
          ${fallbackRows.length ? `<table>
            <thead><tr><th>Package</th><th class="u-ta-right">Tx Count</th><th class="u-ta-right">Call Count</th></tr></thead>
            <tbody>
              ${fallbackRows.map(r => `<tr>
                <td>${hashLink(r.package, '/object/' + r.package)}</td>
                <td class="u-ta-right-mono">${fmtNumber(r.txCount)}</td>
                <td class="u-ta-right-mono">${fmtNumber(r.callCount)}</td>
              </tr>`).join("")}
            </tbody>
          </table>` : `<div style="padding:8px 0">${renderLoading()}</div>`}
        </div>
      </div>` : ""}

      <div class="card">
        <div class="card-header">Recent DEX Transactions</div>
        <div class="card-body">
          ${recent.length ? `<table>
            <thead><tr><th>Tx</th><th>Protocols</th><th>Sender</th><th>Status</th><th>Time</th></tr></thead>
            <tbody>
              ${recent.slice(0, 60).map(tx => {
                const labels = tx.protocols.filter(p => p.category === "dex").map(p => p.display);
                const shown = labels.length ? labels.join(", ") : tx.protocols.map(p => p.display).join(", ");
                return `<tr>
                  <td>${hashLink(tx.digest, '/tx/' + tx.digest)}</td>
                  <td class="u-fs12">${escapeHtml(shown)}</td>
                  <td>${tx.sender ? hashLink(tx.sender, '/address/' + tx.sender) : "—"}</td>
                  <td>${statusBadge(tx.status)}</td>
                  <td>${timeTag(tx.timestamp)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty(emptyStateReason(sampleCoverage, recent.length, coverage.unresolvedProtocols || fallbackRows.length))}
        </div>
      </div>
    `;
  }

  const setDefiDexQuery = (v) => {
    query = String(v || "");
    persistDefiDexState();
    app.innerHTML = renderContent();
  };
  const setDefiDexSort = (v) => {
    sortKey = ["tx", "success", "latest", "name"].includes(v) ? v : "tx";
    persistDefiDexState();
    app.innerHTML = renderContent();
  };
  const setDefiDexStatus = (v) => {
    statusFilter = ["all", "success", "failed"].includes(v) ? v : "all";
    persistDefiDexState();
    app.innerHTML = renderContent();
  };
  const setDefiDexWindow = async (v) => {
    windowKey = normalizeDefiWindowKey(v);
    persistDefiDexState();
    app.innerHTML = renderLoading();
    fallbackLoaded = false;
    fallbackLoading = false;
    unresolvedFallback = [];
    data = await fetchDefiDexSnapshot(windowKey, false);
    if (!isActiveRoute()) return;
    app.innerHTML = renderContent();
    if (!(data?.dexProtocols || []).length) {
      const pendingFallback = loadDexFallback(false);
      app.innerHTML = renderContent();
      pendingFallback.finally(() => {
        if (isActiveRoute()) app.innerHTML = renderContent();
      });
    }
  };
  const refreshDefiDex = async () => {
    app.innerHTML = renderLoading();
    data = await fetchDefiDexSnapshot(windowKey, true);
    if (!isActiveRoute()) return;
    fallbackLoaded = false;
    fallbackLoading = false;
    unresolvedFallback = [];
    app.innerHTML = renderContent();
    if (!(data?.dexProtocols || []).length) {
      const pendingFallback = loadDexFallback(true);
      app.innerHTML = renderContent();
      pendingFallback.finally(() => {
        if (isActiveRoute()) app.innerHTML = renderContent();
      });
    }
  };
  if (app._defiDexInputHandler) app.removeEventListener("input", app._defiDexInputHandler);
  const _debouncedDexQuery = debounce((val) => setDefiDexQuery(val), 300);
  app._defiDexInputHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute("data-action") !== "defi-dex-query") return;
    _debouncedDexQuery(target.value || "");
  };
  app.addEventListener("input", app._defiDexInputHandler);
  if (app._defiDexChangeHandler) app.removeEventListener("change", app._defiDexChangeHandler);
  app._defiDexChangeHandler = async (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "defi-dex-sort") {
      setDefiDexSort(target.value);
      return;
    }
    if (action === "defi-dex-status") {
      setDefiDexStatus(target.value);
      return;
    }
    if (action === "defi-dex-window") {
      await setDefiDexWindow(target.value);
    }
  };
  app.addEventListener("change", app._defiDexChangeHandler);
  if (app._defiDexClickHandler) app.removeEventListener("click", app._defiDexClickHandler);
  app._defiDexClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    if (trigger.getAttribute("data-action") !== "defi-dex-refresh") return;
    ev.preventDefault();
    await refreshDefiDex();
  };
  app.addEventListener("click", app._defiDexClickHandler);
  app.innerHTML = renderContent();
  if (!(data?.dexProtocols || []).length && !fallbackLoaded) {
    const pendingFallback = loadDexFallback(false);
    app.innerHTML = renderContent();
    pendingFallback.finally(() => {
      if (isActiveRoute()) app.innerHTML = renderContent();
    });
  }
}

// ── DeFi Stablecoins ───────────────────────────────────────────────────
async function renderDefiStablecoins(app) {
  const routeParams = splitRouteAndParams(getRoute()).params;
  let windowKey = normalizeDefiWindowKey(routeParams.get("w"));
  let data = await fetchDefiStablecoinSnapshot(windowKey);
  let query = routeParams.get("q") || "";
  let sortKey = ["supply", "share", "flow", "changes", "symbol"].includes(routeParams.get("sort")) ? routeParams.get("sort") : "supply";
  const minFlowParam = Number(routeParams.get("min") || 0);
  let minFlowUsd = [0, 100000, 500000, 1000000].includes(minFlowParam) ? minFlowParam : 0;

  function persistDefiStableState() {
    setRouteParams({
      w: windowKey !== DEFI_WINDOW_DEFAULT_KEY ? windowKey : null,
      q: query || null,
      sort: sortKey !== "supply" ? sortKey : null,
      min: minFlowUsd > 0 ? minFlowUsd : null,
    });
  }

  function sortedCoins() {
    let rows = [...(data.coins || [])];
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(c => String(c.symbol || "").toLowerCase().includes(q));
    }
    if (sortKey === "flow") rows.sort((a, b) => (b.recentFlowUsd || 0) - (a.recentFlowUsd || 0));
    else if (sortKey === "share") rows.sort((a, b) => (b.pct || 0) - (a.pct || 0));
    else if (sortKey === "changes") rows.sort((a, b) => (b.recentChanges || 0) - (a.recentChanges || 0));
    else if (sortKey === "symbol") rows.sort((a, b) => String(a.symbol || "").localeCompare(String(b.symbol || "")));
    else rows.sort((a, b) => (b.supply || 0) - (a.supply || 0));
    return rows;
  }

  function filteredFlows() {
    let rows = [...(data.topFlows || [])];
    if (minFlowUsd > 0) rows = rows.filter(r => (r.usdValue || 0) >= minFlowUsd);
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(r => String(r.symbol || "").toLowerCase().includes(q) || String(r.protocol || "").toLowerCase().includes(q));
    }
    rows.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    return rows;
  }

  function renderContent() {
    const coins = sortedCoins();
    const flows = filteredFlows();
    const topCoin = coins[0];
    const total = data.totalSupply || 0;
    const coverage = data.coverage || {};
    const sampleCoverage = data.window || {};
    const flowRows = coverage.flowRows || 0;
    const lowFlowShare = flowRows ? ((coverage.lowConfidenceFlowRows || 0) / flowRows * 100) : 0;
    const scope = renderDefiScopeBar({
      sampleLabel: `Supply objects + ${sampleCoverage.windowLabel || "Fast"} tx window (${fmtNumber(coverage.sampleTxs || 0)} txs)`,
      fetchedAt: data.fetchedAt,
      ttlMs: DEFI_STABLECOINS_TTL_MS,
      refreshAction: "defi-stable-refresh",
      leftControls: `
        ${renderDefiWindowSelect(windowKey, "defi-stable-window")}
        <input type="text" data-action="defi-stable-query" value="${escapeAttr(query)}" placeholder="Filter symbol/protocol..." class="ui-control" style="min-width:160px" />
        <span class="u-fs12-dim">Sort</span>
        <select data-action="defi-stable-sort" class="ui-control">
          <option value="supply" ${sortKey === "supply" ? "selected" : ""}>Supply</option>
          <option value="share" ${sortKey === "share" ? "selected" : ""}>Share</option>
          <option value="flow" ${sortKey === "flow" ? "selected" : ""}>Recent Flow</option>
          <option value="changes" ${sortKey === "changes" ? "selected" : ""}>Changes</option>
          <option value="symbol" ${sortKey === "symbol" ? "selected" : ""}>Symbol</option>
        </select>
        <span class="u-fs12-dim">Min Flow</span>
        <select data-action="defi-stable-min-flow" class="ui-control">
          <option value="0" ${minFlowUsd === 0 ? "selected" : ""}>All</option>
          <option value="100000" ${minFlowUsd === 100000 ? "selected" : ""}>$100k+</option>
          <option value="500000" ${minFlowUsd === 500000 ? "selected" : ""}>$500k+</option>
          <option value="1000000" ${minFlowUsd === 1000000 ? "selected" : ""}>$1M+</option>
        </select>
      `,
    });
    const methods = renderDefiMethodCard([
      "Supply values come from on-chain stablecoin supply objects (coin metadata or protocol treasury fields).",
      "Flow rows are aggregated from balance changes in the recent programmable transaction sample.",
      "Protocol labels for flows are mapped from move-call package addresses using MVR reverse resolution.",
      "Coverage highlights low-confidence or unknown protocol attributions in sampled flow rows.",
    ]);
    const signals = renderDefiSignalsCard(data.signals || []);

    return `
      <div class="page-title">DeFi Stablecoins <span class="type-tag">On-Chain Supply + Flow</span></div>
      ${scope}
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-label">Total Supply</div><div class="stat-value">$${fmtCompact(total)}</div><div class="stat-sub">${coins.length} tracked coins</div></div>
        <div class="stat-box"><div class="stat-label">Largest Stablecoin</div><div class="stat-value">${topCoin ? topCoin.symbol : "—"}</div><div class="stat-sub">${topCoin ? topCoin.pct.toFixed(1) + "%" : "—"} share</div></div>
        <div class="stat-box"><div class="stat-label">Sampled Flow (USD)</div><div class="stat-value">$${fmtCompact(data.totalRecentFlowUsd || 0)}</div><div class="stat-sub">recent ${fmtNumber(coverage.sampleTxs || 0)} programmable txs</div></div>
        <div class="stat-box"><div class="stat-label">Low-Confidence Flows</div><div class="stat-value" style="color:${lowFlowShare > 25 ? "var(--yellow)" : "var(--text)"}">${fmtNumber(coverage.lowConfidenceFlowRows || 0)}</div><div class="stat-sub">${lowFlowShare.toFixed(1)}% of flow rows</div></div>
        <div class="stat-box"><div class="stat-label">Resolved Packages</div><div class="stat-value">${fmtNumber(coverage.resolvedPackages || 0)}</div><div class="stat-sub">${fmtNumber(coverage.unresolvedPackages || 0)} unresolved</div></div>
        <div class="stat-box"><div class="stat-label">Unknown Flow Rows</div><div class="stat-value">${fmtNumber(coverage.unknownFlowRows || 0)}</div><div class="stat-sub">protocol = unknown or low-confidence</div></div>
      </div>
      ${renderDefiCoveragePanel(sampleCoverage, "Stablecoin Flow Sampling Coverage")}

      ${signals}
      ${methods}

      <div class="card u-mb16">
        <div class="card-header">Supply Distribution</div>
        <div class="card-body">
          ${coins.length ? `<div class="stablecoin-layout">
            ${renderDonutChart(coins, total)}
            <ul class="stablecoin-legend">
              ${coins.slice(0, 12).map(c => `
                <li><span class="dot" style="background:${c.color}"></span><span>${c.symbol}</span>
                  <span class="val">$${fmtCompact(c.supply)}</span>
                  <span class="pct">${c.pct.toFixed(1)}%</span>
                </li>`).join("")}
            </ul>
          </div>` : renderEmpty("No stablecoin supply data found.")}
        </div>
      </div>

      <div class="card u-mb16">
        <div class="card-header">Supply + Flow Table</div>
        <div class="card-body">
          ${coins.length ? `<table>
            <thead><tr><th>Symbol</th><th class="u-ta-right">Supply (USD)</th><th class="u-ta-right">Share</th><th class="u-ta-right">Recent Flow (USD)</th><th class="u-ta-right">Changes</th></tr></thead>
            <tbody>
              ${coins.map(c => `<tr>
                <td class="u-fw-600">${c.symbol}</td>
                <td class="u-ta-right-mono">$${fmtCompact(c.supply)}</td>
                <td class="u-ta-right-mono">${c.pct.toFixed(2)}%</td>
                <td class="u-ta-right-mono">$${fmtCompact(c.recentFlowUsd || 0)}</td>
                <td class="u-ta-right-mono">${fmtNumber(c.recentChanges || 0)}</td>
              </tr>`).join("")}
            </tbody>
          </table>` : renderEmpty("No stablecoin table data found.")}
        </div>
      </div>

      <div class="card">
        <div class="card-header">Recent Large Stablecoin Flows</div>
        <div class="card-body">
          ${flows.length ? `<table>
            <thead><tr><th>Token</th><th class="u-ta-right">Amount</th><th class="u-ta-right">USD</th><th>Protocol</th><th>Conf.</th><th>Owner</th><th>Tx</th><th>Time</th></tr></thead>
            <tbody>
              ${flows.slice(0, 60).map(f => `<tr>
                <td class="u-fw-600">${f.symbol}</td>
                <td class="u-ta-right-mono">${f.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                <td class="u-ta-right-mono">$${fmtCompact(f.usdValue)}</td>
                <td class="u-fs12">${escapeHtml(f.protocol)}</td>
                <td>${defiConfidenceBadge(f.protocolConfidence)}</td>
                <td>${f.owner ? hashLink(f.owner, '/address/' + f.owner) : "—"}</td>
                <td>${hashLink(f.digest, '/tx/' + f.digest)}</td>
                <td>${timeTag(f.timestamp)}</td>
              </tr>`).join("")}
            </tbody>
          </table>` : renderEmpty("No sampled stablecoin flow data for current filters.")}
        </div>
      </div>
    `;
  }

  const setDefiStableQuery = (v) => {
    query = String(v || "");
    persistDefiStableState();
    app.innerHTML = renderContent();
  };
  const setDefiStableSort = (v) => {
    sortKey = ["supply", "share", "flow", "changes", "symbol"].includes(v) ? v : "supply";
    persistDefiStableState();
    app.innerHTML = renderContent();
  };
  const setDefiStableMinFlow = (v) => {
    const n = Number(v || 0);
    minFlowUsd = Number.isFinite(n) ? n : 0;
    persistDefiStableState();
    app.innerHTML = renderContent();
  };
  const setDefiStableWindow = async (v) => {
    windowKey = normalizeDefiWindowKey(v);
    persistDefiStableState();
    app.innerHTML = renderLoading();
    data = await fetchDefiStablecoinSnapshot(windowKey, false);
    app.innerHTML = renderContent();
  };
  const refreshDefiStablecoins = async () => {
    app.innerHTML = renderLoading();
    data = await fetchDefiStablecoinSnapshot(windowKey, true);
    app.innerHTML = renderContent();
  };
  if (app._defiStableInputHandler) app.removeEventListener("input", app._defiStableInputHandler);
  const _debouncedStableQuery = debounce((val) => setDefiStableQuery(val), 300);
  app._defiStableInputHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute("data-action") !== "defi-stable-query") return;
    _debouncedStableQuery(target.value || "");
  };
  app.addEventListener("input", app._defiStableInputHandler);
  if (app._defiStableChangeHandler) app.removeEventListener("change", app._defiStableChangeHandler);
  app._defiStableChangeHandler = async (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "defi-stable-sort") {
      setDefiStableSort(target.value);
      return;
    }
    if (action === "defi-stable-min-flow") {
      setDefiStableMinFlow(target.value);
      return;
    }
    if (action === "defi-stable-window") {
      await setDefiStableWindow(target.value);
    }
  };
  app.addEventListener("change", app._defiStableChangeHandler);
  if (app._defiStableClickHandler) app.removeEventListener("click", app._defiStableClickHandler);
  app._defiStableClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    if (trigger.getAttribute("data-action") !== "defi-stable-refresh") return;
    ev.preventDefault();
    await refreshDefiStablecoins();
  };
  app.addEventListener("click", app._defiStableClickHandler);
  app.innerHTML = renderContent();
}

// ── DeFi Staking + LST ────────────────────────────────────────────────
async function renderDefiLst(app) {
  const routeParams = splitRouteAndParams(getRoute()).params;
  let data = await fetchDefiLstSnapshot();
  let query = routeParams.get("q") || "";
  let sortKey = ["mcap", "premium", "rate", "supply", "symbol"].includes(routeParams.get("sort")) ? routeParams.get("sort") : "mcap";

  function persistDefiLstState() {
    setRouteParams({
      q: query || null,
      sort: sortKey !== "mcap" ? sortKey : null,
    });
  }

  function sortedRows() {
    let rows = [...(data.entries || [])];
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(r => String(r.symbol || "").toLowerCase().includes(q) || String(r.protocol || "").toLowerCase().includes(q));
    }
    if (sortKey === "premium") rows.sort((a, b) => (b.premiumPct || 0) - (a.premiumPct || 0));
    else if (sortKey === "rate") rows.sort((a, b) => (b.exchangeRate || 0) - (a.exchangeRate || 0));
    else if (sortKey === "supply") rows.sort((a, b) => (b.supply || 0) - (a.supply || 0));
    else if (sortKey === "symbol") rows.sort((a, b) => String(a.symbol || "").localeCompare(String(b.symbol || "")));
    else rows.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
    return rows;
  }

  function renderContent() {
    const rows = sortedRows();
    const coverage = data.coverage || {};
    const highShare = rows.length ? ((coverage.highConfidenceRows || 0) / rows.length * 100) : 0;
    const scope = renderDefiScopeBar({
      sampleLabel: `${fmtNumber(rows.length)} tracked LST assets`,
      fetchedAt: data.fetchedAt,
      ttlMs: DEFI_LST_TTL_MS,
      refreshAction: "defi-lst-refresh",
      leftControls: `
        <input type="text" data-action="defi-lst-query" value="${escapeAttr(query)}" placeholder="Filter LST/protocol..." class="ui-control" style="min-width:160px" />
        <span class="u-fs12-dim">Sort</span>
        <select data-action="defi-lst-sort" class="ui-control">
          <option value="mcap" ${sortKey === "mcap" ? "selected" : ""}>Market Cap</option>
          <option value="premium" ${sortKey === "premium" ? "selected" : ""}>Premium</option>
          <option value="rate" ${sortKey === "rate" ? "selected" : ""}>Rate</option>
          <option value="supply" ${sortKey === "supply" ? "selected" : ""}>Supply</option>
          <option value="symbol" ${sortKey === "symbol" ? "selected" : ""}>Symbol</option>
        </select>
      `,
    });
    const methods = renderDefiMethodCard([
      "Exchange rates are read from on-chain LST rate objects when available.",
      "Implied USD price = SUI spot price * LST-to-SUI exchange rate.",
      "Implied market cap = token supply * implied USD price.",
      "Coverage marks rows as high/medium/low confidence based on rate source + supply source availability.",
    ]);
    const signals = renderDefiSignalsCard(data.signals || []);

    return `
      <div class="page-title">DeFi Staking & LST <span class="type-tag">Exchange Rate Monitor</span></div>
      ${scope}
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-label">LST Tokens</div><div class="stat-value">${rows.length}</div><div class="stat-sub">tracked in-app</div></div>
        <div class="stat-box"><div class="stat-label">Implied TVL</div><div class="stat-value">$${fmtCompact(data.totalMcap || 0)}</div><div class="stat-sub">supply * implied price</div></div>
        <div class="stat-box"><div class="stat-label">Avg Exchange Rate</div><div class="stat-value">${(data.avgRate || 0).toFixed(4)}x</div><div class="stat-sub">LST -> SUI</div></div>
        <div class="stat-box"><div class="stat-label">High-Confidence Rows</div><div class="stat-value" style="color:${highShare < 50 ? "var(--yellow)" : "var(--green)"}">${fmtNumber(coverage.highConfidenceRows || 0)}</div><div class="stat-sub">${highShare.toFixed(1)}% of rows</div></div>
        <div class="stat-box"><div class="stat-label">Missing Supply Rows</div><div class="stat-value">${fmtNumber(coverage.missingSupplyRows || 0)}</div><div class="stat-sub">supply source unavailable</div></div>
        <div class="stat-box"><div class="stat-label">Derived Rate Rows</div><div class="stat-value">${fmtNumber(coverage.derivedRateRows || 0)}</div><div class="stat-sub">proxy instead of direct object</div></div>
        <div class="stat-box"><div class="stat-label">SUI Spot</div><div class="stat-value">$${defiPrices.SUI ? defiPrices.SUI.toFixed(4) : "—"}</div><div class="stat-sub">DeepBook routed</div></div>
      </div>

      ${signals}
      ${methods}

      <div class="card">
        <div class="card-header">LST Details</div>
        <div class="card-body">
          ${rows.length ? `<table>
            <thead><tr><th>LST</th><th>Protocol</th><th>Confidence</th><th class="u-ta-right">Rate (SUI)</th><th class="u-ta-right">Premium</th><th class="u-ta-right">Implied Price</th><th class="u-ta-right">Supply</th><th class="u-ta-right">Market Cap</th><th>Rate Source</th><th>Supply Source</th><th>Object</th></tr></thead>
            <tbody>
              ${rows.map(r => {
                const premColor = r.premiumPct > 0.5 ? "var(--green)" : r.premiumPct < -0.5 ? "var(--red)" : "var(--text)";
                return `<tr>
                  <td class="u-fw-600">${r.symbol}</td>
                  <td>${escapeHtml(r.protocol)}</td>
                  <td>${defiConfidenceBadge(r.confidence)}</td>
                  <td class="u-ta-right-mono">${r.exchangeRate.toFixed(6)}x</td>
                  <td style="text-align:right;font-family:var(--mono);color:${premColor}">${r.premiumPct >= 0 ? "+" : ""}${r.premiumPct.toFixed(2)}%</td>
                  <td class="u-ta-right-mono">$${r.impliedPrice.toFixed(4)}</td>
                  <td class="u-ta-right-mono">${fmtCompact(r.supply)}</td>
                  <td class="u-ta-right-mono">$${fmtCompact(r.marketCap)}</td>
                  <td class="u-fs12-dim">${escapeHtml(r.rateSource || "—")}</td>
                  <td class="u-fs12-dim">${escapeHtml(r.supplySource || "—")}</td>
                  <td>${r.sourceObj ? hashLink(r.sourceObj, '/object/' + r.sourceObj) : '<span class="u-c-dim">derived</span>'}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty("No LST data available.")}
        </div>
      </div>
    `;
  }

  const setDefiLstQuery = (v) => {
    query = String(v || "");
    persistDefiLstState();
    app.innerHTML = renderContent();
  };
  const setDefiLstSort = (v) => {
    sortKey = ["mcap", "premium", "rate", "supply", "symbol"].includes(v) ? v : "mcap";
    persistDefiLstState();
    app.innerHTML = renderContent();
  };
  const refreshDefiLst = async () => {
    app.innerHTML = renderLoading();
    data = await fetchDefiLstSnapshot(true);
    app.innerHTML = renderContent();
  };
  if (app._defiLstInputHandler) app.removeEventListener("input", app._defiLstInputHandler);
  const _debouncedLstQuery = debounce((val) => setDefiLstQuery(val), 300);
  app._defiLstInputHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute("data-action") !== "defi-lst-query") return;
    _debouncedLstQuery(target.value || "");
  };
  app.addEventListener("input", app._defiLstInputHandler);
  if (app._defiLstChangeHandler) app.removeEventListener("change", app._defiLstChangeHandler);
  app._defiLstChangeHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute("data-action") !== "defi-lst-sort") return;
    setDefiLstSort(target.value);
  };
  app.addEventListener("change", app._defiLstChangeHandler);
  if (app._defiLstClickHandler) app.removeEventListener("click", app._defiLstClickHandler);
  app._defiLstClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    if (trigger.getAttribute("data-action") !== "defi-lst-refresh") return;
    ev.preventDefault();
    await refreshDefiLst();
  };
  app.addEventListener("click", app._defiLstClickHandler);
  app.innerHTML = renderContent();
}

// ── DeFi Flows ────────────────────────────────────────────────────────
async function renderDefiFlows(app) {
  const routeParams = splitRouteAndParams(getRoute()).params;
  let windowKey = normalizeDefiWindowKey(routeParams.get("w"));
  let data = await fetchDefiFlowSnapshot(windowKey);
  let query = routeParams.get("q") || "";
  let statusFilter = ["all", "success", "failed"].includes(routeParams.get("status")) ? routeParams.get("status") : "all";
  const minUsdParam = Number(routeParams.get("min") || 0);
  let minUsd = [0, 100000, 500000, 1000000].includes(minUsdParam) ? minUsdParam : 0;
  let sortKey = ["usd", "amount", "time"].includes(routeParams.get("sort")) ? routeParams.get("sort") : "usd";

  function persistDefiFlowState() {
    setRouteParams({
      w: windowKey !== DEFI_WINDOW_DEFAULT_KEY ? windowKey : null,
      q: query || null,
      status: statusFilter !== "all" ? statusFilter : null,
      min: minUsd > 0 ? minUsd : null,
      sort: sortKey !== "usd" ? sortKey : null,
    });
  }

  function filteredRows() {
    let rows = [...(data.rows || [])];
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter(r => String(r.protocol || "").toLowerCase().includes(q) || String(r.symbol || "").toLowerCase().includes(q));
    }
    if (statusFilter !== "all") rows = rows.filter(r => statusFilter === "success" ? r.status === "SUCCESS" : r.status !== "SUCCESS");
    if (minUsd > 0) rows = rows.filter(r => (r.usdValue || 0) >= minUsd);
    if (sortKey === "time") rows.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    else if (sortKey === "amount") rows.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    else rows.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    return rows;
  }

  function renderContent() {
    const rows = filteredRows();
    const largest = rows[0];
    const coverage = data.coverage || {};
    const sampleCoverage = data.window || {};
    const totalRows = coverage.flowRows || 0;
    const lowShare = totalRows ? ((coverage.lowConfidenceRows || 0) / totalRows * 100) : 0;
    const flowEmptyReason = emptyStateReason(sampleCoverage, rows.length, coverage.unresolvedPackages || 0);
    const scope = renderDefiScopeBar({
      sampleLabel: `${sampleCoverage.windowLabel || "Fast"} window · ${fmtNumber(coverage.sampleTxs || 0)} programmable txs`,
      fetchedAt: data.fetchedAt,
      ttlMs: DEFI_FLOWS_TTL_MS,
      refreshAction: "defi-flow-refresh",
      leftControls: `
        ${renderDefiWindowSelect(windowKey, "defi-flow-window")}
        <input type="text" data-action="defi-flow-query" value="${escapeAttr(query)}" placeholder="Filter protocol/token..." class="ui-control" style="min-width:160px" />
        <span class="u-fs12-dim">Status</span>
        <select data-action="defi-flow-status" class="ui-control">
          <option value="all" ${statusFilter === "all" ? "selected" : ""}>All</option>
          <option value="success" ${statusFilter === "success" ? "selected" : ""}>Success</option>
          <option value="failed" ${statusFilter === "failed" ? "selected" : ""}>Failed</option>
        </select>
        <span class="u-fs12-dim">Min USD</span>
        <select data-action="defi-flow-min-usd" class="ui-control">
          <option value="0" ${minUsd === 0 ? "selected" : ""}>All</option>
          <option value="100000" ${minUsd === 100000 ? "selected" : ""}>$100k+</option>
          <option value="500000" ${minUsd === 500000 ? "selected" : ""}>$500k+</option>
          <option value="1000000" ${minUsd === 1000000 ? "selected" : ""}>$1M+</option>
        </select>
        <span class="u-fs12-dim">Sort</span>
        <select data-action="defi-flow-sort" class="ui-control">
          <option value="usd" ${sortKey === "usd" ? "selected" : ""}>USD</option>
          <option value="amount" ${sortKey === "amount" ? "selected" : ""}>Amount</option>
          <option value="time" ${sortKey === "time" ? "selected" : ""}>Time</option>
        </select>
      `,
    });
    const methods = renderDefiMethodCard([
      "Flow rows are grouped from transaction balance changes by coin type.",
      "Flow rows are computed from the same deterministic window sample used by DeFi Overview/DEX/Packages.",
      "Only priced rows are shown; rows without an available token price are excluded.",
      "Direction is inferred from signed balance changes (negative sender, positive receiver).",
      "Coverage reports skipped unpriced coin buckets and low-confidence protocol mappings.",
    ]);
    const signals = renderDefiSignalsCard(data.signals || []);

    return `
      <div class="page-title">DeFi Volume <span class="type-tag">Selected Window</span></div>
      ${scope}
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-label">Flow Rows</div><div class="stat-value">${fmtNumber(rows.length)}</div><div class="stat-sub">filtered priced movements</div></div>
        <div class="stat-box"><div class="stat-label">Total USD Flow</div><div class="stat-value">$${fmtCompact(data.totalUsd || 0)}</div><div class="stat-sub">full sample</div></div>
        <div class="stat-box"><div class="stat-label">Largest Flow</div><div class="stat-value">${largest ? "$" + fmtCompact(largest.usdValue) : "—"}</div><div class="stat-sub">${largest ? largest.symbol + " · " + largest.protocol : "—"}</div></div>
        <div class="stat-box"><div class="stat-label">Protocols</div><div class="stat-value">${fmtNumber(data.protocols?.length || 0)}</div><div class="stat-sub">with priced flows</div></div>
        <div class="stat-box"><div class="stat-label">Low-Confidence Rows</div><div class="stat-value" style="color:${lowShare > 25 ? "var(--yellow)" : "var(--text)"}">${fmtNumber(coverage.lowConfidenceRows || 0)}</div><div class="stat-sub">${lowShare.toFixed(1)}% of flow rows</div></div>
        <div class="stat-box"><div class="stat-label">Unpriced Buckets</div><div class="stat-value">${fmtNumber(coverage.unpricedCoinBuckets || 0)}</div><div class="stat-sub">of ${fmtNumber(coverage.coinBucketsSeen || 0)} coin buckets</div></div>
      </div>
      ${renderDefiCoveragePanel(sampleCoverage, "Flows Sampling Coverage")}

      ${signals}
      ${methods}

      <div class="card">
        <div class="card-header">Top Flows by USD</div>
        <div class="card-body">
          ${rows.length ? `<table>
            <thead><tr><th>Protocol</th><th>Token</th><th>Conf.</th><th class="u-ta-right">Amount</th><th class="u-ta-right">USD</th><th>From</th><th>To</th><th>Tx</th><th>Status</th><th>Time</th></tr></thead>
            <tbody>
              ${rows.slice(0, 100).map(r => {
                const catColor = defiCategoryColor(r.category);
                return `<tr>
                  <td><span class="badge" style="color:${catColor};background:${catColor}22">${escapeHtml(r.protocol)}</span></td>
                  <td class="u-fw-600">${r.symbol}</td>
                  <td>${defiConfidenceBadge(r.protocolConfidence)}</td>
                  <td class="u-ta-right-mono">${r.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                  <td class="u-ta-right-mono">$${fmtCompact(r.usdValue)}</td>
                  <td>${r.from ? hashLink(r.from, '/address/' + r.from) : "—"}</td>
                  <td>${r.to ? hashLink(r.to, '/address/' + r.to) : '<span class="u-c-dim">contract</span>'}</td>
                  <td>${hashLink(r.digest, '/tx/' + r.digest)}</td>
                  <td>${statusBadge(r.status)}</td>
                  <td>${timeTag(r.timestamp)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : renderEmpty(flowEmptyReason)}
        </div>
      </div>
    `;
  }

  const setDefiFlowQuery = (v) => {
    query = String(v || "");
    persistDefiFlowState();
    app.innerHTML = renderContent();
  };
  const setDefiFlowStatus = (v) => {
    statusFilter = ["all", "success", "failed"].includes(v) ? v : "all";
    persistDefiFlowState();
    app.innerHTML = renderContent();
  };
  const setDefiFlowMinUsd = (v) => {
    const n = Number(v || 0);
    minUsd = Number.isFinite(n) ? n : 0;
    persistDefiFlowState();
    app.innerHTML = renderContent();
  };
  const setDefiFlowSort = (v) => {
    sortKey = ["usd", "amount", "time"].includes(v) ? v : "usd";
    persistDefiFlowState();
    app.innerHTML = renderContent();
  };
  const setDefiFlowWindow = async (v) => {
    windowKey = normalizeDefiWindowKey(v);
    persistDefiFlowState();
    app.innerHTML = renderLoading();
    data = await fetchDefiFlowSnapshot(windowKey, false);
    app.innerHTML = renderContent();
  };
  const refreshDefiFlows = async () => {
    app.innerHTML = renderLoading();
    data = await fetchDefiFlowSnapshot(windowKey, true);
    app.innerHTML = renderContent();
  };
  if (app._defiFlowInputHandler) app.removeEventListener("input", app._defiFlowInputHandler);
  const _debouncedFlowQuery = debounce((val) => setDefiFlowQuery(val), 300);
  app._defiFlowInputHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute("data-action") !== "defi-flow-query") return;
    _debouncedFlowQuery(target.value || "");
  };
  app.addEventListener("input", app._defiFlowInputHandler);
  if (app._defiFlowChangeHandler) app.removeEventListener("change", app._defiFlowChangeHandler);
  app._defiFlowChangeHandler = async (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "defi-flow-status") {
      setDefiFlowStatus(target.value);
      return;
    }
    if (action === "defi-flow-min-usd") {
      setDefiFlowMinUsd(target.value);
      return;
    }
    if (action === "defi-flow-sort") {
      setDefiFlowSort(target.value);
      return;
    }
    if (action === "defi-flow-window") {
      await setDefiFlowWindow(target.value);
    }
  };
  app.addEventListener("change", app._defiFlowChangeHandler);
  if (app._defiFlowClickHandler) app.removeEventListener("click", app._defiFlowClickHandler);
  app._defiFlowClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    if (trigger.getAttribute("data-action") !== "defi-flow-refresh") return;
    ev.preventDefault();
    await refreshDefiFlows();
  };
  app.addEventListener("click", app._defiFlowClickHandler);
  app.innerHTML = renderContent();
}

// ── DeFi Risk Monitor ────────────────────────────────────────────────
// ── DeFi Lending Markets ────────────────────────────────────────────────
async function renderDefiRates(app) {
  const localRouteToken = routeRenderToken;
  const isActiveRoute = () => isActiveRouteApp(app, localRouteToken);
  const routeParams = splitRouteAndParams(getRoute()).params;
  let token = routeParams.get("asset") || "SUI";
  let sortKey = ["borrow", "supply", "util", "spread", "protocol", "tvl", "borrowed"].includes(routeParams.get("sort")) ? routeParams.get("sort") : "borrow";
  let statusFilter = ["all", "live", "unavailable"].includes(routeParams.get("status")) ? routeParams.get("status") : "all";
  let showAllTokens = routeParams.get("all") === "1";
  let loadErr = "";
  let data = peekTimedCache(lendingRatesCache, LENDING_RATES_TTL_MS) || null;
  let dataLoading = !data;
  let pricesLoading = false;
  let loadReqId = 0;

  function persistDefiRateState() {
    setRouteParams({
      asset: token !== "SUI" ? token : null,
      sort: sortKey !== "borrow" ? sortKey : null,
      status: statusFilter !== "all" ? statusFilter : null,
      all: showAllTokens ? "1" : null,
    });
  }

  const fmtApr = (bps) => {
    if (!Number.isFinite(bps)) return "—";
    const pct = bps / 100;
    return `${pct.toFixed(pct >= 100 ? 1 : 2)}%`;
  };
  const fmtUtil = (u) => Number.isFinite(u) ? `${(u * 100).toFixed(1)}%` : "—";

  function syncDefiRateToken() {
    const available = Object.keys(data?.byToken || {}).filter(t => showAllTokens || isCoreToken(t));
    if (!available.length) return;
    if (available.includes(token)) return;
    token = available.includes("SUI") ? "SUI" : available[0];
  }
  if (data) syncDefiRateToken();

  async function load(force = false, rerender = true) {
    const reqId = ++loadReqId;
    dataLoading = !data;
    pricesLoading = true;
    if (rerender && isActiveRoute()) app.innerHTML = renderContent();
    const [ratesRes, pricesRes] = await Promise.allSettled([
      fetchLendingRatesOverview(force),
      fetchDefiPrices(force),
    ]);
    if (reqId !== loadReqId || !isActiveRoute()) return;
    if (ratesRes.status === "fulfilled") {
      data = ratesRes.value;
      loadErr = "";
      syncDefiRateToken();
    } else {
      data = null;
      loadErr = ratesRes.reason?.message || "Failed to load lending rates.";
    }
    pricesLoading = false;
    if (pricesRes.status === "rejected" && !loadErr && !data) {
      loadErr = pricesRes.reason?.message || "Failed to load lending rates.";
    }
    dataLoading = false;
    if (rerender && isActiveRoute()) app.innerHTML = renderContent();
  }

  function sortedRows(allRows) {
    let rows = [...allRows];
    if (statusFilter !== "all") {
      rows = rows.filter(r => statusFilter === "live" ? !r.error : !!r.error);
    }
    if (sortKey === "supply") rows.sort((a, b) => (b.supplyBps || -Infinity) - (a.supplyBps || -Infinity));
    else if (sortKey === "util") rows.sort((a, b) => (b.utilization || -Infinity) - (a.utilization || -Infinity));
    else if (sortKey === "spread") rows.sort((a, b) => ((b.borrowBps || 0) - (b.supplyBps || 0)) - ((a.borrowBps || 0) - (a.supplyBps || 0)));
    else if (sortKey === "protocol") rows.sort((a, b) => String(a.protocol || "").localeCompare(String(b.protocol || "")));
    else if (sortKey === "tvl") {
      const usd = new Map(rows.map(r => [r, (r.totalSupplyHuman || 0) * (defiPrices[r.token] || 0)]));
      rows.sort((a, b) => usd.get(b) - usd.get(a));
    } else if (sortKey === "borrowed") {
      const usd = new Map(rows.map(r => [r, (r.totalBorrowHuman || 0) * (defiPrices[r.token] || 0)]));
      rows.sort((a, b) => usd.get(b) - usd.get(a));
    }
    else rows.sort((a, b) => (b.borrowBps || -Infinity) - (a.borrowBps || -Infinity));
    return rows;
  }

  function renderContent() {
    if (!data && dataLoading) {
      return `
        <div class="page-title">Lending Markets <span class="type-tag">On-Chain</span></div>
        <div class="card">
          <div class="card-body">${renderLoading()}</div>
        </div>
      `;
    }
    if (loadErr) return `<div class="page-title">Lending Markets</div>${renderEmpty(escapeHtml(loadErr))}`;
    const allRows = data?.byToken?.[token] || [];
    const rows = sortedRows(allRows);
    const live = allRows.filter(r => Number.isFinite(r.borrowBps) && Number.isFinite(r.supplyBps));
    const avgBorrow = live.length ? live.reduce((s, r) => s + r.borrowBps, 0) / live.length : null;
    const avgSupply = live.length ? live.reduce((s, r) => s + r.supplyBps, 0) / live.length : null;
    const price = defiPrices[token] || 0;
    const totalSupplyUsd = live.reduce((s, r) => s + (r.totalSupplyHuman || 0) * price, 0);
    const totalBorrowUsd = live.reduce((s, r) => s + (r.totalBorrowHuman || 0) * price, 0);
    const topBorrow = live.length ? [...live].sort((a, b) => (b.borrowBps || 0) - (a.borrowBps || 0))[0] : null;
    const topUtil = live.length ? [...live].sort((a, b) => (b.utilization || 0) - (a.utilization || 0))[0] : null;
    const unavailable = allRows.length - live.length;
    const signals = [
      topBorrow ? `${topBorrow.protocol} has the top ${token} borrow APR (${fmtApr(topBorrow.borrowBps)}).` : `No live ${token} borrow APR is available.`,
      topUtil ? `${topUtil.protocol} has highest ${token} utilization (${fmtUtil(topUtil.utilization)}).` : `No live ${token} utilization is available.`,
      allRows.length ? `${live.length}/${allRows.length} ${token} markets are live; ${unavailable} unavailable.` : `No ${token} markets returned.`,
    ];
    const scope = renderDefiScopeBar({
      sampleLabel: `${token} lending state across ${fmtNumber(allRows.length)} protocols`,
      fetchedAt: data?.fetchedAt,
      ttlMs: LENDING_RATES_TTL_MS,
      refreshAction: "defi-rates-refresh",
      leftControls: `
        <span class="u-fs12-dim">Asset</span>
        <select data-action="defi-rates-token" class="ui-control">
          ${Object.keys(data?.byToken || {}).filter(t => showAllTokens || isCoreToken(t)).map(t =>
            `<option value="${escapeAttr(t)}" ${t === token ? "selected" : ""}>${escapeHtml(t)}</option>`
          ).join("")}
        </select>
        <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:12px;color:var(--text-dim)">
          <input type="checkbox" data-action="defi-rates-all" ${showAllTokens ? "checked" : ""}> All assets
        </label>
        <span class="u-fs12-dim">Sort</span>
        <select data-action="defi-rates-sort" class="ui-control">
          <option value="borrow" ${sortKey === "borrow" ? "selected" : ""}>Borrow APR</option>
          <option value="supply" ${sortKey === "supply" ? "selected" : ""}>Supply APR</option>
          <option value="util" ${sortKey === "util" ? "selected" : ""}>Utilization</option>
          <option value="tvl" ${sortKey === "tvl" ? "selected" : ""}>Total Supply</option>
          <option value="borrowed" ${sortKey === "borrowed" ? "selected" : ""}>Total Borrow</option>
          <option value="spread" ${sortKey === "spread" ? "selected" : ""}>Spread</option>
          <option value="protocol" ${sortKey === "protocol" ? "selected" : ""}>Protocol</option>
        </select>
        <span class="u-fs12-dim">Status</span>
        <select data-action="defi-rates-status" class="ui-control">
          <option value="all" ${statusFilter === "all" ? "selected" : ""}>All</option>
          <option value="live" ${statusFilter === "live" ? "selected" : ""}>Live</option>
          <option value="unavailable" ${statusFilter === "unavailable" ? "selected" : ""}>Unavailable</option>
        </select>
      `,
    });
    const methodCard = renderDefiMethodCard([
      "Rates are computed from protocol state objects (interest model + live utilization) for each protocol/token pair.",
      "Supply APR is derived from borrow APR and utilization where protocol mechanics expose the needed fields.",
      "Unavailable rows indicate protocol object fetch/read/parse failures or non-listed assets.",
      "This page is deterministic from on-chain state and does not use predictive heuristics.",
    ]);
    return `
      <div class="page-title">Lending Markets <span class="type-tag">On-Chain</span></div>
      ${scope}
      ${pricesLoading ? `<div class="u-fs12-dim u-mb12">Refreshing price context...</div>` : ""}

      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">Protocols</div>
          <div class="stat-value">${allRows.length}</div>
          <div class="stat-sub">${live.length} live, ${Math.max(0, unavailable)} unavailable</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Avg Borrow APR</div>
          <div class="stat-value u-c-yellow">${avgBorrow != null ? fmtApr(avgBorrow) : "—"}</div>
          <div class="stat-sub">${token}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Avg Supply APR</div>
          <div class="stat-value u-c-green">${avgSupply != null ? fmtApr(avgSupply) : "—"}</div>
          <div class="stat-sub">${token}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Top Borrow APR</div>
          <div class="stat-value">${topBorrow ? fmtApr(topBorrow.borrowBps) : "—"}</div>
          <div class="stat-sub">${topBorrow ? topBorrow.protocol : "—"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Top Utilization</div>
          <div class="stat-value">${topUtil ? fmtUtil(topUtil.utilization) : "—"}</div>
          <div class="stat-sub">${topUtil ? topUtil.protocol : "—"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Total Supply</div>
          <div class="stat-value u-c-green">${totalSupplyUsd > 0 ? fmtUsdFromFloat(totalSupplyUsd) : "—"}</div>
          <div class="stat-sub">${token} across ${live.length} protocols</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Total Borrow</div>
          <div class="stat-value u-c-yellow">${totalBorrowUsd > 0 ? fmtUsdFromFloat(totalBorrowUsd) : "—"}</div>
          <div class="stat-sub">${token} across ${live.length} protocols</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Unavailable Rows</div>
          <div class="stat-value">${Math.max(0, unavailable)}</div>
          <div class="stat-sub">${token} data quality gap</div>
        </div>
      </div>

      ${renderDefiSignalsCard(signals)}
      ${methodCard}

      <div class="card">
        <div class="card-header">Cross-Protocol Lending Snapshot</div>
        <div class="card-body">
          <table>
            <thead><tr><th>Protocol</th><th>Conf.</th><th class="u-ta-right">Supply APR</th><th class="u-ta-right">Borrow APR</th><th class="u-ta-right">Utilization</th><th class="u-ta-right">Total Supply</th><th class="u-ta-right">Total Borrow</th><th class="u-ta-right">Spread</th><th>Source</th><th>Status</th></tr></thead>
            <tbody>
              ${rows.map(r => {
                const utilColor = !Number.isFinite(r.utilization) ? "var(--text-dim)"
                  : r.utilization > 0.9 ? "var(--red)"
                  : r.utilization > 0.75 ? "var(--yellow)"
                  : "var(--green)";
                const spreadBps = Number.isFinite(r.borrowBps) && Number.isFinite(r.supplyBps) ? (r.borrowBps - r.supplyBps) : null;
                const status = r.error
                  ? `<span class="badge badge-fail" title="${escapeAttr(r.error)}">Unavailable</span>`
                  : '<span class="badge badge-success">Live</span>';
                const source = r.sourceId
                  ? `${hashLink(r.sourceId, '/object/' + r.sourceId)}<div class="u-fs11-dim">${escapeHtml(r.sourceLabel || "")}</div>`
                  : '<span class="u-c-dim">—</span>';
                const supplyUsd = r.totalSupplyHuman * (defiPrices[r.token] || 0);
                const borrowUsd = r.totalBorrowHuman * (defiPrices[r.token] || 0);
                const fmtSupplyUsd = r.error || !supplyUsd ? "—" : fmtUsdFromFloat(supplyUsd);
                const fmtBorrowUsd = r.error || !borrowUsd ? "—" : fmtUsdFromFloat(borrowUsd);
                return `<tr>
                  <td class="u-fw-600">${escapeHtml(r.protocol)}</td>
                  <td>${defiConfidenceBadge(r.error ? "low" : "high")}</td>
                  <td style="text-align:right;font-family:var(--mono);color:var(--green)">${fmtApr(r.supplyBps)}</td>
                  <td style="text-align:right;font-family:var(--mono);color:var(--yellow)">${fmtApr(r.borrowBps)}</td>
                  <td style="text-align:right;font-family:var(--mono);color:${utilColor}">${fmtUtil(r.utilization)}</td>
                  <td class="u-ta-right-mono">${fmtSupplyUsd}</td>
                  <td class="u-ta-right-mono">${fmtBorrowUsd}</td>
                  <td class="u-ta-right-mono">${fmtApr(spreadBps)}</td>
                  <td>${source}</td>
                  <td>${status}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  const setDefiToken = (nextToken) => {
    token = (data?.byToken?.[nextToken]) ? nextToken : "SUI";
    persistDefiRateState();
    app.innerHTML = renderContent();
  };
  const setDefiRateSort = (nextSort) => {
    sortKey = ["borrow", "supply", "util", "spread", "protocol", "tvl", "borrowed"].includes(nextSort) ? nextSort : "borrow";
    persistDefiRateState();
    app.innerHTML = renderContent();
  };
  const setDefiRateStatus = (nextStatus) => {
    statusFilter = ["all", "live", "unavailable"].includes(nextStatus) ? nextStatus : "all";
    persistDefiRateState();
    app.innerHTML = renderContent();
  };
  const refreshDefiRates = async () => {
    await load(true);
  };
  if (app._defiRatesChangeHandler) app.removeEventListener("change", app._defiRatesChangeHandler);
  app._defiRatesChangeHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "defi-rates-token") {
      setDefiToken(target.value);
      return;
    }
    if (action === "defi-rates-sort") {
      setDefiRateSort(target.value);
      return;
    }
    if (action === "defi-rates-status") {
      setDefiRateStatus(target.value);
      return;
    }
    if (action === "defi-rates-all") {
      showAllTokens = target.checked;
      // If current token is not in the filtered set, reset to SUI
      if (!showAllTokens && !isCoreToken(token)) token = "SUI";
      persistDefiRateState();
      app.innerHTML = renderContent();
    }
  };
  app.addEventListener("change", app._defiRatesChangeHandler);
  if (app._defiRatesClickHandler) app.removeEventListener("click", app._defiRatesClickHandler);
  app._defiRatesClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    if (trigger.getAttribute("data-action") !== "defi-rates-refresh") return;
    ev.preventDefault();
    await refreshDefiRates();
  };
  app.addEventListener("click", app._defiRatesClickHandler);
  app.innerHTML = renderContent();
  setTimeout(() => {
    if (!isActiveRoute()) return;
    load(false).catch(() => null);
  }, 0);
}

// ── Protocol Config ───────────────────────────────────────────────────
async function renderProtocolConfig(app) {
  const routeParams = splitRouteAndParams(getRoute()).params;
  const data = await gql(`{
    chainIdentifier
    serviceConfig {
      maxMultiGetSize
      queryTimeoutMs
      maxQueryDepth
      maxQueryNodes
      maxQueryPayloadSize
    }
    protocolConfigs {
      protocolVersion
      configs { key value }
      featureFlags { key value }
    }
  }`);
  const chainIdentifier = String(data?.chainIdentifier || "").trim();
  const serviceConfig = data?.serviceConfig || {};
  const pc = data?.protocolConfigs;
  if (!pc) { app.innerHTML = renderEmpty("Could not load protocol config."); return; }

  const configs = (pc.configs || []).sort((a, b) => a.key.localeCompare(b.key));
  const flags = (pc.featureFlags || []).sort((a, b) => a.key.localeCompare(b.key));
  const enabledFlags = flags.filter(f => f.value === true);
  let configFilter = routeParams.get("q") || "";
  const fetchedAt = new Date().toISOString();

  function renderContent() {
    const q = configFilter.toLowerCase();
    const filteredConfigs = q ? configs.filter(c => c.key.toLowerCase().includes(q) || (c.value && c.value.toLowerCase().includes(q))) : configs;
    const filteredFlags = q ? flags.filter(f => f.key.toLowerCase().includes(q)) : flags;

    let html = `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">${copyLinkBtn()}</div>`;
    html += `<h2 class="u-mb12">Protocol Configuration</h2>`;
    html += renderDefiScopeBar({
      sampleLabel: `${fmtNumber(configs.length)} config entries + ${fmtNumber(flags.length)} flags`,
      fetchedAt,
      sourceLabel: "Sui GraphQL Mainnet · chainIdentifier + serviceConfig + protocolConfigs",
    });
    html += `<div class="stats-grid u-mb16">
      <div class="stat-box"><div class="stat-label">Protocol Version</div><div class="stat-value">${pc.protocolVersion}</div></div>
      <div class="stat-box"><div class="stat-label">Config Parameters</div><div class="stat-value">${configs.length}</div></div>
      <div class="stat-box"><div class="stat-label">Feature Flags</div><div class="stat-value">${flags.length}</div><div class="stat-sub">${enabledFlags.length} enabled</div></div>
      <div class="stat-box"><div class="stat-label">maxMultiGetSize</div><div class="stat-value">${fmtNumber(Number(serviceConfig.maxMultiGetSize || 0))}</div><div class="stat-sub">maxQueryNodes ${fmtNumber(Number(serviceConfig.maxQueryNodes || 0))}</div></div>
      <div class="stat-box"><div class="stat-label">Query Timeout</div><div class="stat-value">${fmtNumber(Number(serviceConfig.queryTimeoutMs || 0))}ms</div><div class="stat-sub">maxDepth ${fmtNumber(Number(serviceConfig.maxQueryDepth || 0))}</div></div>
    </div>`;

    // Filter
    html += `<div class="u-mb12">
      <input id="proto-filter" type="text" placeholder="Search configs and flags..." value="${configFilter}" style="width:100%;max-width:400px;padding:6px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px" />
    </div>`;

    // Two-column layout
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">`;

    // Config Parameters
    html += `<div class="card" style="overflow:auto;max-height:70vh">
      <h3 style="font-size:14px;padding:12px 16px;border-bottom:1px solid var(--border);margin:0;position:sticky;top:0;background:var(--card);z-index:1">Parameters (${filteredConfigs.length})</h3>
      <table class="u-m0"><tbody>`;
    for (const c of filteredConfigs) {
      const isNum = c.value && /^\d+$/.test(c.value);
      html += `<tr><td style="font-family:var(--mono);font-size:11px;color:var(--text-dim);padding:4px 8px">${c.key}</td><td style="font-family:var(--mono);font-size:11px;padding:4px 8px;color:${isNum ? 'var(--accent)' : 'var(--text)'}">${c.value ?? "null"}</td></tr>`;
    }
    html += `</tbody></table></div>`;

    // Feature Flags
    html += `<div class="card" style="overflow:auto;max-height:70vh">
      <h3 style="font-size:14px;padding:12px 16px;border-bottom:1px solid var(--border);margin:0;position:sticky;top:0;background:var(--card);z-index:1">Feature Flags (${filteredFlags.length})</h3>
      <table class="u-m0"><tbody>`;
    for (const f of filteredFlags) {
      const color = f.value ? "var(--green)" : "var(--red)";
      const label = f.value ? "enabled" : "disabled";
      html += `<tr><td style="font-family:var(--mono);font-size:11px;color:var(--text-dim);padding:4px 8px">${f.key}</td><td style="padding:4px 8px"><span class="badge" style="color:${color};background:${color}20;font-size:10px">${label}</span></td></tr>`;
    }
    html += `</tbody></table></div>`;

    html += `</div>`; // close grid
    return html;
  }

  if (app._protoInputHandler) app.removeEventListener("input", app._protoInputHandler);
  const _debouncedProtoFilter = debounce((val) => {
    configFilter = val;
    setRouteParams({ q: configFilter || null });
    app.innerHTML = renderContent();
  }, 300);
  app._protoInputHandler = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.id !== "proto-filter") return;
    _debouncedProtoFilter(target.value || "");
  };
  app.addEventListener("input", app._protoInputHandler);
  app.innerHTML = renderContent();
}

// ── Docs / Explanation ────────────────────────────────────────────────
async function renderDocs(app) {
  app.innerHTML = `
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">${copyLinkBtn()}</div>
    <div class="page-title">Docs <span class="type-tag">How To Read The Explorer</span></div>

    <div class="card u-mb16">
      <div class="card-header">What This Explorer Is</div>
      <div class="card-body" style="font-size:13px;line-height:1.5;color:var(--text-dim)">
        A Sui block explorer built around the GraphQL API. The goal is to keep raw chain data visible while adding lightweight structure so users can understand activity quickly.
        <div style="margin-top:8px">Use the top-right <span class="u-c-text">Simple / Advanced</span> toggle to control detail density.</div>
        <div style="margin-top:8px">Use the top-right <span class="u-c-text">theme</span> toggle for visual style and the perf badge for live render/query telemetry.</div>
        <div style="margin-top:8px">This explorer is open source. View the code and contribute on <a href="https://github.com/Evan-Kim2028/suigraph" target="_blank" rel="noopener" style="color:var(--accent)">GitHub</a>.</div>
      </div>
    </div>

    <div class="card u-mb16">
      <div class="card-header">User Journeys</div>
      <div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px">
        <a href="#/" class="hash-link u-panel-block">
          <div style="font-weight:600;color:var(--text)">Quick Chain Pulse</div>
          <div class="u-fs12-dim">Overview -> Checkpoints -> Transactions</div>
        </a>
        <a href="#/defi-overview" class="hash-link u-panel-block">
          <div style="font-weight:600;color:var(--text)">DeFi Monitoring</div>
          <div class="u-fs12-dim">DeFi Overview -> Rates / DEX / Volume</div>
        </a>
        <a href="#/graphql" class="hash-link u-panel-block">
          <div style="font-weight:600;color:var(--text)">Developer Inspection</div>
          <div class="u-fs12-dim">GraphQL Playground -> TX Simulator -> Object/Package pages</div>
        </a>
      </div>
    </div>

    <div class="card u-mb16">
      <div class="card-header">Data Sources & Refresh</div>
      <div class="card-body">
        <table>
          <thead><tr><th>Dataset</th><th>Primary Source</th><th>Refresh Pattern</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>Core chain (tx/checkpoint/object)</td><td>Sui GraphQL</td><td>On page load; some pages auto-refresh</td><td>Canonical chain-state data.</td></tr>
            <tr><td>Overview top metrics</td><td>Sui GraphQL</td><td>Auto-refresh ~5s</td><td>For fast network pulse.</td></tr>
            <tr><td>Overview epoch trends</td><td>Sui GraphQL <code>epochs</code> root</td><td>TTL-cached (~60s)</td><td>Historical epoch throughput and gas trend.</td></tr>
            <tr><td>DeFi metrics</td><td>Sui GraphQL + on-chain objects</td><td>TTL-cached per page (shown in scope bar)</td><td>Explicit update time shown on each page.</td></tr>
            <tr><td>SUI spot context</td><td>DeepBook SUI/USDC path</td><td>Short TTL</td><td>Used for derived USD lenses.</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card u-mb16">
      <div class="card-header">Accuracy & Completeness</div>
      <div class="card-body" style="font-size:13px;line-height:1.5;color:var(--text-dim)">
        <div style="margin-bottom:6px">1) Rows and stats are deterministic from fetched on-chain data.</div>
        <div style="margin-bottom:6px">2) Coverage varies when protocol packages are unresolved; unresolved queues and confidence badges expose this explicitly.</div>
        <div style="margin-bottom:6px">3) Empty sections do not always mean no activity; sometimes they indicate classification gaps in the selected window.</div>
        <div>4) Use object/package detail pages and query buttons for direct verification.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Where To Go Next</div>
      <div class="card-body" style="display:flex;flex-wrap:wrap;gap:8px">
        <a href="#/events" class="hash-link u-panel-sm">Events</a>
        <a href="#/packages" class="hash-link u-panel-sm">Packages</a>
        <a href="#/defi-dex" class="hash-link u-panel-sm">DeFi DEX</a>
        <a href="#/defi-rates" class="hash-link u-panel-sm">Lending Markets</a>
        <a href="#/graphql" class="hash-link u-panel-sm">GraphQL Playground</a>
      </div>
    </div>
  `;
}

// ── TX Simulator ──────────────────────────────────────────────────────
async function renderSimulator(app) {
  let simResult = null;
  let simError = null;
  let isLoading = false;
  let simInputText = "";
  let simSkipChecks = false;
  let simExampleDigest = "";
  let simExampleNote = "Loading starter example from recent on-chain activity...";

  function renderContent() {
    let html = `<div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:8px">${copyLinkBtn()}</div>`;
    html += `<h2 class="u-mb12">Transaction Simulator</h2>`;
    html += `<p style="font-size:13px;color:var(--text-dim);margin-bottom:8px">Dry-run a transaction without signatures. Paste raw base64 BCS bytes or a JSON transaction payload (Sui gRPC schema) to preview effects.</p>`;
    html += `<div style="font-size:12px;color:var(--text-dim);margin-bottom:16px">${escapeHtml(simExampleNote)}${simExampleDigest ? ` Example tx: ${hashLink(simExampleDigest, '/tx/' + simExampleDigest)}` : ""}</div>`;

    // Input
      html += `<div class="card u-mb16">
      <textarea id="sim-tx-input" placeholder='Paste base64 bytes or JSON, e.g. { "bcs": { "value": "<base64>" } }' style="width:100%;min-height:120px;background:var(--bg);border:none;border-bottom:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:13px;padding:12px;resize:vertical;outline:none;box-sizing:border-box">${escapeHtml(simInputText)}</textarea>
      <div style="display:flex;align-items:center;gap:12px;padding:8px 12px">
        <label style="font-size:12px;color:var(--text-dim);display:flex;align-items:center;gap:4px"><input type="checkbox" id="sim-skip-checks" ${simSkipChecks ? "checked" : ""} /> Skip safety checks</label>
        <button data-action="sim-load-example" class="btn-surface-sm">Load Example</button>
        <button data-action="sim-run" style="margin-left:auto;padding:6px 20px;background:var(--accent);color:#000;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">${isLoading ? 'Simulating...' : 'Simulate'}</button>
      </div>
    </div>`;

    // Results
    if (simError) {
      html += `<div class="card" style="border-color:var(--red);padding:16px"><div style="color:var(--red);font-weight:600;margin-bottom:4px">Simulation Error</div><div style="font-family:var(--mono);font-size:12px;color:var(--text-dim)">${escapeHtml(simError)}</div></div>`;
    }
    if (simResult) {
      const eff = simResult.effects;
      const err = simResult.error;
      const gs = eff?.gasEffects?.gasSummary;
      const gasUsed = gs ? Number(gs.computationCost) + Number(gs.storageCost) - Number(gs.storageRebate) : 0;
      const balances = eff?.balanceChanges?.nodes || [];
      const objChanges = eff?.objectChanges?.nodes || [];
      const events = eff?.events?.nodes || [];
      const status = eff?.status;

      html += `<div class="stats-grid u-mb16">
        <div class="stat-box"><div class="stat-label">Status</div><div class="stat-value" style="color:${status === 'SUCCESS' ? 'var(--green)' : 'var(--red)'}">${status || "—"}</div></div>
        <div class="stat-box"><div class="stat-label">Gas Cost</div><div class="stat-value">${fmtSui(gasUsed)}</div><div class="stat-sub">Compute: ${fmtSui(gs?.computationCost)} | Storage: ${fmtSui(gs?.storageCost)} | Rebate: ${fmtSui(gs?.storageRebate)}</div></div>
        <div class="stat-box"><div class="stat-label">Balance Changes</div><div class="stat-value">${balances.length}</div></div>
        <div class="stat-box"><div class="stat-label">Object Changes</div><div class="stat-value">${objChanges.length}</div></div>
      </div>`;

      if (err) {
        html += `<div class="card" style="border-color:var(--red);padding:12px;margin-bottom:12px"><div style="color:var(--red);font-size:13px">${err}</div></div>`;
      }

      // Balance Changes
      if (balances.length) {
        html += `<div class="card u-mb12"><h3 style="font-size:14px;padding:12px 16px;border-bottom:1px solid var(--border);margin:0">Balance Changes</h3><table class="u-m0"><thead><tr><th>Coin</th><th>Amount</th><th>Owner</th></tr></thead><tbody>`;
        for (const b of balances) {
          const c = fmtCoinWithMeta(b.amount, b.coinType?.repr);
          const color = c.raw >= 0 ? "var(--green)" : "var(--red)";
          html += `<tr><td class="u-mono-12">${c.name}</td><td style="font-family:var(--mono);font-size:12px;color:${color}">${c.sign}${c.abs}</td><td>${b.owner?.address ? hashLink(b.owner.address, '/address/' + b.owner.address) : "—"}</td></tr>`;
        }
        html += `</tbody></table></div>`;
      }

      // Object Changes
      if (objChanges.length) {
        html += `<div class="card u-mb12"><h3 style="font-size:14px;padding:12px 16px;border-bottom:1px solid var(--border);margin:0">Object Changes</h3><table class="u-m0"><thead><tr><th>Object</th><th>Change</th><th>Type</th></tr></thead><tbody>`;
        for (const o of objChanges) {
          const change = o.idCreated ? '<span class="badge badge-success">Created</span>' : o.idDeleted ? '<span class="badge badge-fail">Deleted</span>' : '<span class="badge">Mutated</span>';
          const typeRepr = o.outputState?.asMoveObject?.contents?.type?.repr || o.inputState?.asMoveObject?.contents?.type?.repr || "";
          html += `<tr><td>${hashLink(o.address, '/object/' + o.address)}</td><td>${change}</td><td class="u-mono-11-dim">${shortType(typeRepr)}</td></tr>`;
        }
        html += `</tbody></table></div>`;
      }

      // Events
      if (events.length) {
        html += `<div class="card u-mb12"><h3 style="font-size:14px;padding:12px 16px;border-bottom:1px solid var(--border);margin:0">Events (${events.length})</h3><table class="u-m0"><thead><tr><th>Type</th><th>Data</th></tr></thead><tbody>`;
        events.forEach((ev, idx) => {
          const typeRepr = ev.contents?.type?.repr || "—";
          const hasJson = ev.contents?.json && Object.keys(ev.contents.json).length > 0;
          const keyCount = hasJson ? Object.keys(ev.contents.json).length : 0;
          const simRowId = `sim-evt-${idx}`;
          html += `<tr><td style="font-family:var(--mono);font-size:11px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shortType(typeRepr)}</td><td>${hasJson ? `<button data-action="sim-toggle-event-row" data-row-id="${simRowId}" aria-expanded="false" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--accent);font-size:11px;padding:2px 10px;cursor:pointer;font-family:var(--mono)">{${keyCount}} fields</button>` : '<span class="u-c-dim">—</span>'}</td></tr>`;
          if (hasJson) {
            html += `<tr id="${simRowId}" style="display:none"><td colspan="2" style="padding:0 8px 8px">${jsonTreeBlock(ev.contents.json, 280)}</td></tr>`;
          }
        });
        html += `</tbody></table></div>`;
      }
    }

    return html;
  }

  async function loadExample(rerender = true) {
    simExampleNote = "Loading starter example from recent on-chain activity...";
    if (rerender) app.innerHTML = renderContent();
    try {
      const data = await gql(`{
        transactions(last: 40, filter: { kind: PROGRAMMABLE_TX }) {
          nodes { digest transactionBcs effects { status } }
        }
      }`);
      const nodes = data?.transactions?.nodes || [];
      const pick = nodes.find(n => n?.effects?.status === "SUCCESS" && n.transactionBcs)
        || nodes.find(n => n?.transactionBcs);
      if (!pick?.transactionBcs) throw new Error("No recent transaction bytes available.");
      simInputText = JSON.stringify({ bcs: { value: pick.transactionBcs } }, null, 2);
      simExampleDigest = pick.digest || "";
      simExampleNote = pick?.effects?.status === "SUCCESS"
        ? "Starter example loaded from a recent successful transaction."
        : "Starter example loaded from a recent transaction.";
      simError = null;
    } catch (e) {
      simExampleDigest = "";
      simExampleNote = "Could not auto-load an example. Paste base64 bytes or JSON transaction payload.";
    }
    if (rerender) app.innerHTML = renderContent();
  }

  const loadSimulationExample = async () => {
    await loadExample(true);
  };

  const runSimulation = async () => {
    const txInputRaw = document.getElementById("sim-tx-input")?.value?.trim();
    if (!txInputRaw) return;
    simInputText = txInputRaw;
    simSkipChecks = document.getElementById("sim-skip-checks")?.checked || false;
    let txInput = null;
    if (txInputRaw.startsWith("{") || txInputRaw.startsWith("[")) {
      try {
        txInput = JSON.parse(txInputRaw);
      } catch (e) {
        simError = "Invalid JSON transaction payload: " + e.message;
        simResult = null;
        app.innerHTML = renderContent();
        return;
      }
    } else {
      txInput = { bcs: { value: txInputRaw } };
    }

    isLoading = true;
    simResult = null;
    simError = null;
    app.innerHTML = renderContent();

    try {
      const data = await gql(`query($tx: JSON!) {
        simulateTransaction(transaction: $tx, checksEnabled: ${!simSkipChecks}) {
          effects {
            status
            gasEffects { gasSummary { computationCost storageCost storageRebate } }
            balanceChanges(first: 50) { nodes { ${GQL_F_BAL_NODE} } }
            objectChanges(first: 50) { nodes { address idCreated idDeleted
              inputState { ${GQL_F_MOVE_TYPE} }
              outputState { ${GQL_F_MOVE_TYPE} }
            } }
            events(first: 50) { nodes { ${GQL_F_CONTENTS_TYPE_JSON} } }
          }
          error
        }
      }`, { tx: txInput });

      simResult = data?.simulateTransaction;
      if (!simResult) simError = "No result returned from simulation.";

      // Prefetch coin meta for balance changes
      if (simResult?.effects?.balanceChanges?.nodes) {
        const coinTypes = simResult.effects.balanceChanges.nodes.map(b => b.coinType?.repr).filter(Boolean);
        if (coinTypes.length) await prefetchCoinMeta(coinTypes);
      }
    } catch (e) {
      simError = e.message || "Simulation failed.";
    }

    isLoading = false;
    app.innerHTML = renderContent();
  };

  if (app._simClickHandler) app.removeEventListener("click", app._simClickHandler);
  app._simClickHandler = async (ev) => {
    const trigger = ev.target?.closest?.("[data-action]");
    if (!trigger || !app.contains(trigger)) return;
    const action = trigger.getAttribute("data-action");
    if (!action) return;
    if (action === "sim-load-example") {
      ev.preventDefault();
      await loadSimulationExample();
      return;
    }
    if (action === "sim-run") {
      ev.preventDefault();
      await runSimulation();
      return;
    }
    if (action === "sim-toggle-event-row") {
      ev.preventDefault();
      const rowId = trigger.getAttribute("data-row-id") || "";
      if (!rowId) return;
      const row = document.getElementById(rowId);
      if (!row) return;
      const expanded = row.style.display === "table-row";
      row.style.display = expanded ? "none" : "table-row";
      trigger.setAttribute("aria-expanded", expanded ? "false" : "true");
    }
  };
  app.addEventListener("click", app._simClickHandler);
  app.innerHTML = renderContent();
  await loadExample(true);
}

// ── GraphQL Playground ─────────────────────────────────────────────────
async function renderGraphQLPlayground(app) {
  const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const presetParam = params.get("q");
  const activePresetKey = (presetParam && QUERIES[presetParam]) ? presetParam : "sample";
  let initialQuery = QUERIES[activePresetKey]?.query || QUERIES.sample.query;
  const initialVarObj = { ...(QUERIES[activePresetKey]?.variables || {}) };
  if (initialVarObj.digest !== undefined && params.get("digest")) initialVarObj.digest = params.get("digest");
  if (initialVarObj.seq !== undefined && params.get("seq")) initialVarObj.seq = parseInt(params.get("seq"));
  if (initialVarObj.addr !== undefined && params.get("addr")) initialVarObj.addr = params.get("addr");
  if (initialVarObj.id !== undefined && params.get("id")) initialVarObj.id = params.get("id");
  let initialVars = JSON.stringify(initialVarObj, null, 2);

  app.innerHTML = `
    <div class="page-title">GraphQL Playground</div>
    <div class="card u-mb16">
      <div class="gql-toolbar">
        <button class="gql-run-btn" id="gql-run" title="Ctrl+Enter">Run</button>
        <button class="gql-vars-toggle" id="gql-vars-btn">Variables</button>
        <select id="gql-presets" style="background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:6px;font-size:12px">
          <option value="">Load example...</option>
          ${Object.entries(QUERIES).map(([k, v]) => `<option value="${k}" ${k === activePresetKey ? 'selected' : ''}>${v.label}</option>`).join("")}
        </select>
        <span id="gql-status" class="gql-meta"></span>
      </div>
      <div style="padding:8px 14px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-dim)">
        Starter example loaded: <span class="u-c-text">${escapeHtml(QUERIES[activePresetKey]?.label || "Sample — Latest Checkpoint")}</span>
      </div>
      <div class="gql-playground">
        <div class="gql-pane card">
          <div class="gql-pane-header">Query</div>
          <textarea class="gql-editor" id="gql-query" spellcheck="false">${initialQuery}</textarea>
          <div class="gql-vars-wrap" id="gql-vars-wrap" style="display:none">
            <div class="gql-pane-header">Variables (JSON)</div>
            <textarea class="gql-vars-editor" id="gql-vars" spellcheck="false">${initialVars}</textarea>
          </div>
        </div>
        <div class="gql-pane card">
          <div class="gql-pane-header">Response <span id="gql-time" class="gql-meta"></span></div>
          <pre class="gql-results" id="gql-results">Click "Run" or press Ctrl+Enter to execute the query.</pre>
        </div>
      </div>
    </div>
  `;

  const queryEl = document.getElementById("gql-query");
  const varsEl = document.getElementById("gql-vars");
  const resultsEl = document.getElementById("gql-results");
  const statusEl = document.getElementById("gql-status");
  const timeEl = document.getElementById("gql-time");
  const varsWrap = document.getElementById("gql-vars-wrap");

  async function runQuery() {
    const query = queryEl.value.trim();
    if (!query) return;
    let variables = {};
    try {
      const v = varsEl.value.trim();
      if (v && v !== "{}") variables = JSON.parse(v);
    } catch (e) {
      resultsEl.textContent = "Invalid JSON in variables: " + e.message;
      return;
    }
    statusEl.textContent = "Running...";
    statusEl.style.color = "var(--text-dim)";
    timeEl.textContent = "";
    const t0 = performance.now();
    try {
      const res = await fetch(GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const elapsed = Math.round(performance.now() - t0);
      const json = await res.json();
      resultsEl.textContent = JSON.stringify(json, null, 2);
      statusEl.textContent = res.ok && !json.errors ? "Success" : "Error";
      statusEl.style.color = res.ok && !json.errors ? "var(--green)" : "var(--red)";
      timeEl.textContent = elapsed + "ms";
    } catch (e) {
      const elapsed = Math.round(performance.now() - t0);
      resultsEl.textContent = "Fetch error: " + e.message;
      statusEl.textContent = "Error";
      statusEl.style.color = "var(--red)";
      timeEl.textContent = elapsed + "ms";
    }
  }

  document.getElementById("gql-run").addEventListener("click", runQuery);
  queryEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runQuery(); }
    if (e.key === "Tab") {
      e.preventDefault();
      const s = queryEl.selectionStart;
      queryEl.value = queryEl.value.substring(0, s) + "  " + queryEl.value.substring(queryEl.selectionEnd);
      queryEl.selectionStart = queryEl.selectionEnd = s + 2;
    }
  });

  document.getElementById("gql-vars-btn").addEventListener("click", () => {
    varsWrap.style.display = varsWrap.style.display === "none" ? "block" : "none";
  });

  document.getElementById("gql-presets").addEventListener("change", (e) => {
    const key = e.target.value;
    if (key && QUERIES[key]) {
      queryEl.value = QUERIES[key].query;
      varsEl.value = JSON.stringify(QUERIES[key].variables, null, 2);
      runQuery();
    }
  });

  runQuery();
}

// ── Init ────────────────────────────────────────────────────────────────
loadTheme();
loadViewMode();
initUiEnhancements();
routeTo(getRoute());

import { setTimeout as delay } from "node:timers/promises";
import { evaluate, waitForCondition } from "./browser-smoke.mjs";

export async function waitForBodyTexts(client, texts, timeoutMs, label = "page content") {
  const required = (Array.isArray(texts) ? texts : []).filter(Boolean);
  if (!required.length) return;
  const encoded = JSON.stringify(required);
  await waitForCondition(
    client,
    `(() => {
      const text = document.body?.innerText || "";
      return ${encoded}.every((needle) => text.includes(needle));
    })()`,
    timeoutMs,
    label
  );
}

export async function readPerfBadge(client) {
  return evaluate(client, `(() => {
    const badge = document.getElementById("perf-badge");
    const rows = badge?._perfRows || [];
    const mapped = Object.create(null);
    for (const row of rows) {
      mapped[row.label] = {
        value: String(row.value || ""),
        sub: String(row.sub || ""),
        warn: !!row.warn,
      };
    }
    return {
      text: badge?.textContent || "",
      rows: mapped,
      status: mapped.Status?.value || "",
      render: mapped.Render?.value || "",
      gqlCalls: mapped["GQL calls"]?.value || "",
      gqlTime: mapped["GQL time"]?.value || "",
      reqBytes: mapped["Req bytes"]?.value || "",
      resBytes: mapped["Res bytes"]?.value || "",
      topQuery: mapped["Top Query"]?.value || "",
      topQueryMeta: mapped["Top Query"]?.sub || "",
    };
  })()`);
}

export async function waitForPerfSettled(client, timeoutMs, settleMs = 1250) {
  const deadline = Date.now() + timeoutMs;
  let lastSig = "";
  let stableSince = 0;
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    const snapshot = await readPerfBadge(client);
    lastSnapshot = snapshot;
    if (snapshot.status && snapshot.status !== "loading") {
      const sig = JSON.stringify([
        snapshot.status,
        snapshot.render,
        snapshot.gqlCalls,
        snapshot.gqlTime,
        snapshot.reqBytes,
        snapshot.resBytes,
        snapshot.topQuery,
        snapshot.topQueryMeta,
      ]);
      if (sig === lastSig) {
        if (!stableSince) stableSince = Date.now();
        if ((Date.now() - stableSince) >= settleMs) return snapshot;
      } else {
        lastSig = sig;
        stableSince = Date.now();
      }
    }
    await delay(200);
  }

  throw new Error(`Timed out waiting for perf badge to settle: ${JSON.stringify(lastSnapshot || {})}`);
}

export function collectPerfIssues(snapshot, { strictRender = false } = {}) {
  const issues = [];
  const rows = snapshot?.rows || {};
  if (!snapshot?.text) issues.push("Perf badge did not render");
  if ((rows.Status?.value || "") !== "ok") issues.push(`Perf status is ${rows.Status?.value || "missing"}`);
  if (!rows["GQL calls"]?.value) issues.push("Perf badge missing GQL call count");
  if (!rows["Top Query"]?.value) issues.push("Perf badge missing top query");
  if (rows["GQL calls"]?.warn) {
    issues.push(`GQL calls exceeded budget (${rows["GQL calls"].value}; ${rows["GQL calls"].sub || "no budget"})`);
  }
  if (strictRender && rows.Render?.warn) {
    issues.push(`Render exceeded budget (${rows.Render.value}; ${rows.Render.sub || "no budget"})`);
  }
  return issues;
}

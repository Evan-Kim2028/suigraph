import { evaluate, waitForCondition } from "./browser-smoke.mjs";

export function normalizeRouteAddress(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return "";
  let hex = text.startsWith("0x") ? text.slice(2) : text;
  if (!/^[0-9a-f]+$/.test(hex)) return "";
  hex = hex.replace(/^0+/, "") || "0";
  if (hex.length > 64) return "";
  return `0x${hex}`;
}

export async function openAddressDefiTab(client, timeoutMs) {
  await waitForCondition(
    client,
    "!!document.querySelector('[data-action=\"addr-switch-tab\"][data-tab=\"defi\"]')",
    timeoutMs,
    "address tabs"
  );
  const clicked = await evaluate(
    client,
    "(() => { const el = document.querySelector('[data-action=\"addr-switch-tab\"][data-tab=\"defi\"]'); if (!el) return false; el.click(); return true; })()"
  );
  if (!clicked) throw new Error("Could not open DeFi tab");
  await waitForCondition(
    client,
    "(() => { const text = document.body.innerText || ''; return text.includes('Wallet Holdings') || text.includes('No DeFi positions found.') || text.includes('Error loading page:'); })()",
    timeoutMs,
    "DeFi content"
  );
}

export async function captureAddressDefiSnapshot(client) {
  return evaluate(client, `(() => {
    const bodyText = document.body.innerText || "";
    const wallet = document.getElementById("addr-wallet-holdings");
    const walletLinkCount = wallet ? wallet.querySelectorAll('a[href^="#/coin"]').length : 0;
    const walletSummaryText = wallet?.innerText || "";
    const stats = Array.from(document.querySelectorAll('.stat-label')).map((el) => el.textContent.trim()).filter(Boolean);
    const sectionHeadings = Array.from(document.querySelectorAll('h3')).map((el) => el.textContent.trim()).filter(Boolean);
    return {
      bodyText,
      hasError: bodyText.includes("Error loading page:"),
      hasNoPositions: bodyText.includes("No DeFi positions found."),
      hasAccountingWarnings: bodyText.includes("Accounting warnings"),
      hasWalletSection: bodyText.includes("Wallet Holdings"),
      hasProtocolFilter: !!document.querySelector('[data-action="addr-wallet-protocol-filter"]'),
      hasCoinTypeLinks: walletLinkCount > 0,
      walletLinkCount,
      stats,
      sectionHeadings,
      walletSummaryText,
    };
  })()`);
}

export async function collectAddressDefiSnapshot(client, timeoutMs) {
  await openAddressDefiTab(client, timeoutMs);
  return captureAddressDefiSnapshot(client);
}

export function collectAddressDefiIssues(snapshot, checks = {}) {
  const issues = [];
  if (!checks.allowErrorShell && snapshot?.hasError) issues.push("Address route rendered an error shell");
  if (!checks.allowAccountingWarnings && snapshot?.hasAccountingWarnings) issues.push("Address route rendered accounting warnings");
  if (checks.requireWalletSection && !snapshot?.hasWalletSection) issues.push("Wallet Holdings section did not render");
  if (checks.requireProtocolFilter && !snapshot?.hasProtocolFilter) issues.push("Protocol-supported wallet filter did not render");
  if (checks.requireCoinLinks && !snapshot?.hasCoinTypeLinks) issues.push("Wallet section did not expose clickable coin-type links");
  if (checks.requireStats && (!Array.isArray(snapshot?.stats) || snapshot.stats.length === 0)) {
    issues.push("DeFi summary stats did not render");
  }
  for (const text of (checks.requiredTexts || [])) {
    if (text && !String(snapshot?.bodyText || "").includes(text)) {
      issues.push(`Expected rendered text missing: ${text}`);
    }
  }
  for (const stat of (checks.requiredStats || [])) {
    if (stat && !(snapshot?.stats || []).includes(stat)) {
      issues.push(`Expected summary stat missing: ${stat}`);
    }
  }
  return issues;
}

export async function toggleAddressWalletFilterAndMeasure(client, timeoutMs) {
  await waitForCondition(
    client,
    "(() => { const el = document.querySelector('[data-action=\"addr-wallet-protocol-filter\"]'); return !!el && !el.disabled; })()",
    timeoutMs,
    "wallet filter availability"
  );
  const toggled = await evaluate(
    client,
    "(() => { const el = document.querySelector('[data-action=\"addr-wallet-protocol-filter\"]'); if (!el) return false; el.click(); return true; })()"
  );
  if (!toggled) throw new Error("Could not toggle protocol-supported wallet filter");
  const hiddenSummary = await waitForCondition(
    client,
    "(() => { const wallet = document.getElementById('addr-wallet-holdings'); const text = wallet?.innerText || ''; const match = text.match(/hiding\\s+(\\d+)/i); return match ? Number(match[1]) : 0; })()",
    timeoutMs,
    "wallet filter reduction"
  );
  if (!Number.isFinite(hiddenSummary) || hiddenSummary <= 0) {
    throw new Error("Wallet filter did not hide any unsupported rows");
  }
  return hiddenSummary;
}

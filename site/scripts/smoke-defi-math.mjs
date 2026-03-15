#!/usr/bin/env node

/**
 * smoke-defi-math — sanity-checks DeFi math against mainnet.
 *
 * Fetches one known market from each protocol, runs the same arithmetic
 * the app uses, and checks the result falls within a very wide "not insane"
 * range.  These ranges are 100–1000× wide — they catch decimal-scale errors
 * (wrong /1e6 vs /1e9) without breaking when real TVL fluctuates.
 *
 * Exit 0 = all checks pass.  Exit 1 = at least one value is out of range.
 */

const GQL = "https://graphql.mainnet.sui.io/graphql";

// ── Protocol constants (mirrored from app source) ──────────────────
const NAVI_RESERVES_TABLE = "0xe6d4c6610b86ce7735ea754596d71d72d10c7980b5052fc3c8cdf8d09fea9b4b";
const NAVI_RAY = 1e27;
const SUILEND_MAIN_POOL_OBJECT = "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1";
const SCALLOP_BALANCE_SHEETS_TABLE = "0x8708eb23153bdc4b345c9f536fe05b62206f3f55629b26389d4fe5f129bd8368";
const AF_BTC_CLEARING_HOUSE = "0x95969906ca735c9d44e8a44b5b7791b4dacaddf70fbdfbda40ccd3f8a9fd4920";
const AF_SUI_CLEARING_HOUSE = "0x5c3eb50f354fb6e518f6877dfadc72e3adf67cf353b6176afb4af2486bd9a30b";

// ── Helpers ──────────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

function numOrZero(v) {
  const n = Number(v?.value ?? v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function parseBigIntSafe(v) {
  try { return BigInt(String(v ?? 0)); } catch { return 0n; }
}

const IFIXED_SIGN_BIT = 1n << 255n;
const IFIXED_FULL_RANGE = 1n << 256n;

function parseIFixed18(val) {
  const raw = parseBigIntSafe(val);
  const signed = raw >= IFIXED_SIGN_BIT ? raw - IFIXED_FULL_RANGE : raw;
  // Convert IFixed (18 dec) to Number
  const abs = signed < 0n ? -signed : signed;
  const whole = abs / (10n ** 18n);
  const frac = abs % (10n ** 18n);
  const result = Number(whole) + Number(frac) / 1e18;
  return signed < 0n ? -result : result;
}

// ── Checks ──────────────────────────────────────────────────────────

/**
 * Each check: { label, fn() → { value, unit } }
 * Range: [min, max] — very wide, only catches 100x+ errors
 */
const CHECKS = [
  {
    label: "NAVI SUI supply",
    unit: "SUI",
    min: 100_000,
    max: 500_000_000,
    async fn() {
      const data = await gql(`{
        address(address: "${NAVI_RESERVES_TABLE}") {
          dynamicFields(first: 50) { nodes { value { ... on MoveValue { json } } } }
        }
      }`);
      for (const n of (data?.address?.dynamicFields?.nodes || [])) {
        const rv = n?.value?.json || {};
        if (!String(rv.coin_type || "").endsWith("::sui::SUI")) continue;
        const shares = numOrZero(rv.supply_balance?.total_supply);
        const idx = numOrZero(rv.current_supply_index) / NAVI_RAY;
        // NAVI stores all shares at 9-decimal precision
        return (shares * idx) / 1e9;
      }
      throw new Error("SUI reserve not found in NAVI");
    },
  },
  {
    label: "NAVI USDC supply",
    unit: "USDC",
    min: 100_000,
    max: 500_000_000,
    async fn() {
      const data = await gql(`{
        address(address: "${NAVI_RESERVES_TABLE}") {
          dynamicFields(first: 50) { nodes { value { ... on MoveValue { json } } } }
        }
      }`);
      for (const n of (data?.address?.dynamicFields?.nodes || [])) {
        const rv = n?.value?.json || {};
        if (!String(rv.coin_type || "").endsWith("::usdc::USDC")) continue;
        const shares = numOrZero(rv.supply_balance?.total_supply);
        const idx = numOrZero(rv.current_supply_index) / NAVI_RAY;
        // NAVI: always /1e9
        return (shares * idx) / 1e9;
      }
      throw new Error("USDC reserve not found in NAVI");
    },
  },
  {
    label: "Suilend USDC supply",
    unit: "USDC",
    min: 100_000,
    max: 500_000_000,
    async fn() {
      const data = await gql(`{
        object(address: "${SUILEND_MAIN_POOL_OBJECT}") {
          asMoveObject { contents { json } }
        }
      }`);
      const reserves = data?.object?.asMoveObject?.contents?.json?.reserves || [];
      for (const r of reserves) {
        if (!String(r?.coin_type?.name || "").endsWith("::usdc::USDC")) continue;
        const available = numOrZero(r.available_amount);
        const borrowed = numOrZero(r.borrowed_amount?.value) / 1e18;
        // Suilend USDC: 6 decimals
        return (available + borrowed) / 1e6;
      }
      throw new Error("USDC reserve not found in Suilend");
    },
  },
  {
    label: "Scallop SUI supply",
    unit: "SUI",
    min: 100_000,
    max: 500_000_000,
    async fn() {
      const data = await gql(`{
        address(address: "${SCALLOP_BALANCE_SHEETS_TABLE}") {
          dynamicFields(first: 50) { nodes { name { json } value { ... on MoveValue { json } } } }
        }
      }`);
      for (const n of (data?.address?.dynamicFields?.nodes || [])) {
        if (!String(n?.name?.json?.name || "").endsWith("::sui::SUI")) continue;
        const bs = n?.value?.json || {};
        const total = numOrZero(bs.cash) + numOrZero(bs.debt);
        // Scallop SUI: 9 decimals (uses token's native decimals)
        return total / 1e9;
      }
      throw new Error("SUI balance sheet not found in Scallop");
    },
  },
  {
    label: "AM BTC/USD open interest",
    unit: "BTC",
    min: 0.001,
    max: 100_000,
    async fn() {
      const data = await gql(`{
        object(address: "${AF_BTC_CLEARING_HOUSE}") {
          asMoveObject { contents { json } }
        }
      }`);
      const ms = data?.object?.asMoveObject?.contents?.json?.market_state;
      if (!ms) throw new Error("BTC/USD clearing house not found");
      // OI is in base asset units, IFixed 18-decimal
      return parseIFixed18(ms.open_interest);
    },
  },
  {
    label: "AM SUI/USD open interest",
    unit: "SUI",
    min: 1,
    max: 100_000_000,
    async fn() {
      const data = await gql(`{
        object(address: "${AF_SUI_CLEARING_HOUSE}") {
          asMoveObject { contents { json } }
        }
      }`);
      const ms = data?.object?.asMoveObject?.contents?.json?.market_state;
      if (!ms) throw new Error("SUI/USD clearing house not found");
      return parseIFixed18(ms.open_interest);
    },
  },
  {
    label: "AM BTC/USD fees accrued",
    unit: "USDC",
    min: 0.01,
    max: 10_000_000,
    async fn() {
      const data = await gql(`{
        object(address: "${AF_BTC_CLEARING_HOUSE}") {
          asMoveObject { contents { json } }
        }
      }`);
      const ms = data?.object?.asMoveObject?.contents?.json?.market_state;
      if (!ms) throw new Error("BTC/USD clearing house not found");
      return parseIFixed18(ms.fees_accrued);
    },
  },
];

// ── Runner ──────────────────────────────────────────────────────────
async function main() {
  let passed = 0;
  let failed = 0;
  const errors = [];

  for (const check of CHECKS) {
    try {
      const value = await check.fn();
      const inRange = value >= check.min && value <= check.max;
      const fmt = value >= 1_000_000
        ? (value / 1_000_000).toFixed(2) + "M"
        : value >= 1_000
          ? (value / 1_000).toFixed(2) + "K"
          : value.toFixed(4);
      const rangeStr = `${fmtRange(check.min)}–${fmtRange(check.max)}`;
      const mark = inRange ? "\u2713" : "\u2717 OUT OF RANGE";
      console.log(`  ${check.label} = ${fmt} ${check.unit} (range ${rangeStr}) ${mark}`);
      if (inRange) {
        passed += 1;
      } else {
        failed += 1;
        errors.push(`${check.label}: ${fmt} ${check.unit} outside [${rangeStr}]`);
      }
    } catch (e) {
      failed += 1;
      const msg = e?.message || String(e);
      console.log(`  ${check.label} = ERROR: ${msg} \u2717`);
      errors.push(`${check.label}: ${msg}`);
    }
  }

  console.log(`smoke:defi-math: ${passed}/${CHECKS.length} checks passed${failed ? ` (${failed} FAILED)` : ""}`);
  if (errors.length) {
    console.log("FAILED checks — likely decimal conversion errors:");
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
}

function fmtRange(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

main().catch((e) => {
  console.error("smoke:defi-math: fatal error:", e?.message || e);
  process.exit(1);
});

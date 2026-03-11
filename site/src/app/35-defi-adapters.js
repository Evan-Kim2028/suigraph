function defiAccountingCloseEnough(actual, expected, tolerance = 0.05) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return true;
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) return true;
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return (diff / scale) <= 0.001;
}
function pushUniqueDefiWarning(warnings, message) {
  const text = String(message || "").trim();
  if (!text || warnings.includes(text)) return;
  warnings.push(text);
}
function validateLendingProtocolAccounting(positions) {
  const warnings = [];
  let sawNetMismatch = false;
  let sawNegativeRows = false;
  for (const pos of (positions || [])) {
    const depositedUsd = Number(pos?.depositedUsd || 0);
    const borrowedUsd = Number(pos?.borrowedUsd || 0);
    const netUsd = Number(pos?.netUsd || 0);
    if (!defiAccountingCloseEnough(netUsd, depositedUsd - borrowedUsd)) sawNetMismatch = true;
    for (const row of (pos?.deposits || [])) {
      if (Number(row?.amount || 0) < -1e-12 || Number(row?.amountUsd || 0) < -1e-9) sawNegativeRows = true;
    }
    for (const row of (pos?.borrows || [])) {
      if (Number(row?.amount || 0) < -1e-12 || Number(row?.amountUsd || 0) < -1e-9) sawNegativeRows = true;
    }
  }
  if (sawNetMismatch) warnings.push("Accounting invariant: netUsd should equal depositedUsd - borrowedUsd.");
  if (sawNegativeRows) warnings.push("Accounting invariant: deposit and borrow balances must be non-negative.");
  return warnings;
}
function validateDexLpProtocolAccounting(positions) {
  const warnings = [];
  let sawTotalMismatch = false;
  for (const pos of (positions || [])) {
    const expectedTotal = Number(pos?.usdA || 0) + Number(pos?.usdB || 0);
    if (!defiAccountingCloseEnough(Number(pos?.totalUsd || 0), expectedTotal)) {
      sawTotalMismatch = true;
      break;
    }
  }
  if (sawTotalMismatch) warnings.push("Accounting invariant: totalUsd should equal usdA + usdB.");
  return warnings;
}
function validateEmberProtocolAccounting(data) {
  const positions = data?.positions || [];
  const totalUsd = Number(data?.totalUsd || 0);
  const summedUsd = positions.reduce((sum, row) => sum + Number(row?.amountUsd || 0), 0);
  return defiAccountingCloseEnough(totalUsd, summedUsd)
    ? []
    : ["Accounting invariant: totalUsd should equal the sum of vault position USD values."];
}
function validateAftermathPerpsAccounting(data) {
  const idleCollateral = Number(data?.idleCollateral || 0);
  const allocatedCollateral = Number(data?.allocatedCollateral || 0);
  const collateral = Number(data?.collateral || 0);
  return defiAccountingCloseEnough(collateral, idleCollateral + allocatedCollateral, 0.0001)
    ? []
    : ["Accounting invariant: collateral should equal idleCollateral + allocatedCollateral."];
}
function buildAddressDefiAdapters(addr) {
  return [
    {
      key: "suilend",
      label: "Suilend",
      kind: "lending",
      load: () => fetchSuilendPositions(addr),
      empty: () => [],
      validate: validateLendingProtocolAccounting,
    },
    {
      key: "navi",
      label: "NAVI",
      kind: "lending",
      load: () => fetchNaviPositions(addr),
      empty: () => [],
      validate: validateLendingProtocolAccounting,
    },
    {
      key: "alpha",
      label: "Alpha",
      kind: "lending",
      load: () => fetchAlphaPositions(addr),
      empty: () => [],
      validate: validateLendingProtocolAccounting,
    },
    {
      key: "scallop",
      label: "Scallop",
      kind: "lending",
      load: () => fetchScallopPositions(addr),
      empty: () => [],
      validate: validateLendingProtocolAccounting,
    },
    {
      key: "cetus",
      label: "Cetus",
      kind: "dex_lp",
      load: () => fetchCetusPositions(addr),
      empty: () => [],
      validate: validateDexLpProtocolAccounting,
    },
    {
      key: "turbos",
      label: "Turbos",
      kind: "dex_lp",
      load: () => fetchTurbosPositions(addr),
      empty: () => [],
      validate: validateDexLpProtocolAccounting,
    },
    {
      key: "wallet",
      label: "Wallet",
      kind: "wallet",
      load: () => fetchDefiWalletBalances(addr),
      empty: () => ({ rows: [], partial: false, scannedPages: 0 }),
      validate: () => [],
    },
    {
      key: "ember",
      label: "Ember",
      kind: "vault",
      load: () => fetchEmberPositions(addr),
      empty: () => ({ positions: [], consumedKeys: new Set(), totalUsd: 0, partial: false }),
      validate: validateEmberProtocolAccounting,
    },
    {
      key: "deepbook",
      label: "DeepBook",
      kind: "margin",
      load: () => fetchDeepBookPositions(addr),
      empty: () => ({ positions: [], pools: {}, riskConfigs: {} }),
      validate: () => [],
    },
    {
      key: "bluefinSpot",
      label: "Bluefin Spot",
      kind: "dex_lp",
      load: () => fetchBluefinSpotPositions(addr),
      empty: () => [],
      validate: validateDexLpProtocolAccounting,
    },
    {
      key: "bluefinPro",
      label: "Bluefin Pro",
      kind: "perps",
      load: () => fetchBluefinProPositions(addr),
      empty: () => ({ positions: [], collateral: 0 }),
      validate: () => [],
    },
    {
      key: "aftermathPerps",
      label: "Aftermath Perps",
      kind: "perps",
      load: () => fetchAftermathPerpsPositions(addr),
      empty: () => ({
        accounts: [],
        economicAccounts: [],
        caps: [],
        markets: [],
        positions: [],
        orders: [],
        collateral: 0,
        idleCollateral: 0,
        allocatedCollateral: 0,
        partial: true,
        warnings: ["Aftermath fetch failed."],
      }),
      validate: validateAftermathPerpsAccounting,
    },
  ];
}
function resolveAddressDefiAdapterResult(adapter, settled) {
  const value = settled?.status === "fulfilled" && settled.value != null
    ? settled.value
    : adapter.empty();
  const warnings = [];
  const embeddedWarnings = Array.isArray(value?.warnings) ? value.warnings : [];
  for (const warning of embeddedWarnings) pushUniqueDefiWarning(warnings, warning);
  if (settled?.status !== "fulfilled") {
    pushUniqueDefiWarning(warnings, settled?.reason?.message || `${adapter.label} fetch failed.`);
  }
  const validationResult = adapter.validate?.(value);
  const validationWarnings = Array.isArray(validationResult) ? validationResult : [];
  for (const warning of validationWarnings) pushUniqueDefiWarning(warnings, warning);
  return {
    ...adapter,
    status: settled?.status || "rejected",
    value,
    partial: (settled?.status !== "fulfilled") || !!value?.partial,
    warnings,
    validationWarnings: [...new Set(validationWarnings.map((warning) => String(warning || "").trim()).filter(Boolean))],
  };
}
async function loadAddressDefiAdapters(addr) {
  const defiAdapters = buildAddressDefiAdapters(addr);
  const settled = await Promise.allSettled(defiAdapters.map((adapter) => adapter.load()));
  return Object.fromEntries(defiAdapters.map((adapter, index) => [
    adapter.key,
    resolveAddressDefiAdapterResult(adapter, settled[index]),
  ]));
}
function collectDefiAccountingWarnings(protocolResults) {
  const warnings = [];
  for (const result of Object.values(protocolResults || {})) {
    for (const warning of (result?.validationWarnings || [])) {
      pushUniqueDefiWarning(warnings, `${result.label}: ${warning}`);
    }
  }
  return warnings.slice(0, 12);
}

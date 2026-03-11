#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const ADAPTERS_PATH = resolve(SITE_ROOT, "src/app/35-defi-adapters.js");
const FIXTURE_PATH = resolve(SITE_ROOT, "fixtures/address-fixtures.json");
const COVERAGE_PATH = resolve(SITE_ROOT, "fixtures/protocol-fixture-coverage.json");
const OWNERSHIP_VALUES = new Set(["team", "public_external", "legacy_personal", "historical_docs"]);
const LIFECYCLE_VALUES = new Set(["active", "historical", "staged"]);
const SLOT_STATUS_VALUES = new Set(["planned", "active"]);

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseAdapters(js) {
  const entries = [];
  const re = /key:\s*"([^"]+)"\s*,\s*label:\s*"([^"]+)"\s*,\s*kind:\s*"([^"]+)"/g;
  let match = null;
  while ((match = re.exec(js))) {
    entries.push({ key: match[1], label: match[2], kind: match[3] });
  }
  if (!entries.length) throw new Error("Could not parse any DeFi adapters from 35-defi-adapters.js");
  return entries;
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function main() {
  const issues = [];
  const adapters = parseAdapters(readFileSync(ADAPTERS_PATH, "utf8"));
  const adapterByKey = new Map();
  for (const adapter of adapters) {
    if (adapterByKey.has(adapter.key)) issues.push(`Duplicate adapter key: ${adapter.key}`);
    adapterByKey.set(adapter.key, adapter);
  }

  const fixtures = Array.isArray(loadJson(FIXTURE_PATH)?.fixtures) ? loadJson(FIXTURE_PATH).fixtures : [];
  const fixtureById = new Map();
  for (const fixture of fixtures) {
    if (fixtureById.has(fixture?.id)) issues.push(`Duplicate fixture id: ${fixture.id}`);
    fixtureById.set(fixture?.id, fixture);
    if (!OWNERSHIP_VALUES.has(String(fixture?.ownership || ""))) {
      issues.push(`Fixture ${fixture?.id || "?"} has invalid ownership: ${fixture?.ownership || "missing"}`);
    }
    if (!LIFECYCLE_VALUES.has(String(fixture?.lifecycle || ""))) {
      issues.push(`Fixture ${fixture?.id || "?"} has invalid lifecycle: ${fixture?.lifecycle || "missing"}`);
    }
    const protocols = uniqueStrings(fixture?.protocols);
    if (!protocols.length) issues.push(`Fixture ${fixture?.id || "?"} must declare at least one protocol key`);
    if (fixture?.tier === "required" && fixture?.lifecycle !== "active") {
      issues.push(`Required fixture ${fixture?.id || "?"} must use lifecycle active`);
    }
    if (fixture?.ownership === "historical_docs" && fixture?.lifecycle !== "historical") {
      issues.push(`Historical docs fixture ${fixture?.id || "?"} must use lifecycle historical`);
    }
  }

  const coverage = loadJson(COVERAGE_PATH) || {};
  const teamSlots = Array.isArray(coverage.teamSlots) ? coverage.teamSlots : [];
  const slotById = new Map();
  for (const slot of teamSlots) {
    if (slotById.has(slot?.id)) issues.push(`Duplicate team slot id: ${slot.id}`);
    slotById.set(slot?.id, slot);
    if (!SLOT_STATUS_VALUES.has(String(slot?.status || ""))) {
      issues.push(`Team slot ${slot?.id || "?"} has invalid status: ${slot?.status || "missing"}`);
    }
    const slotProtocols = uniqueStrings(slot?.protocols);
    if (!slotProtocols.length) issues.push(`Team slot ${slot?.id || "?"} must declare at least one protocol key`);
    for (const key of slotProtocols) {
      if (!adapterByKey.has(key)) issues.push(`Team slot ${slot?.id || "?"} references unknown protocol key: ${key}`);
    }
  }

  const coverageEntries = Array.isArray(coverage.protocols) ? coverage.protocols : [];
  const coverageByKey = new Map();
  for (const entry of coverageEntries) {
    if (coverageByKey.has(entry?.key)) issues.push(`Duplicate protocol coverage entry: ${entry.key}`);
    coverageByKey.set(entry?.key, entry);
  }

  for (const adapter of adapters) {
    const entry = coverageByKey.get(adapter.key);
    if (!entry) {
      issues.push(`Missing protocol coverage entry for adapter ${adapter.key}`);
      continue;
    }
    if (entry?.label !== adapter.label) {
      issues.push(`Protocol ${adapter.key} label mismatch: expected ${adapter.label}, got ${entry?.label || "missing"}`);
    }
    if (entry?.kind !== adapter.kind) {
      issues.push(`Protocol ${adapter.key} kind mismatch: expected ${adapter.kind}, got ${entry?.kind || "missing"}`);
    }
    const liveFixtureIds = uniqueStrings(entry?.liveFixtureIds);
    const teamSlotIds = uniqueStrings(entry?.teamSlotIds);
    if (!liveFixtureIds.length && !teamSlotIds.length) {
      issues.push(`Protocol ${adapter.key} must declare at least one live fixture or one team slot`);
    }
    let sawLegacyLiveFixture = false;
    for (const fixtureId of liveFixtureIds) {
      const fixture = fixtureById.get(fixtureId);
      if (!fixture) {
        issues.push(`Protocol ${adapter.key} references missing live fixture ${fixtureId}`);
        continue;
      }
      const fixtureProtocols = uniqueStrings(fixture?.protocols);
      if (!fixtureProtocols.includes(adapter.key)) {
        issues.push(`Protocol ${adapter.key} references fixture ${fixtureId}, but the fixture does not declare that protocol`);
      }
      if (fixture?.lifecycle !== "active") {
        issues.push(`Protocol ${adapter.key} references non-active live fixture ${fixtureId}`);
      }
      if (fixture?.ownership === "legacy_personal") sawLegacyLiveFixture = true;
    }
    for (const slotId of teamSlotIds) {
      const slot = slotById.get(slotId);
      if (!slot) {
        issues.push(`Protocol ${adapter.key} references missing team slot ${slotId}`);
        continue;
      }
      const slotProtocols = uniqueStrings(slot?.protocols);
      if (!slotProtocols.includes(adapter.key)) {
        issues.push(`Protocol ${adapter.key} references team slot ${slotId}, but the slot does not declare that protocol`);
      }
    }
    if (sawLegacyLiveFixture && !teamSlotIds.length) {
      issues.push(`Protocol ${adapter.key} still depends on a legacy personal fixture without a team-owned slot plan`);
    }
  }

  for (const key of coverageByKey.keys()) {
    if (!adapterByKey.has(key)) issues.push(`Protocol coverage entry ${key} does not map to a current adapter`);
  }

  for (const fixture of fixtures) {
    for (const key of uniqueStrings(fixture?.protocols)) {
      if (!coverageByKey.has(key)) {
        issues.push(`Fixture ${fixture?.id || "?"} references protocol ${key}, but no coverage entry exists`);
      }
    }
  }

  if (issues.length) {
    console.error("protocol-fixture-coverage: failed");
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }

  console.log(`protocol-fixture-coverage: ok (${adapters.length} adapters, ${fixtures.length} fixtures, ${teamSlots.length} team slots)`);
}

main();

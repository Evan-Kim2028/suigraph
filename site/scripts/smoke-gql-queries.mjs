#!/usr/bin/env node

/**
 * smoke-gql-queries — validates that core GraphQL queries still work
 * against the Sui mainnet endpoint.
 *
 * Fires the same queries the app uses for critical routes (dashboard,
 * checkpoint, transaction, address, object) and checks that expected
 * fields are present in the response.  Catches upstream schema changes
 * (renamed/removed fields) without needing a browser.
 *
 * Runs in ~2-3 seconds, no Chrome required.
 */

const GQL = "https://graphql.mainnet.sui.io/graphql";

async function gql(query, variables = {}) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

function assertFields(obj, fields, path = "") {
  const missing = [];
  for (const f of fields) {
    if (obj == null || !(f in obj)) missing.push(`${path}.${f}`);
  }
  if (missing.length) throw new Error(`missing fields: ${missing.join(", ")}`);
}

const CHECKS = [
  {
    label: "Dashboard head (checkpoint + epoch)",
    async fn() {
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
      assertFields(data?.checkpoint, ["sequenceNumber", "digest", "timestamp", "networkTotalTransactions"], "checkpoint");
      assertFields(data?.epoch, ["epochId", "referenceGasPrice", "startTimestamp"], "epoch");
      return `checkpoint ${data.checkpoint.sequenceNumber}, epoch ${data.epoch.epochId}`;
    },
  },
  {
    label: "Recent transactions",
    async fn() {
      const data = await gql(`{
        transactions(last: 3, filter: {}) {
          nodes {
            digest
            sender { address }
            effects { status timestamp }
          }
        }
      }`);
      const nodes = data?.transactions?.nodes || [];
      if (!nodes.length) throw new Error("no transactions returned");
      assertFields(nodes[0], ["digest", "sender", "effects"], "tx[0]");
      assertFields(nodes[0].effects, ["status", "timestamp"], "tx[0].effects");
      return `${nodes.length} txs, latest status=${nodes[0].effects.status}`;
    },
  },
  {
    label: "Recent checkpoints",
    async fn() {
      const data = await gql(`{
        checkpoints(last: 3) {
          nodes {
            sequenceNumber digest timestamp
            networkTotalTransactions
            rollingGasSummary { computationCost storageCost storageRebate }
          }
        }
      }`);
      const nodes = data?.checkpoints?.nodes || [];
      if (!nodes.length) throw new Error("no checkpoints returned");
      assertFields(nodes[0], ["sequenceNumber", "digest", "timestamp", "rollingGasSummary"], "cp[0]");
      return `${nodes.length} checkpoints, latest #${nodes[0].sequenceNumber}`;
    },
  },
  {
    label: "Checkpoint detail shell",
    async fn() {
      // Fetch latest checkpoint number first, then query its detail
      const head = await gql(`{ checkpoint { sequenceNumber } }`);
      const seq = Number(head?.checkpoint?.sequenceNumber || 0);
      if (!seq) throw new Error("no checkpoint number");
      const data = await gql(`query($seq: UInt53!) {
        checkpoint(sequenceNumber: $seq) {
          sequenceNumber digest timestamp
          previousCheckpointDigest
          epoch { epochId }
          rollingGasSummary { computationCost storageCost storageRebate }
          transactions(first: 3) {
            pageInfo { hasNextPage }
            nodes { digest sender { address } effects { status timestamp } }
          }
        }
      }`, { seq });
      assertFields(data?.checkpoint, ["sequenceNumber", "digest", "timestamp", "epoch", "transactions"], "checkpoint");
      return `checkpoint #${seq}, epoch ${data.checkpoint.epoch?.epochId}`;
    },
  },
  {
    label: "Transaction detail shell",
    async fn() {
      // Get a recent tx digest
      const recent = await gql(`{ transactions(last: 1, filter: {}) { nodes { digest } } }`);
      const digest = recent?.transactions?.nodes?.[0]?.digest;
      if (!digest) throw new Error("no tx digest");
      const data = await gql(`query($digest: String!) {
        transaction(digest: $digest) {
          digest
          sender { address }
          kind {
            ... on ProgrammableTransaction {
              commands(first: 5) { nodes { __typename } }
            }
          }
          effects {
            status timestamp
            gasEffects {
              gasSummary { computationCost storageCost storageRebate }
              gasObject { address }
            }
          }
        }
      }`, { digest });
      assertFields(data?.transaction, ["digest", "sender", "effects"], "transaction");
      assertFields(data?.transaction?.effects, ["status", "timestamp", "gasEffects"], "effects");
      return `tx ${digest.slice(0, 12)}..., status=${data.transaction.effects.status}`;
    },
  },
  {
    label: "Address shell",
    async fn() {
      // Use the Sui system address — always has objects
      const addr = "0x0000000000000000000000000000000000000000000000000000000000000000";
      const data = await gql(`query($addr: SuiAddress!) {
        address(address: $addr) {
          address
          defaultNameRecord { domain }
          objects(first: 3) {
            pageInfo { hasNextPage }
            nodes { address contents { type { repr } } }
          }
        }
      }`, { addr });
      assertFields(data?.address, ["address", "objects"], "address");
      const objCount = data?.address?.objects?.nodes?.length || 0;
      return `${objCount} objects, hasMore=${data?.address?.objects?.pageInfo?.hasNextPage}`;
    },
  },
  {
    label: "Object shell (SUI system)",
    async fn() {
      const id = "0x0000000000000000000000000000000000000000000000000000000000000005";
      const data = await gql(`query($id: SuiAddress!) {
        object(address: $id) {
          address version digest
          asMovePackage {
            modules(first: 3) {
              pageInfo { hasNextPage }
              nodes { name }
            }
          }
        }
      }`, { id });
      assertFields(data?.object, ["address", "version", "digest"], "object");
      const mods = data?.object?.asMovePackage?.modules?.nodes?.length || 0;
      return `v${data.object.version}, ${mods}+ modules`;
    },
  },
  {
    label: "Validators query",
    async fn() {
      const data = await gql(`{
        epoch {
          validatorSet {
            activeValidators(first: 3) {
              nodes {
                atRisk
                contents { json }
              }
            }
          }
        }
      }`);
      const vals = data?.epoch?.validatorSet?.activeValidators?.nodes || [];
      if (!vals.length) throw new Error("no validators returned");
      const name = vals[0]?.contents?.json?.metadata?.name || "?";
      return `${vals.length}+ validators, first=${name}`;
    },
  },
];

async function main() {
  let passed = 0;
  let failed = 0;
  const errors = [];

  for (const check of CHECKS) {
    try {
      const detail = await check.fn();
      console.log(`  ${check.label}: ${detail} \u2713`);
      passed += 1;
    } catch (e) {
      const msg = e?.message || String(e);
      console.log(`  ${check.label}: ${msg} \u2717`);
      failed += 1;
      errors.push(`${check.label}: ${msg}`);
    }
  }

  console.log(`smoke:gql-queries: ${passed}/${CHECKS.length} checks passed${failed ? ` (${failed} FAILED)` : ""}`);
  if (errors.length) {
    console.log("FAILED — GraphQL query compatibility issues:");
    for (const e of errors) console.log(`  - ${e}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("smoke:gql-queries: fatal error:", e?.message || e);
  process.exit(1);
});

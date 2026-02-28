#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(__dirname, "..");
const OUT_PATH = resolve(SITE_ROOT, "docs/schema-root-fields.json");
const ENDPOINT = process.env.SUI_GRAPHQL_ENDPOINT || "https://graphql.mainnet.sui.io/graphql";

const query = `query RootFields {
  __schema {
    queryType { name fields { name } }
    mutationType { name fields { name } }
    subscriptionType { name fields { name } }
  }
}`;

async function main() {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${ENDPOINT}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0]?.message || "Introspection failed");
  }
  const schema = json?.data?.__schema;
  const payload = {
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    queryType: schema?.queryType?.name || "Query",
    mutationType: schema?.mutationType?.name || null,
    subscriptionType: schema?.subscriptionType?.name || null,
    queryFields: (schema?.queryType?.fields || []).map((f) => f.name).sort(),
    mutationFields: (schema?.mutationType?.fields || []).map((f) => f.name).sort(),
    subscriptionFields: (schema?.subscriptionType?.fields || []).map((f) => f.name).sort(),
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`refresh-schema-root-fields: wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(`refresh-schema-root-fields: ${err.message}`);
  process.exit(1);
});

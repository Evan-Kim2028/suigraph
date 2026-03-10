function collectTemplateConstants(src) {
  const constants = new Map();
  const re = /\bconst\s+([A-Z_][A-Z0-9_]*)\s*=\s*`([\s\S]*?)`;/g;
  for (const m of src.matchAll(re)) constants.set(m[1], String(m[2] || ""));
  return constants;
}

function expandTemplateValue(value, constants, seen = new Set()) {
  const text = String(value || "");
  return text.replace(/\$\{\s*([A-Z_][A-Z0-9_]*)\s*\}/g, (full, name) => {
    if (!constants.has(name) || seen.has(name)) return full;
    seen.add(name);
    const expanded = expandTemplateValue(constants.get(name), constants, seen);
    seen.delete(name);
    return expanded;
  });
}

export function collectStaticGqlQueries(src) {
  const source = String(src || "");
  const constants = collectTemplateConstants(source);
  const queries = [];

  for (const m of source.matchAll(/\bgql\s*\(\s*`([\s\S]*?)`\s*(?:,|\))/g)) {
    queries.push(expandTemplateValue(m[1], constants));
  }

  for (const m of source.matchAll(/\bgql\s*\(\s*([A-Z_][A-Z0-9_]*)\s*(?:,|\))/g)) {
    const name = m[1];
    if (!constants.has(name)) continue;
    queries.push(expandTemplateValue(constants.get(name), constants));
  }

  return queries;
}

// Shared helpers for the docs tooling. Apache-2.0.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = join(ROOT, "schemas", "v0.1");
export const SCHEMA_BASE = "https://agentworldprotocol.com/schemas/v0.1/";

export function walk(dir, pred = () => true, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

/** Every schema under schemas/v0.1/, including profiles/, as paths relative to SCHEMA_DIR. */
export function loadSchemas() {
  const files = walk(SCHEMA_DIR, (p) => p.endsWith(".schema.json")).map((p) => relative(SCHEMA_DIR, p)).sort();
  return files.map((f) => {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
    if (schema.$id !== SCHEMA_BASE + f) {
      throw new Error(`${f}: $id must be ${SCHEMA_BASE + f}, got ${schema.$id}`);
    }
    return { file: f, name: f.replace(/\.schema\.json$/, ""), schema };
  });
}

export const VENDOR_FIELD = "^x-[a-z0-9]+\\.";

/**
 * The canonical schemas are receiver schemas: unknown fields are accepted (AWP-VER-003). Two
 * annotations carry the stricter sender rules, applied by `lintSchema` to produce the sender
 * schema that CI validates examples, doc blocks, and traces against:
 *   "x-awp-closed": true  — senders emit only declared fields and x-<vendor>. fields (AWP-VER-004);
 *   "x-awp-lint": { … }   — keywords merged into the schema, e.g. sender-only value constraints.
 */
export function lintSchema(node) {
  if (Array.isArray(node)) return node.map(lintSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "x-awp-closed" || k === "x-awp-lint") continue;
    out[k] = lintSchema(v);
  }
  if (node["x-awp-lint"]) Object.assign(out, lintSchema(node["x-awp-lint"]));
  if (node["x-awp-closed"] === true) {
    out.additionalProperties = false;
    out.patternProperties = { [VENDOR_FIELD]: {}, ...(out.patternProperties ?? {}) };
  }
  return out;
}

export const rel = (p) => relative(ROOT, p);

/** Write a generated file, or in --check mode fail if it differs. Returns true when content matches. */
export function emit(path, content, check) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (check) {
    if (current !== content) {
      console.error(`DRIFT: ${rel(path)} is out of date; run \`npm run gen\``);
      return false;
    }
    return true;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (current !== content) {
    writeFileSync(path, content);
    console.log(`wrote ${rel(path)}`);
  }
  return true;
}

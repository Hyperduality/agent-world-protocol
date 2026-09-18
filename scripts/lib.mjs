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

export function loadSchemas() {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json")).sort();
  return files.map((f) => {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8"));
    if (schema.$id !== SCHEMA_BASE + f) {
      throw new Error(`${f}: $id must be ${SCHEMA_BASE + f}, got ${schema.$id}`);
    }
    return { file: f, name: f.replace(/\.schema\.json$/, ""), schema };
  });
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

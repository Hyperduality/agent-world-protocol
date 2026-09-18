#!/usr/bin/env node
// Validates the canonical schemas, the example instances, every tagged JSON block in the docs,
// and the data-plane frame test vectors. Exit code 1 on any failure. Apache-2.0.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ROOT, SCHEMA_BASE, loadSchemas, walk, rel } from "./lib.mjs";
import { decodeFrame, unhex, hex } from "./frame-codec.mjs";

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);

// ---------------------------------------------------------------- schemas
const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const schemas = loadSchemas();
for (const { schema } of schemas) ajv.addSchema(schema);
for (const { file, schema } of schemas) {
  try {
    ajv.compile(schema);
    ok(`schema ${file} compiles`);
  } catch (e) {
    fail(`schema ${file}: ${e.message}`);
  }
}

// Tag → schema mapping for ```json awp:<tag> blocks. Tags not listed map to <tag>.schema.json.
const TAG_ALIASES = {
  "obs-frame": "frame-inline",
  "cmd-frame": "frame-inline",
  "world-resetting-event": "world-event",
  "envelope": "safety-policy#/$defs/envelope",
  "task": "common#/$defs/task",
};

function validatorFor(tag) {
  const target = TAG_ALIASES[tag] ?? tag;
  const [name, fragment] = target.split("#");
  const id = SCHEMA_BASE + name + ".schema.json" + (fragment ? "#" + fragment : "");
  const v = ajv.getSchema(id);
  if (!v) throw new Error(`no schema for tag "${tag}" (looked for ${id})`);
  return v;
}

/** If the object is a JSON-RPC envelope, validate its params/result; otherwise the object itself. */
function unwrap(obj) {
  if (obj && typeof obj === "object" && obj.jsonrpc === "2.0") {
    if ("params" in obj) return obj.params;
    if ("result" in obj) return obj.result;
    if ("error" in obj) return obj.error;
  }
  return obj;
}

function report(where, v) {
  fail(`${where}: ${ajv.errorsText(v.errors, { separator: "\n       " })}`);
}

// ---------------------------------------------------------------- examples
for (const p of walk(join(ROOT, "examples"), (f) => f.endsWith(".json"))) {
  const inst = JSON.parse(readFileSync(p, "utf8"));
  const id = inst.$schema;
  const v = id && ajv.getSchema(id);
  if (!v) { fail(`${rel(p)}: missing or unknown $schema`); continue; }
  const { $schema, ...body } = inst;
  if (v(body)) ok(`example ${rel(p)}`); else report(rel(p), v);
}

// ---------------------------------------------------------------- tagged doc blocks
const fence = /```json[ \t]+awp:([A-Za-z0-9_.#$/-]+)[^\n]*\n([\s\S]*?)```/g;
let tagged = 0;
for (const p of walk(ROOT, (f) => f.endsWith(".mdx") || f.endsWith(".md"))) {
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(fence)) {
    tagged++;
    const tag = m[1];
    const line = text.slice(0, m.index).split("\n").length;
    const where = `${rel(p)}:${line} (awp:${tag})`;
    let obj;
    try {
      obj = JSON.parse(m[2]);
    } catch (e) {
      fail(`${where}: not valid JSON — ${e.message}`);
      continue;
    }
    let v;
    try { v = validatorFor(tag); } catch (e) { fail(`${where}: ${e.message}`); continue; }
    const body = unwrap(obj);
    if (v(body)) ok(where); else report(where, v);
  }
}
if (tagged === 0) fail("no tagged JSON blocks found in docs");

// ---------------------------------------------------------------- frame test vectors
const vectorsPath = join(ROOT, "schemas", "test-vectors", "frames.json");
const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8"));
for (const v of vectors) {
  const where = `vector ${v.name}`;
  let decoded;
  try {
    decoded = decodeFrame(unhex(v.hex));
  } catch (e) {
    if (!v.expect_error) { fail(`${where}: unexpected ${e.code ?? e.name}: ${e.message}`); continue; }
    if (e.code !== v.expect_error) { fail(`${where}: expected ${v.expect_error}, got ${e.code}`); continue; }
    ok(`${where} rejected with ${e.code}`);
    continue;
  }
  if (v.expect_error) { fail(`${where}: expected ${v.expect_error} but decoded`); continue; }
  const got = { ...decoded, payload_len: decoded.payload.length, payload_hex: hex(decoded.payload) };
  delete got.payload;
  if (!got.vendor.length) delete got.vendor;
  const diffs = Object.keys(v.expect).filter((k) => JSON.stringify(got[k]) !== JSON.stringify(v.expect[k]));
  if (diffs.length) fail(`${where}: mismatch on ${diffs.join(", ")}`); else ok(where);
}

console.log(failures ? `\n${failures} failure(s)` : `\nall checks passed (${schemas.length} schemas, ${tagged} tagged blocks, ${vectors.length} vectors)`);
process.exit(failures ? 1 : 0);

#!/usr/bin/env node
// Validates the canonical schemas, the example instances, every tagged JSON block in the docs,
// the frame test vectors, and the wire traces. Exit code 1 on any failure. Apache-2.0.
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

// ---------------------------------------------------------------- wire traces
// Method → schema for params, result, or notification params. A trace line is
// { from: "agent"|"world", step, msg } or { marker } (a transport event, not a message).
export const METHODS = {
  "initialize": { params: "agent-manifest", result: "world-manifest" },
  "world.manifest": { params: "empty-result", result: "world-manifest" },
  "ping": { params: "ping", result: "ping-result" },
  "session.open": { params: "session-open", result: "session-ready" },
  "session.resume": { params: "session-resume", result: "session-ready" },
  "session.close": { params: "empty-result", result: "empty-result" },
  "session.transfer": { params: "session-transfer", result: "session-transfer-result" },
  "session.state": { notification: "session-state" },
  "session.telemetry": { notification: "session-telemetry" },
  "task.update": { params: "task-update", result: "empty-result" },
  "obs.subscribe": { params: "subscribe", result: "subscribe-result" },
  "obs.unsubscribe": { params: "unsubscribe", result: "subscribe-result" },
  "obs.frame": { notification: "frame-inline" },
  "obs.report": { notification: "obs-report" },
  "cmd.frame": { notification: "frame-inline" },
  "action.submit": { params: "action-submit", result: "action-submit-result" },
  "action.cancel": { params: "action-ref", result: "action-cancel-result" },
  "action.status": { params: "action-ref", result: "action-status", notification: "action-status" },
  "world.tick": { params: "tick", result: "tick-result" },
  "world.snapshot": { params: "empty-result", result: "snapshot-result" },
  "world.restore": { params: "restore", result: "reset-result" },
  "world.reset": { params: "reset", result: "reset-result" },
  "world.event": { notification: "world-event" },
  "safety.approval_requested": { notification: "approval-requested" },
  "safety.approval.respond": { params: "approval-respond", result: "empty-result" },
};
const schemaFor = (name) => ajv.getSchema(SCHEMA_BASE + name + ".schema.json");
for (const name of new Set(Object.values(METHODS).flatMap((m) => Object.values(m)))) {
  if (!schemaFor(name)) fail(`METHODS map names missing schema ${name}`);
}
const traceFiles = walk(join(ROOT, "examples", "v0.1", "traces"), (f) => f.endsWith(".jsonl")).sort();
for (const p of traceFiles) {
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  const pending = new Map(); // `${from}:${id}` -> method
  let nextStatusSeq = null, bad = 0; // first status_seq seen sets the baseline; then +1 per notification
  const seqs = new Map(); // channel_id -> last seq
  const problem = (n, msg) => { bad++; fail(`${rel(p)}:${n}: ${msg}`); };
  lines.forEach((line, i) => {
    const n = i + 1;
    let entry;
    try { entry = JSON.parse(line); } catch (e) { return problem(n, `not valid JSON — ${e.message}`); }
    if (entry.marker) return;
    const { from, msg } = entry;
    if (!["agent", "world"].includes(from) || !msg) return problem(n, `expected { from, msg } or { marker }`);
    if (msg.jsonrpc !== "2.0") return problem(n, `jsonrpc must be "2.0"`);
    const check = (name, value, what) => { const v = schemaFor(name); if (!v(value)) problem(n, `${what} invalid against ${name}: ${ajv.errorsText(v.errors, { separator: "; " })}`); };
    if (msg.method !== undefined) {
      const spec = METHODS[msg.method];
      if (!spec) return problem(n, `unknown method ${msg.method}`);
      if (msg.id !== undefined) {
        if (!spec.params) return problem(n, `${msg.method} is notification-only`);
        check(spec.params, msg.params ?? {}, `${msg.method} params`);
        pending.set(`${from}:${msg.id}`, msg.method);
      } else {
        if (!spec.notification) return problem(n, `${msg.method} is not a notification`);
        check(spec.notification, msg.params ?? {}, `${msg.method} notification`);
        if (msg.method === "obs.frame" || msg.method === "cmd.frame") {
          const { channel_id, seq, flags } = msg.params;
          const last = seqs.get(`${from}:${channel_id}`);
          if (last !== undefined && seq <= last) problem(n, `channel ${channel_id} seq ${seq} not increasing (last ${last})`);
          if (last !== undefined && seq !== last + 1 && !(flags & 0x08)) problem(n, `channel ${channel_id} seq gap without resync`);
          seqs.set(`${from}:${channel_id}`, seq);
        }
      }
    } else if (msg.result !== undefined || msg.error !== undefined) {
      const other = from === "agent" ? "world" : "agent";
      const method = pending.get(`${other}:${msg.id}`);
      if (!method) return problem(n, `response to unknown request id ${msg.id}`);
      pending.delete(`${other}:${msg.id}`);
      if (msg.error !== undefined) check("error", msg.error, `${method} error`);
      else check(METHODS[method].result, msg.result, `${method} result`);
      if (from === "world" && msg.result && ["action.submit", "action.cancel"].includes(method) && msg.result.status_seq !== undefined) {
        if (nextStatusSeq !== null && msg.result.status_seq !== nextStatusSeq) problem(n, `status_seq ${msg.result.status_seq}, expected ${nextStatusSeq} (AWP-CTL-008)`);
        nextStatusSeq = msg.result.status_seq + 1;
      }
    } else return problem(n, `neither request, notification, nor response`);
    if (from === "world" && msg.method && ["action.status", "world.event", "session.state"].includes(msg.method) && msg.id === undefined) {
      if (nextStatusSeq !== null && msg.params.status_seq !== nextStatusSeq) problem(n, `status_seq ${msg.params.status_seq}, expected ${nextStatusSeq} (AWP-CTL-008)`);
      nextStatusSeq = msg.params.status_seq + 1;
    }
  });
  for (const [k, m] of pending) problem(lines.length, `request ${k} (${m}) never answered`);
  if (!bad) ok(`trace ${rel(p)} (${lines.length} lines)`);
}

console.log(failures ? `\n${failures} failure(s)` : `\nall checks passed (${schemas.length} schemas, ${tagged} tagged blocks, ${vectors.length} vectors, ${traceFiles.length} traces)`);
process.exit(failures ? 1 : 0);

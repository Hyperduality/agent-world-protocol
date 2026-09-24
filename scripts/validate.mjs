#!/usr/bin/env node
// Validates the canonical schemas, the example instances, every tagged JSON block in the docs,
// the frame test vectors, and the wire traces. Exit code 1 on any failure. Apache-2.0.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { ROOT, SCHEMA_BASE, loadSchemas, lintSchema, walk, rel } from "./lib.mjs";
import { decodeFrame, unhex, hex } from "./frame-codec.mjs";

let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);

// ---------------------------------------------------------------- schemas
// `receiver` holds the canonical schemas, which accept unknown fields (AWP-VER-003). `ajv` holds
// their sender (lint) form (lib.mjs lintSchema); everything this repo emits is validated against it.
const newAjv = () => { const a = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true }); addFormats(a); return a; };
const receiver = newAjv();
const ajv = newAjv();
const schemas = loadSchemas();
for (const { schema } of schemas) { receiver.addSchema(schema); ajv.addSchema(lintSchema(schema)); }
for (const { file, schema } of schemas) {
  try {
    receiver.compile(schema);
    ajv.getSchema(schema.$id);
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
  // Receiver tolerance: the canonical schema accepts a field from a later version and a vendor field.
  const r = receiver.getSchema(id);
  if (!r({ ...body, future_field_v0_2: { any: "value" }, "x-acme.note": 1 })) fail(`${rel(p)}: canonical schema rejects unknown fields (AWP-VER-003): ${receiver.errorsText(r.errors)}`);
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
// ---------------------------------------------------------------- action lifecycle table
// spec/action-lifecycle.yaml is normative; the diagram on the lifecycle page must draw exactly its edges.
const LIFECYCLE = YAML.parse(readFileSync(join(ROOT, "spec", "action-lifecycle.yaml"), "utf8"));
const EDGES = new Map(LIFECYCLE.transitions.map((t) => [`${t.from}>${t.to}`, t]));
const TERMINAL = new Set(Object.entries(LIFECYCLE.states).filter(([, c]) => c === "terminal").map(([s]) => s));
{
  const page = readFileSync(join(ROOT, "spec", "loop", "action-lifecycle.mdx"), "utf8");
  const drawn = new Set([...(page.match(/```mermaid\n([\s\S]*?)```/)?.[1] ?? "").matchAll(/^\s*(\w+) --> (\w+)/gm)].map((m) => `${m[1]}>${m[2]}`));
  const missing = [...EDGES.keys()].filter((e) => !drawn.has(e));
  const extra = [...drawn].filter((e) => !EDGES.has(e));
  if (missing.length || extra.length) fail(`action-lifecycle.mdx diagram disagrees with spec/action-lifecycle.yaml — missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`);
  else ok(`lifecycle diagram matches spec/action-lifecycle.yaml (${EDGES.size} transitions)`);
}

// ---------------------------------------------------------------- wire traces
// Beyond schemas, each trace is checked for meaning: every action follows the lifecycle table with a permitted
// reason and reaches at most one terminal state; resubmissions are idempotent or conflicts (AWP-ACT-001/009/010);
// status_seq is gapless, and after session.resume replay starts at last_status_seq + 1 with redelivered values
// matching what was first reported (AWP-CTL-008, AWP-LIF-009); frame seq is checked per channel with its loss
// class; and a trace that declares t0_ns checks the watchdog (AWP-SAF-003/004). A marker may carry `given`:
// { status_seq, actions: { id: { state, status_seq, content? } } } for a trace that continues another. A line
// with delivered: false was sent but lost with its connection; it still changes world state. While a session is
// closing, the world refuses what AWP-SES-011 lists and answers session.close only after every action has ended.
const SUBMIT_FIELDS = ["type", "params", "embodiment_id", "preempt", "deadline_ms", "basis_ts_mono_ns", "valid_until_ns"];
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const REFUSED_WHILE_CLOSING = new Set(["action.submit", "action.cancel", "obs.subscribe", "obs.unsubscribe", "world.tick", "world.reset", "session.resume"]);
const identical = (a, b) => SUBMIT_FIELDS.every((f) => (f in a) === (f in b) && JSON.stringify(canon(a[f])) === JSON.stringify(canon(b[f])));

const traceFiles = walk(join(ROOT, "examples", "v0.1", "traces"), (f) => f.endsWith(".jsonl")).sort();
for (const p of traceFiles) {
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  const pending = new Map(); // `${from}:${id}` -> { method, params }
  let bad = 0;
  const problem = (n, msg) => { bad++; fail(`${rel(p)}:${n}: ${msg}`); };
  // status_seq discipline
  let nextSeq = null, highest = 0, replayTo = 0;
  const reported = new Map(); // status_seq -> identity of what it reported
  // lifecycle
  const actions = new Map(); // action_id -> { state, seq, content }
  // frames
  const seqs = new Map(), lossByName = new Map(), lossById = new Map(), needResync = new Set();
  // watchdog
  let watchdogMs = null, t0 = null, originatedAfterT0 = false;
  // closing
  let closing = false, closedReported = false;

  const identity = (kind, x) => kind === "action" ? `action:${x.action_id}:${x.state}` : kind === "world.event" ? `event:${x.event}` : `session:${x.state}`;
  /** A world-assigned status_seq. Returns false for a redelivery (already reported), true for a new transition. */
  function seqArrived(n, seq, id) {
    if (nextSeq !== null && seq !== nextSeq) problem(n, `status_seq ${seq}, expected ${nextSeq} (AWP-CTL-008)`);
    nextSeq = seq + 1;
    if (seq <= highest) {
      if (reported.has(seq) && reported.get(seq) !== id) problem(n, `status_seq ${seq} redelivered as ${id}, first reported as ${reported.get(seq)} (AWP-LIF-009)`);
      if (seq > replayTo) problem(n, `status_seq ${seq} repeated outside a replay`);
      return false;
    }
    highest = seq; reported.set(seq, id);
    return true;
  }
  function transition(n, actionId, state, reason, seq) {
    const a = actions.get(actionId) ?? { state: "submitted", seq: 0 };
    if (TERMINAL.has(a.state)) return problem(n, `${actionId}: ${a.state} → ${state} after a terminal state (AWP-LIF-001)`);
    if (a.state === state) {
      if (!["executing", "cancelling"].includes(state)) problem(n, `${actionId}: repeated ${state} (only executing and cancelling carry updates)`);
    } else {
      const edge = EDGES.get(`${a.state}>${state}`);
      if (!edge) problem(n, `${actionId}: ${a.state} → ${state} is not in spec/action-lifecycle.yaml`);
      else if (edge.wire === "error") problem(n, `${actionId}: ${a.state} → ${state} is reported as a JSON-RPC error, not a status`);
      else if (reason && edge.reasons && !reason.startsWith("x-") && !edge.reasons.includes(reason)) problem(n, `${actionId}: reason ${reason} not permitted on ${a.state} → ${state}`);
    }
    actions.set(actionId, { ...a, state, seq });
  }

  lines.forEach((line, i) => {
    const n = i + 1;
    let entry;
    try { entry = JSON.parse(line); } catch (e) { return problem(n, `not valid JSON — ${e.message}`); }
    if (entry.marker) {
      const g = entry.given;
      if (g) {
        nextSeq = g.status_seq + 1; highest = g.status_seq;
        for (const [id, a] of Object.entries(g.actions ?? {})) actions.set(id, { state: a.state, seq: a.status_seq, content: a.content ?? null });
        if (g.watchdog_ms) watchdogMs = g.watchdog_ms;
        for (const [id, lc] of Object.entries(g.channels ?? {})) lossById.set(Number(id), lc);
      }
      if (entry.t0_ns !== undefined) { t0 = entry.t0_ns; originatedAfterT0 = false; }
      return;
    }
    const { from, msg } = entry;
    if (!["agent", "world"].includes(from) || !msg) return problem(n, `expected { from, msg } or { marker }`);
    if (msg.jsonrpc !== "2.0") return problem(n, `jsonrpc must be "2.0"`);
    const check = (name, value, what) => { const v = schemaFor(name); if (!v(value)) problem(n, `${what} invalid against ${name}: ${ajv.errorsText(v.errors, { separator: "; " })}`); };
    if (from === "agent" && msg.method !== undefined && t0 !== null) originatedAfterT0 = true;

    if (msg.method !== undefined) {
      const spec = METHODS[msg.method];
      if (!spec) return problem(n, `unknown method ${msg.method}`);
      if (msg.id !== undefined) {
        if (!spec.params) return problem(n, `${msg.method} is notification-only`);
        check(spec.params, msg.params ?? {}, `${msg.method} params`);
        pending.set(`${from}:${msg.id}`, { method: msg.method, params: msg.params ?? {}, closing });
        if (from === "agent" && msg.method === "session.close") closing = true;
        return;
      }
      if (!spec.notification) return problem(n, `${msg.method} is not a notification`);
      const params = msg.params ?? {};
      check(spec.notification, params, `${msg.method} notification`);
      if (msg.method === "obs.frame" || msg.method === "cmd.frame") {
        const { channel_id, seq, flags } = params;
        const key = `${from}:${channel_id}`, last = seqs.get(key);
        const reliable = (lossById.get(channel_id) ?? "reliable") === "reliable";
        if (last !== undefined && seq <= last) problem(n, `channel ${channel_id} seq ${seq} not increasing (last ${last})`);
        if (reliable && last !== undefined && seq !== last + 1 && !(flags & 0x08)) problem(n, `reliable channel ${channel_id}: seq gap without resync (AWP-DAT-001)`);
        if (needResync.has(key)) {
          if (reliable && (flags & 0x09) !== 0x09) problem(n, `reliable channel ${channel_id}: first frame after resumption must be a resync keyframe (AWP-TRN-008)`);
          needResync.delete(key);
        }
        seqs.set(key, seq);
      }
      if (from === "world" && ["action.status", "world.event", "session.state"].includes(msg.method)) {
        const kind = msg.method === "action.status" ? "action" : msg.method;
        const fresh = seqArrived(n, params.status_seq, identity(kind, params));
        if (fresh && kind === "session.state" && params.state === "closed") closedReported = true;
        if (fresh && kind === "action") transition(n, params.action_id, params.state, params.reason, params.status_seq);
        if (fresh && params.event === "safe_state_entered" && t0 !== null && watchdogMs !== null) {
          const dt = (params.ts_mono_ns - t0) / 1e6;
          // A replayed event was emitted during the gap, so file order says nothing about what the agent sent before it.
          if (originatedAfterT0 && params.status_seq > replayTo) problem(n, `watchdog tripped although the agent originated a message after t0 (AWP-SAF-003)`);
          if (dt < watchdogMs || dt > watchdogMs + 100) problem(n, `safe state entered ${dt} ms after t0; expected watchdog_ms (${watchdogMs}) to +100 ms (AWP-SAF-004, AWP-SAF-012)`);
          t0 = null;
        }
      }
      return;
    }

    if (msg.result === undefined && msg.error === undefined) return problem(n, `neither request, notification, nor response`);
    const other = from === "agent" ? "world" : "agent";
    const req = pending.get(`${other}:${msg.id}`);
    if (!req) return problem(n, `response to unknown request id ${msg.id}`);
    pending.delete(`${other}:${msg.id}`);
    const { method, params } = req;
    if (msg.error !== undefined) check("error", msg.error, `${method} error`);
    else check(METHODS[method].result, msg.result, `${method} result`);
    if (from !== "world") return;
    const r = msg.result;
    if (req.closing && REFUSED_WHILE_CLOSING.has(method) && msg.error?.code !== 2003) problem(n, `${method} while the session is closing must fail AWP_SESSION_EXPIRED (AWP-SES-011)`);
    if (method === "session.close" && r) {
      const open = [...actions].filter(([, a]) => !TERMINAL.has(a.state)).map(([id]) => id);
      if (open.length) problem(n, `session.close answered while ${open.join(", ")} not terminal (AWP-SES-011)`);
      if (!closedReported) problem(n, `session.close answered before session.state: closed (AWP-SES-011)`);
      closing = false;
    }

    if (method === "initialize" && r) {
      for (const c of r.observation_channels ?? []) lossByName.set(c.id, c.loss_class);
      if (r.safety_policy?.safe_state?.watchdog_ms) watchdogMs = r.safety_policy.safe_state.watchdog_ms;
    }
    if ((method === "session.open" || method === "session.resume") && r) {
      for (const c of r.granted?.channels ?? []) if (c.channel_id !== undefined && lossByName.has(c.channel)) lossById.set(c.channel_id, lossByName.get(c.channel));
    }
    if (method === "session.resume" && r) {
      if (r.replay_to_status_seq === undefined) problem(n, `session.resume result lacks replay_to_status_seq (AWP-CTL-008)`);
      else if (r.replay_to_status_seq < highest) problem(n, `replay_to_status_seq ${r.replay_to_status_seq} is below the highest status_seq already reported (${highest})`);
      else replayTo = r.replay_to_status_seq;
      nextSeq = params.last_status_seq + 1;
      for (const [id, lc] of lossById) if (lc === "reliable") needResync.add(`world:${id}`);
    }
    if (method === "action.submit") {
      const known = actions.get(params.action_id);
      if (msg.error) {
        if (msg.error.code === 3004 && (!known || (known.content && identical(known.content, params)))) problem(n, `AWP_ACTION_ID_CONFLICT without a conflicting admitted action (AWP-ACT-001)`);
        if (known && known.content && !identical(known.content, params) && msg.error.code !== 3004) problem(n, `resubmission of ${params.action_id} with different content must fail AWP_ACTION_ID_CONFLICT (AWP-ACT-001)`);
        if (known && known.content && identical(known.content, params)) problem(n, `identical resubmission of ${params.action_id} must be idempotent, not an error (AWP-ACT-001)`);
        return; // a failed admission creates no action (AWP-ACT-010)
      }
      if (known) {
        if (known.content && !identical(known.content, params)) problem(n, `resubmission of ${params.action_id} with different content was admitted (AWP-ACT-001)`);
        if (r.state !== known.state || r.status_seq !== known.seq) problem(n, `idempotent resubmission of ${params.action_id} must report its current state ${known.state} at status_seq ${known.seq}, got ${r.state} at ${r.status_seq} (AWP-ACT-001)`);
        return; // no new status_seq
      }
      if (!["pending_approval", "queued", "accepted"].includes(r.state)) problem(n, `first admission of ${params.action_id} reports ${r.state} (AWP-LIF-002)`);
      if (seqArrived(n, r.status_seq, identity("action", r))) transition(n, r.action_id, r.state, undefined, r.status_seq);
      actions.get(r.action_id).content = params;
    }
    if (method === "action.cancel") {
      if (msg.error) { if (msg.error.code === 3008 && actions.has(params.action_id)) problem(n, `AWP_ACTION_UNKNOWN for a known action`); return; }
      const known = actions.get(params.action_id);
      if (!known) return problem(n, `cancel result for unknown action ${params.action_id} (expected AWP_ACTION_UNKNOWN)`);
      if (TERMINAL.has(known.state)) { if (r.state !== known.state || r.status_seq !== known.seq) problem(n, `cancel of terminal ${params.action_id} must report its terminal state`); return; }
      if (seqArrived(n, r.status_seq, identity("action", r))) transition(n, r.action_id, r.state, r.reason, r.status_seq);
    }
    if (method === "action.status" && r) {
      const known = actions.get(params.action_id);
      if (known && (r.state !== known.state || r.status_seq !== known.seq)) problem(n, `status pull reports ${r.state}@${r.status_seq}, current is ${known.state}@${known.seq}`);
    }
  });
  for (const [k, { method }] of pending) problem(lines.length, `request ${k} (${method}) never answered`);
  if (!bad) ok(`trace ${rel(p)} (${lines.length} lines)`);
}

console.log(failures ? `\n${failures} failure(s)` : `\nall checks passed (${schemas.length} schemas, ${tagged} tagged blocks, ${vectors.length} vectors, ${traceFiles.length} traces)`);
process.exit(failures ? 1 : 0);

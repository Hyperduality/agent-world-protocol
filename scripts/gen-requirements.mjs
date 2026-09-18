#!/usr/bin/env node
// Requirement matrix: spec/requirements.yaml is the source of truth for side / applicability /
// gate / test; the normative text and defining page are extracted from spec/**/*.mdx.
//   node scripts/gen-requirements.mjs            write spec/requirements.mdx
//   node scripts/gen-requirements.mjs --check    fail on drift or on inventory mismatches
//   node scripts/gen-requirements.mjs --bootstrap  add heuristic rows for IDs missing from the YAML
// Apache-2.0.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ROOT, walk, rel, emit } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const bootstrap = args.has("--bootstrap");
const YAML_PATH = join(ROOT, "spec", "requirements.yaml");
const OUT_PATH = join(ROOT, "spec", "requirements.mdx");

// ------------------------------------------------------------ extract definitions from the spec
const DEF = /`\[(AWP-[A-Z]+-\d{3})\]`/g;
const defs = new Map(); // id -> { file, route, text, level }
for (const p of walk(join(ROOT, "spec"), (f) => f.endsWith(".mdx"))) {
  const text = readFileSync(p, "utf8");
  const route = "/" + rel(p).replace(/\.mdx$/, "");
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(DEF)) {
      const id = m[1];
      if (defs.has(id)) throw new Error(`${id} defined twice: ${defs.get(id).file} and ${rel(p)}`);
      // Sentence text: strip the ID tag, table pipes, list bullets, and markdown emphasis.
      let t = line.replace(DEF, "").replace(/^\s*[-|]\s*/, "").replace(/\|/g, " ").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
      t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
      const level = /\bMUST NOT\b|\bMUST\b|\bREQUIRED\b|\bSHALL\b/.test(t) ? "MUST" : /\bSHOULD\b/.test(t) ? "SHOULD" : /\bMAY\b|\bOPTIONAL\b/.test(t) ? "MAY" : "MUST";
      defs.set(id, { file: rel(p), route, text: t, level });
    }
  }
}

// ------------------------------------------------------------ every AWP-… mention in the repo must resolve
const REF = /AWP-[A-Z]+-\d{3}(?:\.\.\d{3})?/g;
const dangling = new Set();
for (const p of walk(ROOT, (f) => /\.(mdx|md|json|yaml)$/.test(f) && !f.endsWith("requirements.mdx"))) {
  const text = readFileSync(p, "utf8");
  for (const m of text.matchAll(REF)) {
    const [head, tail] = m[0].split("..");
    const prefix = head.slice(0, head.lastIndexOf("-") + 1);
    const start = Number(head.slice(-3));
    const end = tail ? Number(tail) : start;
    for (let n = start; n <= end; n++) {
      const id = prefix + String(n).padStart(3, "0");
      if (!defs.has(id)) dangling.add(`${id} (${rel(p)})`);
    }
  }
}

// ------------------------------------------------------------ load / bootstrap the YAML
const doc = YAML.parse(readFileSync(YAML_PATH, "utf8")) ?? { requirements: [] };
const rows = new Map((doc.requirements ?? []).map((r) => [r.id, r]));

function heuristic(id, d) {
  const area = id.split("-")[1];
  const n = Number(id.slice(-3));
  let side = "world", applies = "all", gate = "core", test = id;
  if (area === "AGT" || id === "AWP-ERR-001") side = "agent";
  if (["CTL", "DAT", "CLK", "VER", "TRN"].includes(area) || ["AWP-ACT-001", "AWP-OBS-003", "AWP-MOD-002", "AWP-LIF-009", "AWP-SAF-001", "AWP-SAF-002"].includes(id)) side = "both";
  if (area === "TIM" && ((n >= 2 && n <= 4) || n >= 9)) applies = "lockstep";
  if (id === "AWP-SIM-001") applies = "lockstep";
  if ((area === "TIM" && n >= 5 && n <= 7) || area === "CMD" || area === "ROB" || (area === "SAF" && n >= 3)) applies = "streaming";
  if (area === "REP") gate = `capability:${["seed", "snapshot", "replay"][n - 1] ?? "replay"}`;
  if (area === "CMD") gate = "capability:command_channels";
  if (area === "TSK") gate = "capability:task";
  if (area === "SIM") gate = "profile:sim";
  if (area === "GUI") gate = "profile:gui";
  if (area === "AV") gate = "profile:realtime-av";
  if (area === "ROB") gate = "profile:robotics";
  if (area === "ENV") gate = "feature:envelopes declared";
  if (area === "APR") gate = "feature:requires_approval";
  if (area === "SCN") gate = "feature:scene channel offered";
  if (area === "MA") gate = "feature:multiple sessions";
  if (area === "SAF" && n >= 3 && n <= 8) gate = "core (streaming)";
  if (area === "SAF" && n >= 9) gate = "feature:reliable channels";
  if (id === "AWP-SAF-012") { gate = "profile:robotics"; test = "manual: measured watchdog reaction time attached to the report"; }
  if (id === "AWP-SEC-002" || id === "AWP-SEC-003" || id === "AWP-SEC-004") gate = "core (non-loopback)";
  if (d.level === "SHOULD") test = `${id} (warning)`;
  if (d.level === "MAY") test = `${id} (only if implemented)`;
  if (["AWP-APR-005", "AWP-AUD-004", "AWP-CNF-001", "AWP-CNF-002", "AWP-CNF-003", "AWP-CNF-004", "AWP-CNF-005", "AWP-CNF-006", "AWP-VER-005", "AWP-MOD-003"].includes(id)) test = "untestable: process or deployment policy";
  if (["AWP-ENV-003", "AWP-ROB-002", "AWP-ROB-004"].includes(id)) test = "manual: requires physical disturbance and sensor evidence";
  if (id === "AWP-ROB-003") test = "manual: review of claim wording";
  if (id === "AWP-TIM-004" || id === "AWP-REP-001") test = `${id} (two seeded runs compared)`;
  return { id, side, applies, gate, test };
}

let added = 0;
for (const [id, d] of defs) {
  if (!rows.has(id)) {
    if (!bootstrap) continue;
    rows.set(id, heuristic(id, d));
    added++;
  }
}
if (bootstrap) {
  const sorted = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(YAML_PATH, YAML.stringify({ requirements: sorted }, { lineWidth: 0 }));
  console.log(`bootstrap: added ${added} rows (${sorted.length} total)`);
}

// ------------------------------------------------------------ consistency checks
let problems = 0;
for (const id of defs.keys()) if (!rows.has(id)) { console.error(`MISSING in requirements.yaml: ${id} (${defs.get(id).file})`); problems++; }
for (const id of rows.keys()) if (!defs.has(id)) { console.error(`STALE in requirements.yaml: ${id} is not defined in spec/`); problems++; }
for (const d of dangling) { console.error(`DANGLING reference: ${d}`); problems++; }
const SIDES = new Set(["world", "agent", "both"]), APPLIES = new Set(["all", "lockstep", "streaming"]);
for (const r of rows.values()) {
  if (!SIDES.has(r.side)) { console.error(`${r.id}: bad side ${r.side}`); problems++; }
  if (!APPLIES.has(r.applies)) { console.error(`${r.id}: bad applies ${r.applies}`); problems++; }
  if (!r.gate || !r.test) { console.error(`${r.id}: gate and test are required`); problems++; }
}
// Claimable profiles must not contain a MUST with no test at all.
for (const r of rows.values()) {
  const d = defs.get(r.id);
  if (d && d.level === "MUST" && /^untestable/.test(r.test) && !/^AWP-(CNF|VER|MOD|APR-005|AUD-004)/.test(r.id)) {
    console.error(`${r.id}: MUST marked untestable outside process/policy areas`); problems++;
  }
}

// ------------------------------------------------------------ render
const AREA_NAMES = {
  ACT: "Actions", AGM: "Agent manifest", AGT: "Core agent", APR: "Approval", AUD: "Audit log", AV: "Realtime A/V profile",
  CLK: "Timestamps and clocks", CMD: "Command channels", CNF: "Conformance", CTL: "Control plane", DAT: "Data plane",
  EMB: "Embodiments", ENV: "Envelopes", ERR: "Errors", EVT: "Events", GUI: "GUI profile", LIF: "Action lifecycle",
  MA: "Multi-agent", MAN: "World manifest", MOD: "Modalities", NEG: "Negotiation", OBS: "Observations", PRE: "Preemption",
  PRM: "Permissions", REP: "Reproducibility", ROB: "Robotics profile", SAF: "Liveness and safe state", SCN: "Scene graphs",
  SEC: "Security", SES: "Session lifecycle", SIM: "Sim profile", TIM: "Time models", TRN: "Transport", TSK: "Task",
  UNI: "Units and frames", VER: "Versioning",
};
const esc = (s) => s.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
const short = (s) => (s.length > 150 ? s.slice(0, 147).replace(/\s+\S*$/, "") + "…" : s);

const byArea = new Map();
for (const r of [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  const area = r.id.split("-")[1];
  if (!byArea.has(area)) byArea.set(area, []);
  byArea.get(area).push(r);
}
const counts = { world: 0, agent: 0, both: 0, MUST: 0, SHOULD: 0, MAY: 0, manual: 0, untestable: 0 };
for (const r of rows.values()) {
  counts[r.side]++;
  counts[defs.get(r.id)?.level ?? "MUST"]++;
  if (/^manual/.test(r.test)) counts.manual++;
  if (/^untestable/.test(r.test)) counts.untestable++;
}

let out = `---
title: "Requirement matrix"
description: "Every normative requirement with its side, applicability, feature gate, and test."
---

{/* GENERATED by scripts/gen-requirements.mjs from spec/requirements.yaml and the bracketed IDs in spec/**. Do not edit by hand. */}

<Note>
${rows.size} requirements: ${counts.world} world-side, ${counts.agent} agent-side, ${counts.both} both. ${counts.MUST} MUST, ${counts.SHOULD} SHOULD, ${counts.MAY} MAY. ${counts.manual} require manual evidence; ${counts.untestable} are process or deployment policy and are not tested by the suite. CI fails if a bracketed ID in the specification has no row here, or a row names an ID the specification no longer defines.
</Note>

**Columns.** *Side*: who must implement it. *Applies*: time model(s) it applies to. *Gate*: \`core\` (every conformant implementation), \`core (streaming)\` / \`core (non-loopback)\` (Core when that mode is offered), \`profile:<name>\`, \`capability:<key>\` (only when the manifest advertises the key, AWP-VER-007), or \`feature:<condition>\`. *Test*: the conformance-suite assertion (named after the ID, AWP-CNF-004), \`(warning)\` for SHOULD, \`manual:\` for evidence attached to the report, \`untestable:\` for process rules.

`;
for (const [area, list] of byArea) {
  const first = defs.get(list[0].id);
  out += `## ${AREA_NAMES[area] ?? area} — \`AWP-${area}\`\n\nDefined in [${first.route}](${first.route}).\n\n| ID | Level | Side | Applies | Gate | Test | Requirement |\n|---|---|---|---|---|---|---|\n`;
  for (const r of list) {
    const d = defs.get(r.id);
    out += `| [${r.id}](${d.route}) | ${d.level} | ${r.side} | ${r.applies} | \`${esc(r.gate)}\` | ${esc(r.test)} | ${esc(short(d.text))} |\n`;
  }
  out += "\n";
}

const wrote = emit(OUT_PATH, out, check);
if (problems) console.error(`\n${problems} inventory problem(s)`);
else console.log(`inventory ok: ${defs.size} IDs defined, ${rows.size} rows, no dangling references`);
process.exit(problems || !wrote ? 1 : 0);

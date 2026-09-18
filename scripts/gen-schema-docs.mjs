#!/usr/bin/env node
// Renders api-reference/schemas/<name>.mdx from schemas/v0.1/<name>.schema.json.
// `--check` fails on drift instead of writing. Apache-2.0.
import { join } from "node:path";
import { ROOT, loadSchemas, emit } from "./lib.mjs";

const check = process.argv.includes("--check");

// Which schemas get a reference page, and the page metadata.
const PAGES = {
  "world-manifest": { title: "world-manifest.schema.json", description: "Canonical schema for the world manifest.", spec: "/spec/session/world-manifest" },
  "agent-manifest": { title: "agent-manifest.schema.json", description: "Canonical schema for the agent manifest (initialize params).", spec: "/spec/session/agent-manifest" },
  "embodiment": { title: "embodiment.schema.json", description: "Canonical schema for embodiment declarations.", spec: "/spec/session/embodiments" },
  "action-schema": { title: "action-schema.schema.json", description: "Canonical schema for action type declarations.", spec: "/spec/loop/actions" },
  "observation-channel": { title: "observation-channel.schema.json", description: "Canonical schema for channel declarations (observation and command channels).", spec: "/spec/loop/observations" },
  "safety-policy": { title: "safety-policy.schema.json", description: "Canonical schema for the world safety policy.", spec: "/spec/safety/envelopes" },
  "frame-tree": { title: "frame-tree.schema.json", description: "Canonical schema for named coordinate frames.", spec: "/spec/semantics/units-and-frames" },
  "session-open": { title: "session-open.schema.json", description: "Canonical schema for session.open params.", spec: "/spec/session/negotiation" },
  "session-ready": { title: "session-ready.schema.json", description: "Canonical schema for session.ready (result of session.open / session.resume).", spec: "/spec/session/negotiation" },
  "action-submit": { title: "action-submit.schema.json", description: "Canonical schema for action.submit params.", spec: "/spec/loop/actions" },
  "action-status": { title: "action-status.schema.json", description: "Canonical schema for action.status notifications.", spec: "/spec/loop/action-lifecycle" },
  "frame-inline": { title: "frame-inline.schema.json", description: "Canonical schema for obs.frame / cmd.frame params in the inline binding.", spec: "/spec/transport/data-plane" },
  "world-event": { title: "world-event.schema.json", description: "Canonical schema for world.event notifications.", spec: "/spec/loop/events-and-errors" },
  "telemetry-payload": { title: "telemetry-payload.schema.json", description: "Canonical schema for awp.telemetry frame payloads.", spec: "/spec/loop/time-models" },
  "error": { title: "error.schema.json", description: "Canonical schema for JSON-RPC error objects with AWP data.", spec: "/spec/loop/events-and-errors" },
  "common": { title: "common.schema.json", description: "Shared primitives: bounded integers, timestamps, pose, task, status reasons.", spec: "/spec/semantics/units-and-frames" },
};

const schemas = Object.fromEntries(loadSchemas().map((s) => [s.name, s.schema]));

function typeOf(prop) {
  if (!prop || typeof prop !== "object") return "any";
  if (prop.$ref) {
    const m = prop.$ref.match(/^([a-z-]+)\.schema\.json(?:#\/\$defs\/([A-Za-z0-9_]+))?$/) || prop.$ref.match(/^#\/\$defs\/([A-Za-z0-9_]+)$/);
    if (m) return m[2] ?? m[1];
    if (prop.$ref.includes("json-schema.org")) return "JSON Schema";
    return "ref";
  }
  if (prop.enum) return prop.enum.map(String).join(" | ");
  if (prop.const !== undefined) return String(prop.const);
  if (prop.oneOf || prop.anyOf) return (prop.oneOf || prop.anyOf).map(typeOf).join(" | ");
  if (Array.isArray(prop.type)) return prop.type.join(" | ");
  if (prop.type === "array") return `${typeOf(prop.items)}[]`;
  return prop.type ?? "object";
}

function esc(s = "") {
  return String(s).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;").replace(/</g, "&lt;");
}

function renderProps(schema, required = [], indent = "") {
  const props = schema.properties ?? {};
  const req = new Set(schema.required ?? required);
  let out = "";
  for (const [name, prop] of Object.entries(props)) {
    const t = typeOf(prop);
    const desc = [prop.description, prop.default !== undefined ? `Default \`${JSON.stringify(prop.default)}\`.` : null].filter(Boolean).join(" ");
    const nested = prop.type === "object" && prop.properties ? prop : prop.type === "array" && prop.items?.properties ? prop.items : null;
    const open = `${indent}<ResponseField name="${name}" type="${t.replace(/"/g, "'")}"${req.has(name) ? " required" : ""}>`;
    if (nested) {
      // MDX needs blank lines between markdown text and nested JSX inside a component.
      out += `${open}\n${indent}  ${esc(desc)}\n\n${indent}  <Expandable title="fields">\n${renderProps(nested, [], indent + "    ")}${indent}  </Expandable>\n${indent}</ResponseField>\n`;
    } else {
      out += `${open}${esc(desc) || " "}</ResponseField>\n`;
    }
  }
  return out;
}

function renderDefs(schema) {
  const defs = schema.$defs ?? {};
  let out = "";
  for (const [name, def] of Object.entries(defs)) {
    out += `\n### \`${name}\`\n\n${esc(def.description ?? "")}\n\n`;
    if (def.properties) out += renderProps(def);
    else out += `Type: \`${typeOf(def)}\`${def.minimum !== undefined ? `, minimum ${def.minimum}` : ""}${def.maximum !== undefined ? `, maximum ${def.maximum}` : ""}${def.pattern ? `, pattern \`${def.pattern}\`` : ""}\n`;
  }
  return out;
}

let allOk = true;
for (const [name, meta] of Object.entries(PAGES)) {
  const schema = schemas[name];
  if (!schema) { console.error(`no schema for page ${name}`); allOk = false; continue; }
  const src = `https://github.com/Hyperduality/agent-world-protocol/blob/main/schemas/v0.1/${name}.schema.json`;
  let body = `---\ntitle: "${meta.title}"\ndescription: "${meta.description}"\n---\n\n`;
  body += `{/* GENERATED by scripts/gen-schema-docs.mjs from schemas/v0.1/${name}.schema.json — do not edit by hand. */}\n\n`;
  body += `<Note>Generated from [\`schemas/v0.1/${name}.schema.json\`](${src}) (\`$id\`: \`${schema.$id}\`). Normative text: [${meta.spec}](${meta.spec}). Every tagged example on this site is validated against this schema in CI.</Note>\n\n`;
  if (schema.description) body += `${esc(schema.description)}\n\n`;
  if (schema.properties) body += renderProps(schema);
  if (schema.$defs && Object.keys(schema.$defs).length) body += `\n## Definitions\n${renderDefs(schema)}`;
  if (schema.allOf?.length) {
    body += `\n## Conditional rules\n\n\`\`\`json\n${JSON.stringify(schema.allOf, null, 2)}\n\`\`\`\n`;
  }
  allOk = emit(join(ROOT, "api-reference", "schemas", `${name}.mdx`), body, check) && allOk;
}

process.exit(allOk ? 0 : 1);

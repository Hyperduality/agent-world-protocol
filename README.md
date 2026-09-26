# Agent World Protocol

An open protocol for how AI agents perceive and act in worlds — virtual or physical.

This repository is the public documentation and v0.1 draft specification for **[www.agentworldprotocol.com](https://www.agentworldprotocol.com)**, built with [Mintlify](https://mintlify.com).

## Local preview

```bash
npm i -g mint
mint dev            # http://localhost:3000
mint broken-links   # link check
```

## Layout

- `docs.json` (nav/theme) · `*.mdx` pages per tab (Documentation, Specification, API Reference, SDKs & Adapters, Community) · `logo/`, `images/`, `snippets/`.
- `schemas/v0.1/*.schema.json` — canonical JSON Schemas (Apache-2.0); `schemas/test-vectors/frames.json` — frame test vectors; `examples/v0.1/traces/*.jsonl` — complete wire traces, rendered at `spec/wire-traces`.
- `examples/v0.1/*.json` — complete instances validated against the schemas.
- `generated/awp-v0.1.d.ts` — TypeScript types generated from the schemas.
- `spec/requirements.yaml` → `spec/requirements.mdx` — the requirement matrix (side, applicability, gate, test) for every `AWP-*` ID.
- `scripts/` — `validate.mjs`, `gen-schema-docs.mjs`, `gen-types.mjs`, `gen-requirements.mjs`, and the reference `frame-codec.mjs`.
- `rfds/0000-template.md` — the RFD template.

## Checks

```bash
npm install
npm run check   # schemas, examples, tagged doc blocks, frame vectors, generated-file drift
npm run gen     # regenerate api-reference/schemas/*.mdx, generated/, spec/requirements.mdx
```

`npm run check` validates tagged JSON blocks in the docs (```` ```json awp:<schema> ````); untagged blocks are illustrative fragments.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community standards.

## License

Specification and documentation text is licensed [CC-BY 4.0](LICENSE-CC-BY-4.0). Schemas and reference code are licensed [Apache-2.0](LICENSE-APACHE). See [LICENSE](LICENSE).

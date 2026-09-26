# AGENTS.md

The Agent World Protocol specification and its documentation site (Mintlify). Normative text lives in `spec/`, the canonical schemas in `schemas/v0.1/`, and the requirement matrix in `spec/requirements.yaml`.

## Checks

```bash
npm ci
npm run check        # schemas, examples, tagged doc blocks, frame vectors, traces, generated-file drift
npm run gen          # regenerate the generated files after changing a schema, the matrix, or a trace
npx mint broken-links
```

CI runs both on every pull request. Never edit generated files by hand: `api-reference/schemas/*.mdx`, `generated/awp-v0.1.d.ts`, `spec/requirements.mdx`, and `spec/wire-traces.mdx`.

## Writing

- Normative sentences use RFC 2119 capitals and end with their requirement ID in brackets, `[AWP-XXX-NNN]`. Every bracketed ID needs a row in `spec/requirements.yaml`, and IDs are never reused.
- Say a thing once, where it belongs, and link to it elsewhere.
- Leave out what a human editor would cut: status disclaimers ("not published yet", "planned"), notes about CI or tooling on reader-facing pages, signposting ("this page…"), justifications nobody asked for, and summaries of what was just said.
- Cite requirement IDs in the specification and API reference. Elsewhere, cite one only when a reader would look it up.
- Pages on implementations (SDKs, awp-sim, the suite, the registry) state what exists today, and their claims use the suite's exact wording.

## Commits and pull requests

- Branch from `main` and open a pull request. Merge once CI passes.
- Write the title as one plain sentence in sentence case, with no trailing period, saying what changed: `Specify standing approvals`, `The TypeScript SDK is on npm as @hyperduality/awp`. Put the draft revision in parentheses when the change belongs to one: `(0.1-draft.9)`.
- Add a body only when the title can't carry the reason: one or two short sentences.
- Write commits the way a person on the project would. No `Co-Authored-By` trailers, no "Generated with" lines, and no other mention of AI tools, in commits or in PRs.
- The PR title matches the commit title, and the description is a few lines at most.

## Draft revisions

A wire-visible change ships as a new draft revision, `0.1-draft.N`:

1. Add an `<Update>` entry at the top of `community/changelog.mdx`, dated, listing the wire-visible changes, then any clarifications.
2. Name the new revision in `spec/index.mdx`.
3. After the merge, tag the merge commit with an annotated tag: `git tag -a spec-v0.1-draft.N -m "0.1-draft.N"`, then `git push origin spec-v0.1-draft.N`.

The implementations (awp-python, awp-sim, awp-typescript, awp-conformance) pin a revision tag and move to a new one in their own releases. Editorial fixes need no new revision.

## Deploying

The site deploys from `main`, so merging a pull request publishes it. There is no other release step.

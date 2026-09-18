# RFD-NNNN: Title

- **Status:** draft | review | accepted | stabilized | declined
- **Author(s):** name
- **Discussion:** link to the GitHub discussion
- **Target release:** MINOR or MAJOR version

## Problem

What cannot be done, or is done inconsistently, with the current specification. Cite the pages and requirement IDs involved.

## Proposal

The change in normative terms. Use RFC 2119 language. Include message shapes as complete, valid JSON examples; reference or add JSON Schemas under `schemas/`.

## Compatibility

- Wire-visible? (yes: MAJOR; additive only: MINOR)
- Capability key gating the feature (AWP-VER-007), if any
- Behavior of implementations that do not support the change

## Requirement IDs

- New: `AWP-XXX-NNN`, one line each
- Modified: `AWP-XXX-NNN`, before / after
- Removed: `AWP-XXX-NNN`; IDs are never reused

## Conformance

For every new or modified MUST: side (world / agent), applicability (all / lockstep / streaming), feature gate, and the assertion that tests it (or `manual` / `untestable` with justification). These rows are added to `spec/requirements.yaml` at stabilization.

## Alternatives considered

## Open questions

---
name: api-governance
description: Use before merging or shipping any API or tool-contract change. Runs CodeRifts preflight on OpenAPI specs and MCP manifests to detect breaking changes and return an ALLOW/WARN/REQUIRE_APPROVAL/BLOCK decision (authorize mode). Trigger when a PR touches an API spec, when endpoints or fields are renamed, removed, or made required, or when an MCP or agent tool schema changes.
---

# CodeRifts API Governance

CodeRifts checks API and tool-contract changes for safety before they reach production. Use it when a change could break consumers or agent tool calling — not for documentation-only edits with no contract content change.

## When to use

- A pull request modifies an OpenAPI/Swagger, GraphQL, gRPC, AsyncAPI, or MCP manifest.
- Endpoints or fields are renamed, removed, or made required.
- Request/response schemas, status codes, or auth scopes change.
- An agent tool schema changes or tools are re-registered.
- You hold a prior receipt and need to verify it before merge/deploy.
- You need details of a past decision by `decision_id` or fingerprint.

## Tools

The coderifts MCP server (`https://app.coderifts.com/mcp`) exposes **exactly three** tools
(live `tools/list` — do not invent others):

- **preflight_change_set** — Preflight a complete base→head change set of contract
  artifacts and return risk score and breaking-change analysis. On the **authorize**
  path only: a governance decision (ALLOW / WARN / REQUIRE_APPROVAL / BLOCK) and a
  signed chain-receipt when applicable. **Analyze** returns informational risk only
  (`analysis_outcome`, `may_execute: false`, no decision, no receipt). Requires a
  pending base→head contract change and full before/after for every changed artifact.
  Required inputs: `artifacts`, `preflight_mode`. Authorize needs `context.operation`
  (`merge` | `deploy` | `publish` | `tool_call`). Do not use when you only need to
  verify an existing receipt (`verify_receipt`) or look up a past decision
  (`get_decision_details`).

- **verify_receipt** — Verify a CodeRifts signed chain-receipt you **already hold**:
  cryptographic authenticity (signature + key id), body binding, and — when lifecycle
  indices are available — whether it is currently valid authorization (not expired,
  superseded, or revoked) for a stated operation/target. Required: `token`. Optional:
  `operation`, `target_id`, `environment`, `fingerprint`, `audience`, `decision_result`.
  Branch on `currently_authorized` (bool or null when not evaluated). Does **not**
  re-diff specs or re-issue a decision.

- **get_decision_details** — Retrieve a **past** CodeRifts decision by `decision_id`
  (preferred) or `fingerprint`: full report payload, breaking changes, scores, and
  linked receipt metadata if stored. For explaining or auditing a prior ALLOW/WARN/BLOCK
  — not for a new analysis of the current change set (use `preflight_change_set`).

## Decision protocol

On **authorize** preflight, branch on `execution_action` when present
(CONTINUE / CONTINUE_WITH_MONITORING / REQUEST_APPROVAL / STOP); use `decision` as
explanation. Unrecognized `execution_action` is not permission. On REQUIRE_APPROVAL or
BLOCK, surface patterns/breaking details and prefer safer paths (additive change,
deprecate-then-remove, versioning).

**Analyze** mode is informational only — no decision vocabulary, no receipt.

## Setup

Set `CODERIFTS_API_KEY` (https://coderifts.com). Discovery (`initialize`, `tools/list`)
works without a key; tool calls that require auth need the Bearer key.

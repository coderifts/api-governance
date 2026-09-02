---
name: coderifts-api-governance
description: "Governs API-contract changes before they ship. Use when about to merge, deploy, publish, or register/expose agent tools AND the change touches a contract artifact (OpenAPI/Swagger, GraphQL SDL, gRPC/protobuf, AsyncAPI, MCP manifest, or agent tool schemas): get a decision (ALLOW/WARN/REQUIRE_APPROVAL/BLOCK) with a risk score and a signed receipt, verify a receipt you already hold, or look up a past decision. Also use to tell 'the signature is valid' apart from 'this receipt authorizes THIS action right now'. Retrieval-first: fetch the current Decision Spec and schemas instead of relying on pre-trained knowledge."
---

# CodeRifts API governance

Before quoting field names, enums, thresholds, or response shapes, retrieve the current contract from
the [Decision Spec](https://coderifts.com/decision-spec/) and the
[decision-result consumer schema](https://coderifts.com/schemas/decision-result.v1.consumer.json).
The schemas are the source of truth; this file tells you when and how to call.

## When to load this skill

Load it when **all** of the following hold:

1. You are about to **merge, push, deploy, publish, or register/expose agent tools**.
2. The change includes **at least one contract artifact**: `openapi`, `graphql`, `grpc`, `asyncapi`,
   `mcp_manifest`, or `agent_tools`.
3. You can supply **both `before` and `after`** for every changed artifact in the set.

Do **not** load it for documentation-only changes, or when you merely want to re-check a receipt you
already hold (that is one specific call, below, not a governance run).

## Two modes — the distinction that matters

`preflight_mode` is **required**. Passing the wrong one is the most common integration error.

| Mode | What you get | What it is NOT |
|---|---|---|
| `analyze` | `analysis_outcome`, `may_execute: false`, risk fields | **Not permission.** No `decision`, no `execution_action`, no `safe_for_agent`, no receipt. |
| `authorize` | `decision`, `execution_action`, `safe_for_agent`, and a signed `chain_receipt` when issued | Requires `context.operation` (`merge` \| `deploy` \| `publish` \| `tool_call`). |

An `analyze` response never authorizes anything. If you are going to act, call `authorize`.

## How to branch

Branch on **`execution_action`** — a closed set:

- `CONTINUE` — proceed.
- `CONTINUE_WITH_MONITORING` — proceed only if you actually have a monitoring sink wired; otherwise treat as a halt.
- `REQUEST_APPROVAL` — stop and get a human.
- `STOP` — stop this attempt; remediate and request a **new** decision.

Rules that are not optional:

- An **unrecognised** `execution_action` is **not permission** — fail closed.
- Do **not** branch on `safe_for_agent`. It exists for legacy dashboards.
- Unknown additive fields are not permission either; tolerate them and ignore them for control flow.
- A known continue-valued `execution_action` is a **necessary** condition, never a **sufficient** one.
  You may add your own conjunctive checks and halt where the contract would permit execution.

## Calling it

### MCP (no auth)

Server: `https://app.coderifts.com/mcp` — the server card declares
`"authentication": { "required": false }`, so connect and call directly. Three tools:

- **`preflight_change_set`** — required: `artifacts`, `preflight_mode`. The governance run.
- **`verify_receipt`** — required: `token`. Signature/lifecycle check of a receipt you hold.
- **`get_decision_details`** — `decision_id` and/or `fingerprint` (at least one). Past decision lookup.

Server card: <https://coderifts.com/.well-known/mcp/server-card.json>
Manifest: <https://coderifts.com/mcp.json>

### REST

| Purpose | Endpoint |
|---|---|
| Change-set governance (metered) | `POST https://app.coderifts.com/api/v1/preflight` |
| Agent tool preflight | `POST https://app.coderifts.com/api/v1/agent/preflight` |
| Verify a receipt (public) | `POST https://app.coderifts.com/api/v1/verify-receipt` |
| Look up a past decision | `POST https://app.coderifts.com/api/v1/decisions/lookup` |
| Raw contract diff | `POST https://app.coderifts.com/api/v1/diff` |
| Instability scan | `POST https://app.coderifts.com/api/v1/instability-scan` |
| Agent-readiness score | `POST https://app.coderifts.com/api/v1/agent-readiness-score` |
| Policy simulation | `POST https://app.coderifts.com/api/v1/policy-simulator` |

Auth: `X-API-Key: <key>` or `Authorization: Bearer <key>`. Sign up at
<https://app.coderifts.com/api/signup>. Full auth notes: <https://coderifts.com/auth.md>.

### The public pre-screen is a different thing

`POST https://app.coderifts.com/api/v1/public/preflight` needs no key, but its scope is a
**single-spec hallucination and quality pre-screen** returning ALLOW/WARN only — no
`execution_action`, no receipt gate. Do **not** use it as a merge/deploy gate. For change-set
governance use `/api/v1/preflight` with `artifacts[]`.

### SDKs

- TypeScript: `@coderifts/sdk` — `authorizeChangeSet({ artifacts, context })` /
  `analyzeChangeSet(...)` return already-narrowed types per mode.
- Python: `coderifts-sdk` — `authorize_change_set(artifacts=..., context=...)`.
- Runtime gate: `@coderifts/agent-guard` wraps a tool table so mutating tools cannot run without an
  authorize preflight. This is the load-bearing runtime enforcement — the server cannot observe it.

## Receipts: valid ≠ authorized

`verify_receipt` returns both, and they answer different questions:

- **`valid`** — the signature and integrity check out.
- **`currently_authorized`** — this receipt authorizes the operation/target you named, right now.
  `true` / `false` are answers; **`null` means it could not be evaluated** — neither authorized nor
  unauthorized. Treat `null` as not authorized.

Supply intent (`operation`, `environment`, `fingerprint`, `target_id`) plus the `decision_result`
envelope to get a meaningful authorization verdict; a bare token yields a signature verdict only.

A receipt scoped to a different operation or target does not authorize the act you are about to
perform — re-run `preflight_change_set` for the intended operation instead of reusing it.

## What this does not tell you

- Ordering: building the mutation only after the verdict closes eager-execution ordering.
  Snapshot-to-commit correspondence still requires a **host conditional write**
  (compare-and-swap on a version token) — the guard never writes and cannot verify a CAS occurred.
- Merge enforcement depends on the repository's branch protection, not on any preflight response.

Versions you may meet elsewhere: `cr.exec.v2` is the issued-token version for atomic execution, and `ENFORCING_STRICT_V1` is the versioned spelling of the strict profile. Neither is the default and neither is required by these rules — see `docs/grant-versions.md`.

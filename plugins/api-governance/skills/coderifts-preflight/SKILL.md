---
name: coderifts-preflight
description: Before merging, deploying, publishing, or registering a contract artifact change, call the CodeRifts MCP tool preflight_change_set and branch only on execution_action. Do not invent a local preflight.
---

# CodeRifts preflight

This skill does **not** decide. It tells you **when to call the hosted server**.

MCP: `https://app.coderifts.com/mcp`  
Tools (exactly three): `preflight_change_set`, `verify_receipt`, `get_decision_details`.

## When to use

You are about to merge, deploy, publish, or register/expose agent tools **and** the change includes a contract artifact (OpenAPI/Swagger, GraphQL, gRPC/protobuf, AsyncAPI, MCP manifest, or agent tool schemas).

Do **not** use for documentation-only changes.

## What to call

1. `preflight_change_set` with the complete base→head change set (`artifacts[]` with full before and after) and `preflight_mode: authorize` when you will act. `analyze` is informational only (`may_execute` is always false).
2. Branch **only** on `execution_action`: `CONTINUE`, `CONTINUE_WITH_MONITORING`, `REQUEST_APPROVAL`, `STOP`. An unrecognised value is not permission — fail closed.
3. If you already hold a receipt and need authenticity/lifecycle: `verify_receipt` (`token` required). That does not replace preflight for a new change set.
4. A past decision by id: `get_decision_details`.

Do not duplicate scoring, diff, or policy locally. Do not branch on `decision` or `safe_for_agent`.

Auth: discovery works without a key; tool calls that require auth need `Authorization: Bearer <CODERIFTS_API_KEY>` (https://coderifts.com).

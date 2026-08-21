# CodeRifts API Governance — Cursor plugin

Deterministic, signed, fail-closed API-contract governance for Cursor. This is **not** an AI compatibility scan: the hosted MCP returns a closed `execution_action` set and may mint an Ed25519 chain-receipt. Unrecognised actions fail closed.

Exactly three tools: `preflight_change_set`, `verify_receipt`, `get_decision_details`.

## Contents

| Component | Path |
|-----------|------|
| Manifest | `.cursor-plugin/plugin.json` |
| Skill | `skills/coderifts-api-governance/SKILL.md` |
| Rule | `rules/coderifts.mdc` (generated; ID846) |
| MCP | `mcp.json` → `https://app.coderifts.com/mcp` |
| Hook | `hooks/hooks.json` → `npx coderifts claude-hook` (ID912) |

Set `CODERIFTS_API_KEY` in Cursor (**Plugins → Configure**). Discovery works without a key; tool calls that require auth need the Bearer token.

## Local test (before marketplace publish)

Cursor does not install from a private path until you load the plugin directory. From a clone of this repo:

1. In Cursor, add this folder as a local plugin (symlink is fine **for local load**):
   `plugins/api-governance-cursor`
2. Confirm the skill, rule, MCP server `coderifts`, and PreToolUse hook are visible.
3. Call `preflight_change_set` against a real OpenAPI before/after pair. Branch on `execution_action` only.

Do not publish until that client test passes. Submit at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish) against the public repo `https://github.com/coderifts/api-governance` (open-source; Cursor review).

## Validate

```bash
node scripts/validate-cursor-plugin.js
```

# Cursor plugin — provenance

This directory is the **Cursor Plugin** package (manifest at `.cursor-plugin/plugin.json`).
Do not hand-edit vendored generated files.

| Path | Role | Source of truth |
|------|------|-----------------|
| `.cursor-plugin/plugin.json` | Cursor Plugin manifest (this package) | [Cursor plugin schema](https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json) |
| `skills/coderifts-api-governance/SKILL.md` | Agent skill | `coderifts-website/.well-known/agent-skills/coderifts-api-governance/SKILL.md` |
| `rules/coderifts.mdc` | Cursor rule | **Generated** — `coderifts-app/scripts/generate-agent-host-files.js` → `generated/agent-host/.cursor/rules/coderifts.mdc` |
| `mcp.json` | Cursor MCP wiring (`mcpServers`) | Same hosted endpoint as Claude `.mcp.json` (`https://app.coderifts.com/mcp`). **Not** the website tool-card `coderifts-website/mcp.json`. |
| `hooks/hooks.json` | Cursor PreToolUse adapter | Existing CLI `coderifts claude-hook` (ID912 STRICT lives in that command; default remains soft) |
| `LICENSE` | SPDX MIT | Repo-root `LICENSE` (in-repo symlink) |
| `assets/logo.png` | Marketplace logo | `plugins/api-governance-openai/assets/logo.png` (in-repo symlink) |

**Why copies for SKILL + rules (not cross-repo symlinks):** GitHub clones of this public repo cannot resolve paths into `~/coderifts-website` or `~/coderifts-app`. In-repo relative symlinks (LICENSE, logo) are safe. Vendored copies need the drift-gate below.

**Re-sync + check** (from this repo root; needs local app + website checkouts):

```bash
node scripts/validate-cursor-plugin.js
```

Canonical tools only: `preflight_change_set`, `verify_receipt`, `get_decision_details`.

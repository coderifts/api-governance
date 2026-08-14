# Copilot kit — provenance

Vendored **reference copies** of CodeRifts GitHub Copilot configs. Do not hand-edit
the GENERATED files in this directory.

| File | Generator (coderifts-app) | In-app artifact |
|------|---------------------------|-----------------|
| `.vscode/mcp.json` | `scripts/generate-copilot-mcp.js` | `generated/copilot-mcp/.vscode/mcp.json` |
| `copilot-cloud-agent-mcp.json` | same | `generated/copilot-mcp/copilot-cloud-agent-mcp.json` |
| `copilot-custom-agent-mcp.frontmatter.md` | same | `generated/copilot-mcp/copilot-custom-agent-mcp.frontmatter.md` |
| `docs/copilot-mcp.md` | same | `generated/copilot-mcp/docs/copilot-mcp.md` |
| `.github/copilot-instructions.md` | `scripts/generate-agent-host-files.js` | `generated/agent-host/.github/copilot-instructions.md` |

**Primary install path (living command):**

```bash
npx coderifts copilot-setup
# optional: --out <dir>  --check  --force
```

CLI also writes agent-host rules via `npx coderifts agent-setup` (includes
`.github/copilot-instructions.md`).

**Re-sync vendored copies** (from a current coderifts-app checkout):

```bash
node "$CODERIFTS_APP_ROOT/scripts/generate-copilot-mcp.js" --check
node "$CODERIFTS_APP_ROOT/scripts/generate-agent-host-files.js" --check
# then copy generated/* into this kit (or re-run the packaging step)
node scripts/validate-copilot-kit.js
```

Canonical tools only: `preflight_change_set`, `verify_receipt`, `get_decision_details`.

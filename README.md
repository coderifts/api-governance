# CodeRifts — API Governance

**Risk-aware API compatibility governance for AI agents and CI.** Before a change merges, CodeRifts predicts whether it will cause a real production problem, who breaks, by what pattern, at what business cost, and whether blocking is justified.

The market shows you *what* changed. CodeRifts tells you *how dangerous it is, who it affects, when deployment should be blocked, and how much it will cost.*

- Hosted MCP server: `https://app.coderifts.com/mcp`
- Manifest: `https://coderifts.com/mcp.json`
- Official MCP Registry: `io.github.coderifts/api-governance`
- Website: `https://coderifts.com`
- Live demo PR: `https://github.com/coderifts/demo/pull/4`

---

## Claude Code plugin

Install the CodeRifts marketplace, then the `api-governance` plugin (MCP server + skill).
Requires `CODERIFTS_API_KEY` for tool calls.

```text
/plugin marketplace add coderifts/api-governance
/plugin install api-governance@coderifts
```

Local checkout (after clone):

```text
/plugin marketplace add .
/plugin install api-governance@coderifts
```

The plugin wires the hosted MCP at `https://app.coderifts.com/mcp` and the
`api-governance` skill. Tools exposed: `preflight_change_set`, `verify_receipt`,
`get_decision_details` only.

---

## OpenAI / Codex package

Codex plugin package (measured OpenAI Codex layout: `.codex-plugin/plugin.json` +
`.mcp.json` + `skills/` + `AGENTS.md`). Same hosted MCP and the **same three tools**
as the Claude plugin — no fourth tool.

| Path | Role | Source of truth |
|------|------|-----------------|
| `plugins/api-governance-openai/.codex-plugin/plugin.json` | Codex plugin manifest | Codex `plugin-json-spec` (scaffold skill) |
| `plugins/api-governance-openai/.mcp.json` | Streamable HTTP MCP wiring | Same endpoint as Claude `.mcp.json` |
| `plugins/api-governance-openai/skills/api-governance/SKILL.md` | Skill + tool list | Trigger wording from agent-setup rule; tool names/descriptions from generated `mcp.json` |
| `plugins/api-governance-openai/AGENTS.md` | Agent rules file | **Generated** — `coderifts agent-setup` / `generate-agent-host-files.js` |
| `plugins/api-governance-openai/openai-agent-instructions.md` | OpenAI Agents SDK instructions | **Generated** — same generator |
| `.agents/plugins/marketplace.json` | Codex marketplace entry | Codex marketplace schema |

Local checkout in Codex (team marketplace path):

```text
# From a clone of this repo, point Codex at .agents/plugins/marketplace.json
# then install api-governance-openai (UI / plugin install — see Codex plugin docs).
```

Validate package consistency (manifest, tool parity, AGENTS.md empty-diff vs regeneration):

```bash
node scripts/validate-openai-package.js
```

Requires a local `~/coderifts-app` checkout (or `CODERIFTS_APP_ROOT`) for the AGENTS.md
regeneration check. Directory listing / account submission steps are **not** automated here.

---

## GitHub Copilot kit

Reference copies of the **generated** Copilot MCP configs + instructions (single source:
`coderifts-app` generators). Same hosted MCP and the **same three tools** — no fourth tool.

**Primary install (living command — prefer this over copying from the kit):**

```bash
npx coderifts copilot-setup
# optional: --out <dir>   --check (drift-gate)   --force
```

Agent-host instructions (including `.github/copilot-instructions.md`) come from:

```bash
npx coderifts agent-setup
```

### Three Copilot surfaces (root keys differ)

From the generated guide (`copilot/docs/copilot-mcp.md` — do not re-author this table):

| Surface | Config location | Root key | Auth |
|---------|-----------------|----------|------|
| **VS Code / Copilot Chat** | `.vscode/mcp.json` | **`servers`** | `${input:coderifts_api_key}` + `inputs[]` |
| **Copilot cloud agent + code review** | Repo **Settings → Copilot → MCP servers** (paste JSON) | **`mcpServers`** | Agents secret `COPILOT_MCP_CODERIFTS_API_KEY` in `headers` |
| **Custom agent** (org/enterprise) | Agent profile `.md` YAML frontmatter | **`mcp-servers`** | `${{ secrets.COPILOT_MCP_CODERIFTS_API_KEY }}` |

Tools allowlisted everywhere: `preflight_change_set`, `verify_receipt`, `get_decision_details`.

### Vendored reference tree (`copilot/`)

| Path | Role | Source of truth |
|------|------|-----------------|
| `copilot/.vscode/mcp.json` | VS Code / Copilot Chat | **Generated** — `generate-copilot-mcp.js` |
| `copilot/copilot-cloud-agent-mcp.json` | Cloud agent paste JSON (`mcpServers`) | **Generated** — same |
| `copilot/copilot-custom-agent-mcp.frontmatter.md` | Custom agent YAML frontmatter | **Generated** — same |
| `copilot/docs/copilot-mcp.md` | Install guide + surfaces table | **Generated** — same |
| `copilot/.github/copilot-instructions.md` | Copilot coding-agent instructions | **Generated** — `generate-agent-host-files.js` |
| `copilot/SOURCE.md` | Provenance + re-sync commands | Packaging note (this repo) |

Validate empty-diff vs regeneration + 3-tool discipline:

```bash
node scripts/validate-copilot-kit.js
```

Requires a local `~/coderifts-app` checkout (or `CODERIFTS_APP_ROOT`). The kit is a
**communication / distribution mirror** — `npx coderifts copilot-setup` remains the install path.

---

## MCP server

CodeRifts runs as a hosted **Streamable HTTP** MCP server. Any MCP-compatible agent (Claude Desktop, Cursor, LangGraph, AutoGen, custom) can connect and run governance checks before tool calls or merges.

- **Endpoint:** `https://app.coderifts.com/mcp`
- **Transport:** Streamable HTTP (protocol version `2025-06-18`)
- **Server:** `CodeRifts API Governance` `v1.0.0`
- **Auth:** `initialize` and `tools/list` are open (no key); `tools/call` requires an API key - send `Authorization: Bearer <key>` or `X-API-Key: <key>`.

### Connect

```json
{
  "mcpServers": {
    "coderifts": {
      "url": "https://app.coderifts.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_CODERIFTS_API_KEY>"
      }
    }
  }
}
```

### Verify the connection

```bash
curl -sS https://app.coderifts.com/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Expected: a JSON-RPC `result` with `serverInfo` and `capabilities.tools`.

### Try without a key

Two public endpoints need no auth at all:

```bash
curl -s "https://app.coderifts.com/api/v1/public/preflight?url=https://petstore3.swagger.io/api/v3/openapi.json"

curl -s -X POST https://app.coderifts.com/api/v1/public/actionguard-check \
  -H "Content-Type: application/json" \
  -d '{"filename":".github/workflows/ci.yml","base_content":null,"head_content":"jobs:\n  b:\n    steps:\n      - uses: some-owner/some-action@main"}'
```

Both return `200` with a `decision` field.

---

## Tools

The hosted MCP server exposes **exactly three** tools (from live `tools/list` / generated `mcp.json`):

| Tool | What it does |
|------|--------------|
| `preflight_change_set` | Preflight a complete base→head change set of contract artifacts. Returns risk score and breaking-change analysis. With `preflight_mode: "authorize"` (and `context.operation`), returns a governance decision (ALLOW / WARN / REQUIRE_APPROVAL / BLOCK) and may mint a signed chain-receipt. With `preflight_mode: "analyze"`, returns informational risk only (`may_execute: false`, no decision, no receipt). Requires `artifacts` + `preflight_mode`. |
| `verify_receipt` | Verify a signed chain-receipt you already hold: signature authenticity, body binding, and (when lifecycle indices are available) whether it is currently authorized for a stated operation/target. Requires `token`. Does not re-diff specs. |
| `get_decision_details` | Retrieve a past decision by `decision_id` (preferred) or `fingerprint`: stored report, breaking changes, scores, and linked receipt metadata if present. Not for a new analysis of the current change set. |

On the **authorize** path of `preflight_change_set`, the decision envelope includes fields such as `decision`, `execution_action`, `risk_score`, `safe_for_agent`, and related analysis fields so agent runtimes can branch on a stable contract. Prefer branching on `execution_action` when present.

---

## How agents use it

1. Before merging an API change (or before an agent acts on a contract change), call `preflight_change_set` with full before/after artifacts and `preflight_mode: "authorize"` (plus `context.operation`).
2. Read `execution_action` / `decision`: CONTINUE/ALLOW proceeds, WARN flags, REQUIRE_APPROVAL pauses for a human, STOP/BLOCK stops the merge / aborts the agent step.
3. If you already hold a receipt and only need to confirm it is still valid, call `verify_receipt` — do not re-preflight unless the change set or operation changed.
4. To inspect a prior decision by id, call `get_decision_details`.

Decision logic is deterministic: a single breaking change is never silently allowed. *Tests can pass and still ship a broken contract — CodeRifts checks the contract itself at PR time.*

---

## Also available

- **GitHub App** (zero-config, one-click install) on the GitHub Marketplace - posts a four-gate governance report (API contract, schema-vs-code, auth surface, workflow actions) on every pull request.
- **SDKs:** `@coderifts/sdk` (TypeScript / npm), `coderifts-sdk` (Python / PyPI).
- **CLI:** `coderifts` (npm) with a pre-push hook.
- **Integrations:** Backstage plugin, VS Code extension, LangGraph / AutoGen / CrewAI.

## Links

- Website: https://coderifts.com
- Decision Spec: https://coderifts.com/decision-spec/
- API reference: https://app.coderifts.com/api/docs
- Manifest: https://coderifts.com/mcp.json
- Receipt verifier (verify our receipts without trusting us): https://github.com/coderifts/receipt-verifier
- Contact: hello@coderifts.com

## License

See [LICENSE](LICENSE).

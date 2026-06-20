# CodeRifts — API Governance

**Risk-aware API compatibility governance for AI agents and CI.** Before a change merges, CodeRifts predicts whether it will cause a real production problem, who breaks, by what pattern, at what business cost, and whether blocking is justified.

The market shows you *what* changed. CodeRifts tells you *how dangerous it is, who it affects, when deployment should be blocked, and how much it will cost.*

- Hosted MCP server: `https://app.coderifts.com/mcp`
- Manifest: `https://coderifts.com/mcp.json`
- Official MCP Registry: `io.github.coderifts/api-governance`
- Website: `https://coderifts.com`
- Live demo PR: `https://github.com/coderifts/demo/pull/4`

---

## MCP server

CodeRifts runs as a hosted **Streamable HTTP** MCP server. Any MCP-compatible agent (Claude Desktop, Cursor, LangGraph, AutoGen, custom) can connect and run governance checks before tool calls or merges.

- **Endpoint:** `https://app.coderifts.com/mcp`
- **Transport:** Streamable HTTP (protocol version `2025-06-18`)
- **Server:** `CodeRifts API Governance` `v1.0.0`
- **Auth:** Bearer API key from [coderifts.com](https://coderifts.com) — `Authorization: Bearer <key>`

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

---

## Tools

| Tool | What it does |
|------|--------------|
| `preflight_check` | Analyze an API spec diff before merge. Returns risk score, break probability, blast radius, agent impact, economic cost, and a merge decision (ALLOW / WARN / REQUIRE_APPROVAL / BLOCK). |
| `agent_tool_check` | Detect whether an API change breaks AI agent tool calling (TOOL_RESULT_SHAPE_DRIFT, AGENT_PROTOCOL_DRIFT, and more). Returns an agent-impact score and per-pattern mitigation templates. |
| `agent_readiness_score` | Score an OpenAPI spec or MCP manifest for AI agent readiness (0–100) across nine signals, with band and breakdown. |
| `registry_validate` | Validate an MCP tool registry or OpenAPI spec collection for governance health (schema consistency, auth coverage, deprecation, breaking-change density). |
| `agent_preflight` | Pre-flight governance check for agent workflows. Given tool schemas before/after, returns which tools break, which workflows are affected, blast radius across the agent graph, and a deploy decision. |
| `traffic_analyze` | Infer API spec drift from HTTP traffic samples — runtime behavioral drift detection without requiring spec changes. |
| `mcp_diff` | Compare two MCP manifests and detect breaking changes in tool schemas, input/output contracts, auth requirements, and tool availability. |
| `governance_health` | Governance health score for an API spec: A–F grade (0–100), policy violations, deprecation status, documentation coverage, and security findings. |

Every tool returns the same **Decision Spec v1.0** envelope (`decision`, `risk_score`, `safe_for_agent`, `breaking_changes`, `patterns`, `requires_migration`, `evidence_quality`, `coderifts_version`, `timestamp`) so agent runtimes can branch on a stable contract.

---

## How agents use it

1. Before merging an API change (or before an agent calls a tool), send the before/after spec to `preflight_check`.
2. Read `decision`: `ALLOW` proceeds, `WARN` flags, `REQUIRE_APPROVAL` pauses for a human, `BLOCK` stops the merge / aborts the agent step.
3. On `BLOCK`, the response explains the patterns, blast radius, and estimated incident cost, and provides mitigation templates.

Decision logic is deterministic: a single breaking change is never silently allowed. *Tests can pass and still ship a broken contract — CodeRifts checks the contract itself at PR time.*

---

## Also available

- **GitHub App** (zero-config, one-click install) on the GitHub Marketplace — posts a risk scorecard on every pull request.
- **SDKs:** `@coderifts/sdk` (TypeScript / npm), `coderifts-sdk` (Python / PyPI).
- **CLI:** `coderifts` (npm) with a pre-push hook.
- **Integrations:** Backstage plugin, VS Code extension, LangGraph / AutoGen / CrewAI.

## Links

- Website: https://coderifts.com
- Decision Spec: https://coderifts.com/decision-spec/
- API reference: https://app.coderifts.com/api/docs
- Manifest: https://coderifts.com/mcp.json
- Contact: peter@coderifts.com

## License

See [LICENSE](LICENSE).

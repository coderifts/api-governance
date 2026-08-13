<!-- GENERATED from CodeRifts agent-host-rule (single source). Do not edit rule sentences by hand; run: node scripts/generate-agent-host-files.js -->

# CodeRifts agent rules

Call `preflight_change_set` before merge, deploy, publish, or tool registration when a contract artifact changed (OpenAPI/Swagger, GraphQL, gRPC/protobuf, AsyncAPI, MCP manifest, or agent tool schemas).

Send the complete base-to-head change set: every changed contract artifact with full before and after content. Do not send a single-file subset when other contract files also change.

Branch on `execution_action` only. Do not branch on `decision` and do not branch on `safe_for_agent` (not_for_control_flow_use_execution_action). Canonical `execution_action` values: CONTINUE, CONTINUE_WITH_MONITORING, REQUEST_APPROVAL, STOP.

An unrecognised `execution_action` is not permission: fail closed (halt or re-preflight). Well-known code: `not_permission_fail_closed`.

`CONTINUE_WITH_MONITORING` requires a wired monitoring sink (`monitoringSinkWired`). It is not "proceed with caution" without monitoring.

Do not call CodeRifts tools for a documentation-only change (README, guides, comments) with no contract artifact content change.

If you already hold a chain receipt and only need authenticity/lifecycle: `verify_receipt`. If you need a past decision by id: `get_decision_details`. Neither replaces preflight for a new change set.

For mutating tools, put only the guarded version in the agent's tool table; keep the raw handler host-only and unreachable from that table. How you name tools is yours — this is a reachability property, not a product rename of host tools. CodeRifts cannot see or stop a raw call the host makes outside the table it returns; adopt this as a host convention, not as a guarantee from the package.

CodeRifts reports a governance decision and `execution_action`; it does not by itself block merges. Blocking requires separate repository configuration (required status checks, enforcement) that this rule file does not set.


# Grant versions

Measured 2026-09-01. These three names are not interchangeable.

There is no `execution-grant-request.v2` schema in this repo. The canonical
Atomic V2 **request** field list is what the authorize handler reads when
minting a v2 grant (`src/change-set.js:1209-1285`), dispatched at
`src/verdict-core/execution-grant.js:135` into
`src/verdict-core/execution-grant-v2.js`. Issued-token fields (`kid`,
`grant_id`, `receipt_hash`, `after_payload_hash`, `nonce_hash`, `not_before`,
`expires_at`, `max_attempts`) are minted and are not request fields.

The field-set matrix below is the drift-gate fixture
`test/fixtures/v2-grant-field-matrix.json`. A surface that adds or drops a
field without updating that fixture fails `test/v2-grant-field-matrix.test.js`.

Cell values: **CARRIES** = serializes or validates the named field;
**NAMED-ABSENT** = explicitly declares it not a request parameter;
**UNKNOWN** = no reference in the scanned files.

---

## cr.exec.v1

Reference / teaching grant. Default mint. Positional preimage
`crexec.v1|…` (`src/verdict-core/execution-grant.js`). Opt-in on authorize
with `include_execution_grant: true`; omit `grant_version` (or do not send
`v2`) and the server issues v1.

**Who uses it today**

- Public MCP `preflight_change_set` inputSchema: `include_execution_grant` +
  optional `state_nonce`, described as `cr.exec.v1`
  (`src/routes/mcp-streamable.js:468-481`). Decision 1130-F1: v1 is the
  reference grant on that surface; that decision is not reopened here.
- capability-demo executor and `coderifts init --agents --strict`
  (`require-grant`): teaching / data-plane path. The demo locally mints v1
  (`demo/issue-grant.js`) and verifies v1
  (`packages/middleware/src/verify-grant.js:24`).

  **CORRECTED 2026-09-03.** This entry used to end "A `cr.exec.v2` token is
  `unsupported_version` on that verifier." That is no longer true and had not been
  since the DUAL-ACCEPT change landed: the same file now carries
  `GRANT_VERSION_V2 = 'cr.exec.v2'` and accepts both versions, mirroring the
  committed issuer rather than reimplementing it. The sentence is corrected rather
  than deleted, because it was the stated reason the taught path stayed on v1, and a
  reason that has expired should be visible as expired.
- Unprofiled guard / SDK authorize when `grant_version` is omitted.

**What a v1 grant proves** (when verification returns `GRANT_CURRENT`;
`docs/cr-exec-v1.md`):

- Ed25519 over the v1 body under a published `kid`.
- Bound to `operation ∥ target_id ∥ after_payload` as `scope_hash`.
- `exp` has not passed (same clock-skew leeway as receipts).
- Optional `state_nonce` is a separate signed field (ATOMIC vs BEARER).
  Consumption is the executor's job.

**What it does not prove**

- That any gateway enforced it.
- Executor / adapter / tenant / target URI identity (`executor_id`,
  `adapter_id`, `tenant_id`, `target_uri` are v2 request/token fields).
- One-use consumption for a BEARER grant (no `state_nonce`).
- That `ENFORCING_STRICT` was the profile that requested it. A v1 token is
  a grant format; the profile is a guard construction name.

---

## Atomic V2 request contract

Not the same bytes as a `cr.exec.v1` token. Callers opt in with
`grant_version: 'v2'` (or `grantVersion: 'v2'`) on the preflight body. The
server then binds `target_uri`, `executor_id`, `adapter_id`, `tenant_id`,
`expected_state_token`, and `state_nonce` (as `nonce` → `nonce_hash` on the
token). `operation` and `audience` come from authorize context; after-payload
is derived from `artifacts[]` and hashed as `after_payload_hash`.

**`policy_hash` is a request field and is bound** (1206 variant A). The authorize handler
forwards `input.policy_hash` to the issuer (`src/change-set.js:1323`), which binds it into the
signed token (`src/verdict-core/execution-grant-v2.js:149`); a verifier that states
`intended.policy_hash` gets `GRANT_UNBOUND` / `policy_mismatch` on a mismatch. Absent → the
issuer's `sha256('')` default, which is what every grant carried before. Binding is not by
itself a check: nothing enforces it unless a verifier says which policy it expects.

**`audience_hash` is NOT a request field.** It is derived from `audience`
(`src/verdict-core/execution-grant-v2.js:150`) and already enforced (`:227-234`), so sending it
on the body has no effect on the minted grant. Send `audience`.

**Who speaks the request today**

- TypeScript SDK: `PreflightChangeSetCommon` (`grant_version`, `executor_id`,
  `adapter_id`, `target_uri`, `tenant_id`, `state_nonce`) and — added after the
  2026-09-01 measurement — `expected_state_token` (`src/types.ts:344`).
- TS SDK: since 9359fcd (1425) the hand-written `PreflightChangeSetCommon` names
  `policy_hash` (`src/types.ts:362`), so a TypeScript caller can send it without `as any`.
  Before that the GENERATED request type carried it and the server read it while this one
  did not — two type surfaces disagreeing about the same wire.
- Python SDK: those plus `expected_state_token`, and — since 2026-09-02 — `policy_hash`
  (`EXECUTION_GRANT_V2_REQUEST_FIELDS`, `coderifts/types.py:92`). The tuple is what
  `client.py:354-357` iterates when it builds the body, so the field is genuinely sent.
  Its docstring at `client.py:313` still lists `policy_hash` among the minted fields a client
  cannot supply; that line is stale and contradicted by the SDK's own tuple. The same docstring
  is still correct for `audience_hash`, which the issuer derives from `audience`.
- agent-guard: `grant_version: 'v2'` plus `V2_WIRE_FIELDS` (`executor_id`,
  `adapter_id`, `target_uri`, `tenant_id`, `policy_hash`, `audience_hash`,
  and — since guard **15.1.0** — `expected_state_token`, `src/execution-grant.ts:142`).
  Unconfigured wire fields are recorded as `v2_fields_absent` rather than sent
  as empty placeholders (`src/execution-grant.ts:154-172`, `src/guard.ts:687-708`).
  Its `policy_hash` now reaches the token; its `audience_hash` is still inert, because
  the issuer derives that value from `audience`.
- Public MCP inputSchema does **not** declare the v2 selector or binding
  fields. MCP still teaches v1.
- capability-demo executor and reconciler do **not** send this request. The
  executor consumes **v1** grants (`operation`, `audience`, `jti`,
  `state_nonce`). The reconciler binds consumed-grant `jti`.

### Matrix

Rows are the canonical request list (authorize handler + the listed extras).
Columns are the seven surfaces. Cites are file:line in that surface's
checkout (`coderifts-app` for server/MCP; `~/sdk`; `~/coderifts-python-sdk`;
`~/coderifts-agent-guard`; `~/capability-demo`).

| field | server | mcp | ts_sdk | python | guard | executor | reconciler |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `grant_version` | CARRIES `src/change-set.js:1268` | CARRIES `mcp-streamable.js inputSchema` | CARRIES `src/types.ts:321` | CARRIES `coderifts/client.py:342-343` | CARRIES `src/guard.ts:658,695` | UNKNOWN | UNKNOWN |
| `include_execution_grant` | CARRIES `src/change-set.js:1209` | CARRIES `mcp-streamable.js:468-474` | CARRIES `src/types.ts:319` | CARRIES `coderifts/client.py:338-339` | CARRIES `src/guard.ts:652,684` | UNKNOWN | UNKNOWN |
| `tenant_id` | CARRIES `src/change-set.js:1279` | CARRIES `mcp-streamable.js inputSchema` | CARRIES `src/types.ts:325` | CARRIES `coderifts/types.py:67` | CARRIES `src/execution-grant.ts:132` | UNKNOWN | UNKNOWN |
| `executor_id` | CARRIES `src/change-set.js:1277` | CARRIES `mcp-streamable.js inputSchema` | CARRIES `src/types.ts:322` | CARRIES `coderifts/types.py:64` | CARRIES `src/execution-grant.ts:129` | UNKNOWN | UNKNOWN |
| `adapter_id` | CARRIES `src/change-set.js:1278` | CARRIES `mcp-streamable.js inputSchema` | CARRIES `src/types.ts:323` | CARRIES `coderifts/types.py:65` | CARRIES `src/execution-grant.ts:130` | UNKNOWN | UNKNOWN |
| `target_uri` | CARRIES `src/change-set.js:1276` | CARRIES `mcp-streamable.js inputSchema` | CARRIES `src/types.ts:324` | CARRIES `coderifts/types.py:66` | CARRIES `src/execution-grant.ts:131` | UNKNOWN | UNKNOWN |
| `operation` | CARRIES `src/change-set.js:1271` | CARRIES `mcp-streamable.js:439-445` | CARRIES `src/types.ts:268` | CARRIES `coderifts/types.py:116` | CARRIES `src/guard.ts:649,667` | CARRIES `verify-grant.js:39` | UNKNOWN |
| `environment` | CARRIES `src/change-set.js:1159` | CARRIES `mcp-streamable.js:446-448` | CARRIES `src/types.ts:269` | CARRIES `coderifts/types.py:117` | CARRIES `src/guard.ts:649,667` | UNKNOWN | UNKNOWN |
| `audience` | CARRIES `src/change-set.js:1272` | CARRIES `mcp-streamable.js:462` | CARRIES `src/types.ts:283` | CARRIES `coderifts/types.py:126` | CARRIES `src/guard.ts request block (1402)` | CARRIES `verify-grant.js:39` | UNKNOWN |
| `after_payload_digest` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| `jti` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | CARRIES `verify-grant.js:39` | CARRIES `demo/src/reconcile.js:50` |
| `expiry` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |
| `state_nonce` | CARRIES `src/change-set.js:1265-1280` | CARRIES `mcp-streamable.js:476-481` | CARRIES `src/types.ts:334` | CARRIES `coderifts/client.py:340-341` | CARRIES `src/guard.ts:653,685` | CARRIES `verify-grant.js:50` | UNKNOWN |
| `expected_state_token` | CARRIES `src/change-set.js:1305` | CARRIES `mcp-streamable.js inputSchema` | CARRIES `src/types.ts:344` | CARRIES `coderifts/types.py:68` | CARRIES `src/execution-grant.ts:142` | UNKNOWN | UNKNOWN |
| `policy_hash` | CARRIES `src/change-set.js:1323` | CARRIES `mcp-streamable.js inputSchema` | CARRIES `src/types.ts:362` | CARRIES `coderifts/types.py:92` | CARRIES `src/execution-grant.ts:133` | UNKNOWN | UNKNOWN |
| `audience_hash` | UNKNOWN | UNKNOWN | UNKNOWN | NAMED-ABSENT `coderifts/client.py:309-314` | UNKNOWN `removed from V2_WIRE_FIELDS in guard 17.1.0 (1402)` | UNKNOWN | UNKNOWN |

### Auditor hypothesis (2026-09-01) — scored against this matrix

Scope: 8 fields × Guard / TS SDK / Python / Live MCP = 32 cells.

| claim | result |
| --- | --- |
| `grant_version`, `executor_id`, `adapter_id`, `target_uri`, `tenant_id` present in Guard+TS+Py, absent in MCP | 20/20 right |
| `expected_state_token` only Python among those four | 4/4 right |
| `policy_hash` and `audience_hash` request-side only Guard | 8/8 right |
| **Total** | **32 right / 0 wrong** |

**Two of those cells have since moved, and the score above is not re-written.** It was correct
when it was taken; a hypothesis scored against a later surface is not the same measurement.
`expected_state_token` went UNKNOWN → CARRIES on **two** surfaces (Guard **15.1.0**,
`src/execution-grant.ts:142`; TS SDK, `src/types.ts:344`), and `policy_hash` / server went
UNKNOWN → CARRIES in 1206 variant A (`src/change-set.js:1323`). The live matrix above and the fixture carry the current
values; this table carries the 2026-09-01 ones.

The CLI README line that named “SDK, Guard, executor” as the V2 request
speakers is not this 32-cell set. Measured: executor does not speak the V2
request (it consumes v1). MCP is deliberately v1.

---

## ENFORCING_STRICT

The versioned profile name **already exists**: `ENFORCING_STRICT_V1`
(`coderifts-agent-guard/src/with-coderifts.ts:245`; canonical since
`0951522`). `ENFORCING_STRICT` is a **permanent alias** that "must resolve
to `_V1` forever" (`with-coderifts.ts:232`). It is not a grant format.

This is a **different axis** from `ENFORCING_ATOMIC_V1` /
`ENFORCING_ATOMIC_V2` (`atomic-profile.ts:12` / `:48`): those names are
executor-side invariants. Zero shared vocabulary with `ENFORCING_STRICT` /
`ENFORCING_STRICT_V1`.

The wire value stays unsuffixed `'ENFORCING_STRICT'`
(`GUARD_PROFILE_WIRE_VALUE`, `with-coderifts.ts:270`) so four downstream
modules that compare `opts.profile === 'ENFORCING_STRICT'` do not see a
rename.

**What `ENFORCING_STRICT` guarantees today**

- Construction-time: an enabled execution grant (`executionGrant: { enabled:
  true }`) since guard 10. An unprofiled composition still defaults the grant
  OFF.
- Construction-time configuration only. The profile cannot require executor
  behaviour (nonce consumed once, CAS, attestation). Those are facts about a
  remote party the guard does not run (`with-coderifts.ts:239-243`).
- It does not choose `cr.exec.v1` vs `cr.exec.v2`. Which token arrives
  depends on `executionGrant.grantVersion` (default v1 this wave) and on
  what the server mints.

---

## Related

- `docs/cr-exec-v1.md` — v1 format, profiles, verification algorithm.
- `docs/agents-quickstart.md` — canonical production path (`ENFORCING_ATOMIC_V2` + `cr.exec.v2`); customer target `WIRING_REQUIRED` until wired; legacy v1 / STRICT / ATOMIC_V1 in Migration from v1.
- `packages/cli/README.md` — Grant versions table (hand-maintained).

# OpenAI production pattern — host-side tool dispatch (ID108)

**Platform recipe:** how to wire CodeRifts governance into an OpenAI **function-calling** app loop.

This is **not** a Claude Code PreToolUse hook port. On OpenAI (official function-calling model), the model only **emits** a JSON `tool_call`; **the application executes it**. The deterministic governance point is therefore the **host tool-dispatch loop** — exactly where `@coderifts/agent-guard`’s `executeOpenAIToolCall` sits.

| Layer | Role |
|-------|------|
| **Instruction** | `AGENTS.md` / `openai-agent-instructions.md` (from `npx coderifts agent-setup`) — when to call MCP preflight tools |
| **MCP / skill** | Codex plugin package in this folder (three tools only) |
| **Runtime enforcement** | Guarded tool table + `executeOpenAIToolCall` (npm `@coderifts/agent-guard` ≥ **6.4.0**) |

Requires: Node 20+, `@coderifts/agent-guard@6.4.0` (or newer with the same OpenAI face), and a CodeRifts SDK / API client for live preflight (smoke below stubs the client).

---

## Mechanics (measured)

1. Model returns `message.tool_calls[]` with `{ id, type: 'function', function: { name, arguments } }`.
2. Host **must** run each call and append a `role: 'tool'` message with matching `tool_call_id`.
3. `tool_choice` (`none` | `auto` | `required` | `{ type: 'function', name }`) only **steers** which tool the model picks — it does **not** enforce governance. The dispatcher enforces.
4. OpenAI’s `allowed_tools` variant is **model-flaky** (live GPT-5 reports); do not build the spine on it. Prefer host-side dispatch only.

---

## Step 1 — Define tools with strict JSON schemas

Use the official chat Completions function-tool shape. Prefer `strict: true` when your SDK/API version supports structured outputs for tools:

```js
const openAIToolDefs = [
  {
    type: 'function',
    function: {
      name: 'apply_openapi',
      description: 'Apply an OpenAPI contract change (base → head).',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                before: { type: 'string' },
                after: { type: 'string' },
              },
              required: ['id', 'type', 'before', 'after'],
            },
          },
        },
        required: ['artifacts'],
      },
    },
  },
];
```

(When using `withCodeRiftsOpenAI`, the returned `tools` array is already OpenAI-shaped from the registry; keep schemas complete on the **raw** tool `inputSchema`.)

---

## Step 2 — Register mutating tools in the guard table (operation binding)

Only the **guarded** table goes to the model / dispatcher. Keep raw handlers host-only and **unreachable** from that table.

```js
import {
  withCodeRiftsOpenAI,
  executeOpenAIToolCall,
} from '@coderifts/agent-guard';

const rawTools = [
  {
    name: 'apply_openapi',
    description: 'Apply an OpenAPI contract change',
    mutationClass: 'mutating', // required honesty: mutators are preflighted
    inputSchema: { /* same JSON Schema as parameters */ },
    execute: async (args) => {
      // real mutation — runs ONLY when the guard allows
      return { applied: true, args };
    },
  },
];

const {
  tools,              // OpenAI chat.completions `tools` — protected shapes only
  protected_tools,    // same list with execute — host dispatch only
  composition_assurance,
} = withCodeRiftsOpenAI({
  tools: rawTools,
  client,             // CodeRifts SDK client (authorize / verify)
  operation: 'tool_call', // REQUIRED — receipts bind to an operation (merge ≠ deploy ≠ tool_call)
});
```

**Honesty (table reachability):** CodeRifts cannot see or stop a raw call the host makes **outside** the table it returns. Register **only** `tools` / `protected_tools` with the model runtime; do not also expose raw mutators on that surface.

---

## Step 3 — Canonical dispatch loop (real signature)

Signature from `@coderifts/agent-guard@6.4.0` (`execute-tool-call.d.ts`):

```ts
function executeOpenAIToolCall(args: {
  tools: ProtectedToolTableInput; // protected table or withCodeRifts* result
  tool_call_id: string;
  name: string;
  arguments?: unknown;            // object or JSON string
  serialize?: (result: unknown) => string;
}): Promise<ProofBoundOpenAIToolMessage>;
// ProofBoundOpenAIToolMessage ≡ { role: 'tool', tool_call_id, content } (+ type brand)
```

One loop — feed every model `tool_call` through the dispatcher:

```js
// After: const completion = await openai.chat.completions.create({
//   model, messages, tools, /* optional: tool_choice — steers only */
// });

const msg = completion.choices[0].message;
messages.push(msg);

for (const tc of msg.tool_calls || []) {
  if (tc.type !== 'function') continue;

  // REAL signature — do not call protected_tools[i].execute directly for mutators
  const toolMessage = await executeOpenAIToolCall({
    tools: protected_tools, // or the full withCodeRiftsOpenAI result
    tool_call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments, // OpenAI string JSON is OK
  });

  // ALWAYS append — ALLOW success → real result in content;
  // BLOCK → gate text + decision envelope fields; raw factory did not run.
  messages.push(toolMessage);
}

// Continue the conversation with messages (model sees remediation on BLOCK).
```

| Gate outcome | What the model sees in `role: 'tool'` | Mutation |
|--------------|----------------------------------------|----------|
| **ALLOW** + success | Serialized real function result + proof trail in `content` | Ran |
| **BLOCK** / STOP | Gate denial + surfaced envelope fields (e.g. `decision_id`, `execution_action`) — **no fabricated success payload** | **Did not run** |

---

## Step 4 — Optional: `tool_choice: 'required'` (steering only)

When the flow **must** consult a governance/preflight tool before acting, you may set:

```js
tool_choice: 'required',
// or tool_choice: { type: 'function', name: 'apply_openapi' }
```

**Caveat:** this only pressures the **model** to emit a tool call. It does **not** enforce CodeRifts policy. Enforcement is still **host-side** `executeOpenAIToolCall` on a guarded table. Do not treat `tool_choice` as a substitute for the dispatcher.

---

## Step 5 — Rule-file layer (agent-setup OpenAI)

Install / regenerate instruction files (same source as this package’s generated copies):

```bash
npx coderifts agent-setup
# emits AGENTS.md, openai-agent-instructions.md, … (6 formats)
```

In this package:

- `AGENTS.md` — agent rules (branch on `execution_action` only; mutators only via guarded table)
- `openai-agent-instructions.md` — OpenAI Agents SDK instructions (same rule body)

Do not hand-edit rule sentences; regenerate from `coderifts-app` `generate-agent-host-files.js`.

---

## LIMITS (condensed from shipped guard execution proof)

From every `GuardExecutionProof.limits` / composition honesty:

- **Host bypass outside the guarded table remains possible** and is **named as such** (`does_not_claim_host_cannot_bypass`, `calls_outside_guarded_path_invisible`).
- A checked change fingerprint is **not** automatic proof of what executed (`change_fp_is_what_was_checked_not_what_executed`).
- Absent optional fields are **not** compliance (`does_not_claim_absent_field_is_compliance`).
- The package does **not** claim the change is “safe” (`does_not_claim_change_safe`).
- Host-asserted conditional write is **not** CAS verification (`conditional_write_is_host_asserted_not_cas_verified`).

Adopt “only register the guarded table” as a **host convention**, not as a runtime guarantee against a second raw path.

---

## Smoke (no OpenAI API key)

From the **api-governance** repo root:

```bash
npm run smoke:openai-dispatch
# or: node plugins/api-governance-openai/scripts/smoke-execute-openai-tool-call.mjs
```

Asserts ALLOW (real result) and BLOCK (envelope; factory not run) through the **real** `executeOpenAIToolCall` against a stub client (same pattern as guard unit tests).

---

## See also

- Package install / MCP / Codex layout: repo root `README.md` → **OpenAI / Codex package**
- Validate kit: `node scripts/validate-openai-package.js`
- Guard package: https://www.npmjs.com/package/@coderifts/agent-guard  
- Function calling guide (OpenAI): https://platform.openai.com/docs/guides/function-calling

#!/usr/bin/env node
/**
 * ID108 smoke — OpenAI production-pattern dispatcher (no OpenAI API key).
 *
 * Feeds a FIXED fake model tool_call (official chat Completions shape) through
 * the real executeOpenAIToolCall against a stub CodeRifts client (same pattern
 * as @coderifts/agent-guard test/execute-tool-call.test.js).
 *
 * Asserts:
 *   ALLOW  → role:tool message carries the real function result; factory ran
 *   BLOCK  → content is gate/envelope; factory did NOT run
 *
 * Exit 0 on pass, 1 on fail.
 *
 * Resolve guard (first hit):
 *   CODERIFTS_AGENT_GUARD_ROOT
 *   ~/coderifts-agent-guard
 *   require('@coderifts/agent-guard')
 *
 * Usage (from api-governance repo root):
 *   npm run smoke:openai-dispatch
 *   node plugins/api-governance-openai/scripts/smoke-execute-openai-tool-call.mjs
 */
'use strict';

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveGuard() {
  const candidates = [];
  if (process.env.CODERIFTS_AGENT_GUARD_ROOT) {
    candidates.push(path.resolve(process.env.CODERIFTS_AGENT_GUARD_ROOT));
  }
  candidates.push(path.join(os.homedir(), 'coderifts-agent-guard'));
  candidates.push(path.join(__dirname, '..', '..', '..', 'node_modules', '@coderifts', 'agent-guard'));

  for (const root of candidates) {
    const cjs = path.join(root, 'dist', 'cjs', 'index.js');
    if (fs.existsSync(cjs)) {
      return { mod: require(cjs), from: cjs };
    }
    const pkg = path.join(root, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        return { mod: require(root), from: root };
      } catch (_) {
        /* try next */
      }
    }
  }
  try {
    return { mod: require('@coderifts/agent-guard'), from: '@coderifts/agent-guard' };
  } catch (e) {
    console.error(
      'smoke: cannot resolve @coderifts/agent-guard (need 6.4.0+ with executeOpenAIToolCall).\n'
        + '  Set CODERIFTS_AGENT_GUARD_ROOT or clone ~/coderifts-agent-guard and build (npm run build).\n'
        + `  last error: ${e && e.message}`,
    );
    process.exit(1);
  }
}

const { mod: guard, from: guardFrom } = resolveGuard();
const {
  guardToolRegistry,
  executeOpenAIToolCall,
  computeBodyHash,
} = guard;

if (typeof executeOpenAIToolCall !== 'function') {
  console.error(`smoke: executeOpenAIToolCall missing from ${guardFrom} (need guard ≥ 6.4.0)`);
  process.exit(1);
}

// ── Stub helpers (measured from guard test/execute-tool-call.test.js) ─────────

function signedFor(env) {
  return { fp: env.fingerprint, bh: computeBodyHash(env) };
}

function envelope(execution_action, decision, opts = {}) {
  const env = {
    spec_version: 'decision-result.v1.1',
    decision,
    execution_action,
    decision_id: opts.decision_id || 'dec_smoke_1',
    correlation_id: 'smoke',
    evaluated_at: '2026-07-28T00:00:00Z',
    expires_at: opts.expires_at || '2099-01-01T00:00:00Z',
    fingerprint: opts.fingerprint || (`sha256:${'d'.repeat(64)}`),
    input_fingerprint: opts.fingerprint || (`sha256:${'d'.repeat(64)}`),
    safe_for_agent: decision === 'ALLOW' || decision === 'WARN',
    analysis_complete: true,
    operation: opts.operation || 'tool_call',
    receipt: opts.noReceipt
      ? undefined
      : { token: 'tok', format_version: 'v4', key_id: 'k', issued_at: 'x' },
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

function mockClient({ preflight } = {}) {
  let lastEnv = null;
  return {
    async authorizeChangeSet(r) {
      return this.preflightChangeSet({ ...r, preflight_mode: 'authorize' });
    },
    async preflightChangeSet() {
      const resp = preflight
        ? preflight()
        : {
            decision: 'ALLOW',
            execution_action: 'CONTINUE',
            decision_result: envelope('CONTINUE', 'ALLOW'),
          };
      lastEnv = resp && resp.decision_result;
      return resp;
    },
    async verifyReceipt() {
      return lastEnv
        ? { valid: true, status: 'VERIFIED_CURRENT', payload: signedFor(lastEnv) }
        : { valid: true, status: 'VERIFIED_CURRENT' };
    },
  };
}

/** Fixed contract args — same shape as model tool arguments (object). */
const ARTIFACTS = [
  {
    id: 'a',
    type: 'openapi',
    before: 'openapi: 3.0.0\ninfo: {title: A}',
    after: 'openapi: 3.0.1\ninfo: {title: A}',
  },
];

/**
 * Official-shaped model tool_call (chat Completions).
 * @see https://platform.openai.com/docs/guides/function-calling
 */
const FAKE_TOOL_CALL = Object.freeze({
  id: 'call_smoke_allow_1',
  type: 'function',
  function: Object.freeze({
    name: 'apply_openapi',
    arguments: JSON.stringify({ artifacts: ARTIFACTS }),
  }),
});

function makeTable(opts = {}) {
  let factoryRan = false;
  const client = opts.client || mockClient();
  const tools = [
    {
      name: 'apply_openapi',
      mutationClass: 'mutating',
      execute: async () => {
        factoryRan = true;
        return { applied: true, smoke: true };
      },
    },
  ];
  const reg = guardToolRegistry(tools, {
    guard: {
      client,
      operation: 'tool_call',
    },
  });
  return { table: reg.tools, getFactoryRan: () => factoryRan };
}

// ── Cases ────────────────────────────────────────────────────────────────────

let failed = 0;
function pass(label) {
  console.log(`PASS  ${label}`);
}
function fail(label, detail) {
  failed += 1;
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

console.log(`smoke: guard from ${guardFrom}`);

// ALLOW
{
  const { table, getFactoryRan } = makeTable({
    client: mockClient({
      preflight: () => ({
        decision: 'ALLOW',
        execution_action: 'CONTINUE',
        decision_result: envelope('CONTINUE', 'ALLOW', { decision_id: 'dec_smoke_allow' }),
      }),
    }),
  });

  const tc = FAKE_TOOL_CALL;
  const msg = await executeOpenAIToolCall({
    tools: table,
    tool_call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  });

  if (msg.role !== 'tool') fail('ALLOW role', String(msg.role));
  else pass('ALLOW role:tool');

  if (msg.tool_call_id !== tc.id) fail('ALLOW tool_call_id', msg.tool_call_id);
  else pass('ALLOW tool_call_id matches model call id');

  if (!getFactoryRan()) fail('ALLOW factory ran', 'execute() did not run');
  else pass('ALLOW factory ran (real mutation path)');

  if (typeof msg.content !== 'string' || !msg.content.includes('applied')) {
    fail('ALLOW content has real result', String(msg.content).slice(0, 120));
  } else {
    pass('ALLOW content carries real function result');
  }
}

// BLOCK
{
  const { table, getFactoryRan } = makeTable({
    client: mockClient({
      preflight: () => ({
        decision: 'BLOCK',
        execution_action: 'STOP',
        decision_result: envelope('STOP', 'BLOCK', { decision_id: 'dec_smoke_block' }),
      }),
    }),
  });

  const tc = {
    id: 'call_smoke_block_1',
    type: 'function',
    function: {
      name: 'apply_openapi',
      arguments: JSON.stringify({ artifacts: ARTIFACTS }),
    },
  };

  const msg = await executeOpenAIToolCall({
    tools: table,
    tool_call_id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  });

  if (msg.role !== 'tool') fail('BLOCK role', String(msg.role));
  else pass('BLOCK role:tool');

  if (getFactoryRan()) fail('BLOCK factory must not run', 'mutation executed on BLOCK');
  else pass('BLOCK factory did NOT run');

  if (typeof msg.content !== 'string' || !/did not permit execution/i.test(msg.content)) {
    fail('BLOCK gate text', String(msg.content).slice(0, 160));
  } else {
    pass('BLOCK content is gate denial (no fabricated success)');
  }

  if (/"applied"\s*:\s*true/.test(msg.content)) {
    fail('BLOCK no fabricated result', 'content contains applied:true');
  } else {
    pass('BLOCK content does not contain applied:true');
  }

  // Envelope fields are surface when present (decision_id / BLOCK|STOP)
  if (!/dec_smoke_block|BLOCK|STOP/i.test(msg.content)) {
    fail('BLOCK envelope surface', 'expected decision_id or BLOCK/STOP in content');
  } else {
    pass('BLOCK surfaces decision identity / action in content');
  }
}

console.log('');
if (failed) {
  console.log(`RESULT: FAIL (${failed} assertion(s))`);
  process.exit(1);
}
console.log('RESULT: ALL PASS');
process.exit(0);

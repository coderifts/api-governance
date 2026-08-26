#!/usr/bin/env node
/**
 * tools.wire.v1.json must stay byte-identical to what the live server serves.
 *
 * WHY THIS FILE EXISTS. surface-anchor.source_ref was null because no PUBLIC, third-party-fetchable
 * artifact carried the wire-format tools[]: coderifts/app and coderifts/website are private, and
 * this repo's mcp.json is a registry card with a different shape on purpose. tools.wire.v1.json
 * closes that gap — but only while it is true. A stale pin target is worse than a null one, which
 * is the reasoning that set source_ref null in the first place.
 *
 * This is the gate that keeps it honest. It is NOT a substitute for the app's own generator; it is
 * the check a third party can run themselves.
 *
 * Pure Node (global fetch, Node 18+). No dependencies. Exit 0 iff the file matches live.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'tools.wire.v1.json');
const LIVE = 'https://app.coderifts.com/mcp';

/** Sorted keys at every depth, no whitespace, raw UTF-8 — the documented digest_input. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const digest = (t) => `sha256:${createHash('sha256').update(canonical(t), 'utf8').digest('hex')}`;

const fail = (m) => { console.error(`validate-tools-wire: FAIL — ${m}`); process.exit(1); };

const doc = JSON.parse(readFileSync(FILE, 'utf8'));

// 1. The file must be self-consistent before it is compared to anything.
if (doc.schema !== 'coderifts.tools-wire.v1') fail(`unexpected schema ${doc.schema}`);
if (!Array.isArray(doc.tools) || doc.tools.length === 0) fail('tools[] missing or empty');
if (doc.tool_count !== doc.tools.length) fail(`tool_count ${doc.tool_count} != tools.length ${doc.tools.length}`);
if (digest(doc.tools) !== doc.tools_sha256) {
  fail(`tools_sha256 does not describe tools[] — file says ${doc.tools_sha256}, computed ${digest(doc.tools)}`);
}

// 2. It must be the WIRE shape, not the registry card. Confusing the two is the whole risk.
for (const t of doc.tools) {
  if (!('inputSchema' in t)) fail(`${t.name}: wire format requires camelCase inputSchema`);
  if ('input_schema' in t) fail(`${t.name}: snake_case input_schema is the registry card (mcp.json), not the wire`);
  if ('endpoint' in t) fail(`${t.name}: the wire format has no endpoint field — that is a registry-card addition`);
}

// 3. And it must match what is actually served right now.
//
// NETWORK-UNAVAILABLE POLICY — the same rule as the app's --verify-source-ref, deliberately, so the
// two halves of one obligation cannot disagree about what a transport failure means:
//   TRANSPORT failure (DNS, timeout, 5xx) → SKIP, loudly, exit 0. A gate that fails on a flaky
//     network trains people to re-run until green, and a green obtained that way means nothing.
//   EVERYTHING ELSE → FAIL. A 404/403 looks like a network problem and is not: it is the endpoint
//     or tag being gone, which is a real verdict.
// The skip is printed at warning volume and names what was NOT checked. A silent skip is how the
// website vendoring gate went unnoticed for five days.
const skip = (m) => {
  console.error(`\n!!  validate-tools-wire SKIPPED — NOT VERIFIED  !!\n    ${m}\n`
    + '    tools.wire.v1.json was NOT compared against the live surface. If the surface moved and\n'
    + '    this file was not regenerated, this run did not catch it.\n');
  process.exit(0);
};

let res;
try {
  res = await fetch(LIVE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
} catch (err) {
  skip(`transport error reaching ${LIVE}: ${err?.message}`);
}
if (!res.ok) {
  if (res.status === 404 || res.status === 403) fail(`live tools/list returned HTTP ${res.status} — the endpoint is gone, not unreachable`);
  skip(`live tools/list returned HTTP ${res.status} (treated as transport, not drift)`);
}
let liveTools;
try {
  liveTools = (await res.json())?.result?.tools;
} catch (err) {
  skip(`live response was not JSON: ${err?.message}`);
}
if (!Array.isArray(liveTools)) fail('live response carried no result.tools[]');

const liveDigest = digest(liveTools);
if (liveDigest !== doc.tools_sha256) {
  fail(`SURFACE MOVED. live=${liveDigest} file=${doc.tools_sha256}\n`
    + '  Regenerate tools.wire.v1.json from the live response and re-tag. Until then this repo is '
    + 'NOT a valid source_ref target, and the anchor should go back to null rather than point here.');
}
console.log(`validate-tools-wire: OK — ${doc.tools.length} tools, ${liveDigest} matches live`);

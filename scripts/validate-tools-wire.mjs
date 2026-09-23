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

/**
 * The live endpoint, overridable ONLY so the negative control can point it at something that
 * answers 502. ⚠ Named CODERIFTS_TOOLS_WIRE_LIVE_URL rather than a bare LIVE_URL: an override this
 * powerful should be impossible to set by accident, and impossible to miss in a process listing.
 */
const LIVE_URL = process.env.CODERIFTS_TOOLS_WIRE_LIVE_URL || LIVE;

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
//
// ⚠ AND THE SKIP IS MODE-AWARE SINCE 2026-09-23, because "loudly, exit 0" is the right answer on a
// pull request and the WRONG one on a schedule.
//
// The schedule exists for one reason: the wire target can go stale without anything in this repo
// changing, so push and PR alone would never notice. A scheduled run that skips has achieved
// EXACTLY NOTHING and reports success — the same silent green the schedule was added to replace.
// Worse than no schedule, because the green is now on the record.
//
// On a PR the opposite holds. A contributor's change must not go red because somebody else's server
// had a bad minute; that is how people learn to re-run until green.
//
// ⚠ THE HAZARD IS MEASURED, not hypothetical. On 2026-09-23 app.coderifts.com answered HTTP 502 for
// roughly a minute — four independent live gates in the website repo went red together and green on
// retry. Had that minute landed on the 06:17 UTC cron, this validator would have skipped and the
// scheduled run would have said `success`. MEASURED across the last 20 runs of validate.yml: no skip
// has actually occurred yet (every run that reached this step printed OK; the 2026-09-22 scheduled
// failure was the Cursor-plugin step, which runs BEFORE this one and never let it start). This is a
// latent defect being closed before it fires, not a post-mortem.
//
// ⚠ THE MODE IS A FLAG, NOT A SNIFFED ENVIRONMENT VARIABLE. A script that changes its verdict from
// ambient state is hard to test and easy to mis-trigger; the workflow states the intent, the script
// obeys it, and the negative control drives the same flag a human would.
const REQUIRE_LIVE = process.argv.includes('--require-live');

const skip = (m) => {
  if (REQUIRE_LIVE) {
    console.error(`\nvalidate-tools-wire: FAIL — LIVE COMPARISON WAS REQUIRED AND DID NOT HAPPEN\n    ${m}\n`
      + '    This run was started with --require-live, which is what the SCHEDULED workflow path uses.\n'
      + '    The schedule exists because the live surface can move without anything in this repo\n'
      + '    changing: a scheduled run that skips the comparison has achieved nothing, and reporting\n'
      + '    success for it puts a green on the record that no measurement backs.\n'
      + '    This is NOT a claim that the surface moved. It is a refusal to claim it did not.\n'
      + '    On a pull request the same condition is a warning and exits 0 — see the note above.\n');
    process.exit(1);
  }
  console.error(`\n!!  validate-tools-wire SKIPPED — NOT VERIFIED  !!\n    ${m}\n`
    + '    tools.wire.v1.json was NOT compared against the live surface. If the surface moved and\n'
    + '    this file was not regenerated, this run did not catch it.\n'
    + '    Exit 0 because this run did not ask for live evidence. The scheduled path does\n'
    + '    (--require-live) and fails on exactly this line.\n');
  process.exit(0);
};

let res;
try {
  res = await fetch(LIVE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
} catch (err) {
  skip(`transport error reaching ${LIVE_URL}: ${err?.message}`);
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

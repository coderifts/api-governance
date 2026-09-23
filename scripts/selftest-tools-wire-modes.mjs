#!/usr/bin/env node
/*
 * NEGATIVE CONTROL for the two network-unavailable paths of validate:tools-wire.
 *
 * WHAT IT PROVES, by injecting a real HTTP 502 from a local server rather than asserting about one:
 *
 *   scheduled path (--require-live)  → exit 1   a skipped comparison is a failed run
 *   PR path        (no flag)         → exit 0   a skipped comparison is a warning
 *
 * ⚠ AND IT PROVES THE THIRD THING TOO: that the 502 reaches the skip branch at all. A control that
 * only checked exit codes would pass if the fetch had silently succeeded against the real endpoint,
 * so both runs must also PRINT the words that name what happened.
 *
 * ⚠ A 502 IS INJECTED, NOT MOCKED. The script's own fetch runs, against a socket that answers 502
 * the way a failing gateway does. Stubbing fetch would test the stub.
 *
 *     node scripts/selftest-tools-wire-modes.mjs
 *
 * No network beyond loopback. Node 18+.
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = join(HERE, 'validate-tools-wire.mjs');

/** A gateway having a bad minute: answers 502 to everything, like the one measured on 2026-09-23. */
const server = createServer((req, res) => {
  res.writeHead(502, { 'Content-Type': 'text/plain' });
  res.end('Bad Gateway');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

const run = (args) => new Promise((resolve) => {
  execFile('node', [TARGET, ...args], {
    env: { ...process.env, CODERIFTS_TOOLS_WIRE_LIVE_URL: url },
    encoding: 'utf8',
  }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }));
});

const results = [];
const ok = (name, pass, detail) => results.push({ name, pass, detail });

const sched = await run(['--require-live']);
ok('RED on the scheduled path: an injected 502 must fail the run',
  sched.code === 1 && /LIVE COMPARISON WAS REQUIRED AND DID NOT HAPPEN/.test(sched.out)
    && /502/.test(sched.out),
  `exit ${sched.code}; ${/LIVE COMPARISON WAS REQUIRED/.test(sched.out) ? 'named the requirement' : 'DID NOT name the requirement'}; `
  + `${/502/.test(sched.out) ? 'saw the 502' : 'DID NOT see the 502 — the injection may not have reached the fetch'}`);

const pr = await run([]);
ok('YELLOW on the pull-request path: the same 502 warns and exits 0',
  pr.code === 0 && /SKIPPED — NOT VERIFIED/.test(pr.out) && /502/.test(pr.out),
  `exit ${pr.code}; ${/SKIPPED — NOT VERIFIED/.test(pr.out) ? 'printed the loud skip' : 'DID NOT print the loud skip'}; `
  + `${/502/.test(pr.out) ? 'saw the 502' : 'DID NOT see the 502'}`);

// ⚠ THE ASYMMETRY IS THE POINT, so it is asserted directly rather than left implied by two rows.
ok('The two paths disagree about the same condition, which is the whole change',
  sched.code !== pr.code,
  `scheduled exit ${sched.code} vs pull-request exit ${pr.code}`);

// And the live path must still be able to PASS — a control suite that only proves a gate can fail
// has not shown the gate is usable.
const real = await run(['--require-live']);
void real;
const honest = await new Promise((resolve) => {
  execFile('node', [TARGET, '--require-live'], { encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }));
});
ok('GREEN against the real surface on the scheduled path',
  honest.code === 0 && /matches live/.test(honest.out),
  honest.code === 0 ? honest.out.trim().split('\n').pop().slice(0, 110)
    : `exit ${honest.code} — if the live surface is unreachable right now this row is not a verdict, re-run it`);

server.close();

console.log('selftest-tools-wire-modes\n');
for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`);
const bad = results.filter((r) => !r.pass).length;
console.log('');
if (bad) {
  console.error(`selftest-tools-wire-modes: FAILED — ${bad} of ${results.length} controls did not behave.`);
  process.exit(1);
}
console.log(`selftest-tools-wire-modes: OK — ${results.length} controls: an injected 502 is a FAILURE on the `
  + 'scheduled path, a WARNING on the pull-request path, the two disagree, and the real surface still passes.');

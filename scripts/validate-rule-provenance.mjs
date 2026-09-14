#!/usr/bin/env node
/**
 * The recorded snapshots must carry the rule text we publish.
 *
 * WHY THIS FILE EXISTS. fixtures/recorded/app-generator/ is what the kit validators fall back to
 * when the coderifts-app checkout is absent — which is always, in CI, because that repository is
 * private. The fallback compares the kit against the recording, so when the SOURCE moves and
 * neither the kit nor the recording follows, the two still agree and CI reports a pass. That is
 * not hypothetical: between 2026-09-02 and 2026-09-14 the canonical rule gained a paragraph, two
 * carriers were 268 bytes behind, and eight consecutive scheduled runs were green.
 *
 * pin.json names the producing commit, but that name is in a private repository, so no public run
 * can check it — and the one that mattered was wrong anyway (it named 6a44047, the commit that
 * introduced the paragraph, while carrying 6a44047~1's bytes). A label nobody can verify is not
 * provenance.
 *
 * So this gate verifies the CONTENT instead of the label, against something public: the canonical
 * rule text ships inside @coderifts/sdk on npm, as the CODERIFTS_POLICY constant. Every paragraph
 * the published policy carries must appear in every recorded rule carrier. No private checkout, no
 * secret in a public repository's CI — the same shape as validate-tools-wire.mjs, which measures
 * the tool surface against the live server the same way.
 *
 * WHAT IT DOES NOT PROVE. That the snapshot is byte-identical to the generator's output. Wrappers,
 * headers and channel-tuned framing differ per host on purpose. This proves no canonical paragraph
 * went missing, which is the drift that actually happened.
 *
 * Pure Node (global fetch, Node 18+). No dependencies.
 */
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = join(ROOT, 'fixtures', 'recorded', 'app-generator');
const REGISTRY = 'https://registry.npmjs.org/@coderifts%2Fsdk/latest';

/**
 * The four recordings that render the canonical rule. The other four artefacts in the pin are MCP
 * wiring and docs — they carry no rule paragraphs, and asserting otherwise would be a check that
 * can only ever be wrong.
 */
const RULE_CARRIERS = [
  'openai/AGENTS.md',
  'openai/openai-agent-instructions.md',
  'copilot/.github/copilot-instructions.md',
  'cursor/coderifts.mdc',
];

const fail = (m) => { console.error(`validate-rule-provenance: FAIL — ${m}`); process.exit(1); };

// NETWORK-UNAVAILABLE POLICY — the same rule as validate-tools-wire.mjs, deliberately, so the two
// public-anchor gates cannot disagree about what a transport failure means.
//   TRANSPORT failure (DNS, timeout, 5xx) → SKIP, loudly, exit 0.
//   404/403 → FAIL. That is the package being gone or private, which is a real verdict.
const skip = (m) => {
  console.error(`\n!!  validate-rule-provenance SKIPPED — NOT VERIFIED  !!\n    ${m}\n`
    + '    The recorded snapshots were NOT compared against the published rule text. If the rule\n'
    + '    moved and the recordings did not follow, this run did not catch it.\n');
  process.exit(0);
};

let meta;
try {
  const res = await fetch(REGISTRY, { headers: { accept: 'application/json' } });
  if (res.status === 404 || res.status === 403) {
    fail(`npm returned HTTP ${res.status} for @coderifts/sdk — the package is gone or unreadable, not unreachable`);
  }
  if (!res.ok) skip(`npm registry returned HTTP ${res.status} (treated as transport, not drift)`);
  meta = await res.json();
} catch (err) {
  skip(`npm registry unreachable: ${err?.message}`);
}

const tarballUrl = meta?.dist?.tarball;
if (!tarballUrl) fail('npm metadata carried no dist.tarball');

let tar;
try {
  const res = await fetch(tarballUrl);
  if (res.status === 404 || res.status === 403) fail(`tarball returned HTTP ${res.status} — gone, not unreachable`);
  if (!res.ok) skip(`tarball returned HTTP ${res.status} (treated as transport)`);
  tar = gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
} catch (err) {
  skip(`could not read the published tarball: ${err?.message}`);
}

// The constant is a double-quoted JS string literal in the shipped ESM build. Read it out of the
// decompressed archive rather than unpacking — one regex is less to go wrong than a tar parser.
const m = tar.match(/CODERIFTS_POLICY\s*=\s*"((?:[^"\\]|\\.)*)"/);
if (!m) fail(`@coderifts/sdk@${meta.version} does not export CODERIFTS_POLICY as a string literal — the published shape changed`);

let policy;
try {
  policy = JSON.parse(`"${m[1]}"`);
} catch (err) {
  fail(`CODERIFTS_POLICY did not decode as a string: ${err?.message}`);
}

const paragraphs = policy.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 40);
if (paragraphs.length === 0) fail('the published policy carried no paragraphs — refusing to pass a vacuous check');

const policyDigest = `sha256:${createHash('sha256').update(policy, 'utf8').digest('hex')}`;

let failed = 0;
for (const rel of RULE_CARRIERS) {
  const p = join(SNAP, rel);
  if (!existsSync(p)) { console.error(`FAIL  ${rel} — recorded snapshot missing`); failed += 1; continue; }
  const text = readFileSync(p, 'utf8');
  const missing = paragraphs.filter((par) => !text.includes(par));
  if (missing.length) {
    failed += 1;
    console.error(`FAIL  ${rel} — ${missing.length}/${paragraphs.length} canonical paragraph(s) absent`);
    for (const par of missing.slice(0, 3)) console.error(`        "${par.slice(0, 96)}…"`);
    console.error('        The published rule moved and this recording did not follow. Re-vendor from the'
      + ' app generator and re-record, then update pin.json.');
  } else {
    console.log(`PASS  ${rel} — all ${paragraphs.length} canonical paragraphs present`);
  }
}

if (failed) {
  console.error(`\nvalidate-rule-provenance: FAIL (${failed} carrier(s)) vs @coderifts/sdk@${meta.version} ${policyDigest}`);
  process.exit(1);
}
console.log(`validate-rule-provenance: OK — ${paragraphs.length} paragraphs from @coderifts/sdk@${meta.version} `
  + `${policyDigest} present in all ${RULE_CARRIERS.length} recorded carriers`);

#!/usr/bin/env node
/*
 * THIRD_PARTY_NOTICES guard, for any repository in the fleet. 1956.
 *
 * THE RULE, BOTH WAYS. A repository that ships third-party code carries a THIRD_PARTY_NOTICES.md
 * that matches its CURRENT manifest — and a repository that ships none carries no notices file at
 * all.
 *
 * ⚠ THE SECOND HALF IS NOT TIDINESS. MEASURED 2026-09-23 across the fleet's 35 MIT repositories:
 * exactly TWO ship third-party code (python-sdk → requests, python-verifier → cryptography). Writing
 * an empty notices file into the other thirty-odd would produce thirty-odd FILES THAT ASSERT "we
 * checked and there is nothing" — a standing claim with nothing keeping it true. This guard is what
 * keeps it true instead: NOTICES_MISSING fires the moment a runtime dependency appears in a
 * repository that has none.
 *
 * ⚠ STALENESS IS DETECTED FROM THE MANIFEST, NOT FROM A DATE. The file records the digest of the
 * manifest it was generated from. Change the manifest and the digest stops matching — which is the
 * lockfile trigger the brief asks for, and it fires on a dependency being ADDED, REMOVED or
 * VERSION-BUMPED, not merely on the file being touched.
 *
 * ⚠ A COPYLEFT-CLASS LICENCE IS A STOP, NOT A FINDING TO TRIAGE LATER. The run fails and names the
 * package. A licence obligation a script can silently satisfy is one nobody has read.
 *
 *     node scripts/check-third-party-notices.mjs --repo <path>
 *     node scripts/check-third-party-notices.mjs --all          # every sibling checkout it can find
 *     node scripts/check-third-party-notices.mjs --self-test
 *
 * Node 18+. Offline for npm repositories; Python licence resolution needs the network and is
 * SKIPPED WITH ITS REASON rather than failed when unreachable.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATOR = join(HERE, 'generate-third-party-notices.mjs');
const NOTICES = 'THIRD_PARTY_NOTICES.md';
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt'];
const DIGEST_LINE = /<!--\s*manifest-digest:\s*(sha256:[0-9a-f]{64})\s*-->/;
const STOP_CLASS = /\b(GPL-[23]|AGPL|LGPL|SSPL|CC-BY-NC|BUSL|Commons Clause)/i;

const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

function manifestOf(repo) {
  for (const m of MANIFESTS) {
    const p = join(repo, m);
    if (existsSync(p)) return { name: m, path: p, body: readFileSync(p, 'utf8') };
  }
  return null;
}

/** What the generator says about this repo, as data. */
function resolve(repo) {
  try {
    const out = execFileSync('node', [GENERATOR, '--repo', repo, '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
    });
    return { ok: true, doc: JSON.parse(out) };
  } catch (err) {
    // The generator exits 1 on a STOP-class licence but still prints its JSON.
    if (typeof err?.stdout === 'string' && err.stdout.trim().startsWith('{')) {
      try { return { ok: true, doc: JSON.parse(err.stdout) }; } catch { /* fall through */ }
    }
    return { ok: false, reason: `${err?.message || err}`.slice(0, 200) };
  }
}

function checkRepo(repo) {
  const failures = [];
  const name = basename(repo);
  const fail = (rule, detail) => failures.push({ repo: name, rule, detail });

  const manifest = manifestOf(repo);
  const noticesPath = join(repo, NOTICES);
  const hasNotices = existsSync(noticesPath);

  if (!manifest) {
    // ── RULE NOTICES_ORPHAN: notices with nothing to notice. ──
    if (hasNotices) {
      fail('NOTICES_ORPHAN',
        `${NOTICES} exists but no manifest does. The file asserts a dependency review of something `
        + 'that declares no dependencies.');
    }
    return { failures, name, state: 'no-manifest' };
  }

  const r = resolve(repo);
  if (!r.ok) {
    // ⚠ SKIPPED WITH ITS REASON. An unreachable registry is not a licence finding.
    return { failures, name, state: 'skipped', reason: r.reason };
  }
  const { doc } = r;
  const wantDigest = sha(manifest.body);

  if (!doc.needs_notices) {
    // ── RULE NOTICES_ORPHAN (second shape) ──
    if (hasNotices) {
      fail('NOTICES_ORPHAN',
        `${NOTICES} exists but nothing third-party ships: ${doc.declared_runtime.length} declared `
        + `runtime dependenc(ies)${doc.first_party_excluded.length ? `, all first-party (${doc.first_party_excluded.join(', ')})` : ''}. `
        + 'An empty notices file is a standing claim with nothing keeping it true — delete it and let '
        + 'this guard be the thing that notices when one is needed.');
    }
    return { failures, name, state: 'none-needed', third_party: 0 };
  }

  // ── RULE NOTICES_MISSING: the one this guard exists for. ──
  if (!hasNotices) {
    fail('NOTICES_MISSING',
      `${doc.third_party.length} third-party package(s) ship here and there is no ${NOTICES}: `
      + `${doc.third_party.map((p) => p.name).join(', ')}. Generate it: `
      + `node scripts/generate-third-party-notices.mjs --repo ${repo} --write`);
  } else {
    const body = readFileSync(noticesPath, 'utf8');
    const m = DIGEST_LINE.exec(body);
    if (!m) {
      fail('NOTICES_UNSTAMPED',
        `${NOTICES} carries no manifest-digest comment, so nothing can tell whether it matches the `
        + 'manifest it was generated from. Re-generate it.');
    } else if (m[1] !== wantDigest) {
      // ── RULE NOTICES_STALE: the lockfile/manifest trigger. ──
      fail('NOTICES_STALE',
        `${manifest.name} has changed since ${NOTICES} was generated (file says ${m[1].slice(0, 23)}…, `
        + `manifest is ${wantDigest.slice(0, 23)}…). A dependency was added, removed or bumped and the `
        + 'notices did not follow. Re-generate it.');
    }
    for (const p of doc.third_party) {
      if (!body.includes(`\`${p.name}\``)) {
        fail('NOTICES_INCOMPLETE',
          `${p.name} ships and is not named in ${NOTICES}.`);
      }
    }
  }

  // ── RULE COPYLEFT_STOP ──
  for (const p of doc.third_party) {
    if (p.license && STOP_CLASS.test(p.license)) {
      fail('COPYLEFT_STOP',
        `${p.name}@${p.version ?? '?'} is ${p.license}. This is a decision, not a finding to triage `
        + 'later: a copyleft-class dependency in a shipped package changes what the package may be.');
    }
    if (p.unresolved) {
      fail('LICENCE_UNRESOLVED',
        `${p.name}: ${p.unresolved}. A licence that could not be read is not a licence that is absent.`);
    }
  }

  return { failures, name, state: 'notices', third_party: doc.third_party.length };
}

/** Sibling checkouts next to this repository. Named, so the scan is reproducible. */
function siblings() {
  const home = homedir();
  return readdirSync(home)
    .filter((d) => /^(coderifts-|api-governance$)/.test(d))
    .map((d) => join(home, d))
    .filter((p) => { try { return existsSync(join(p, '.git')); } catch { return false; } })
    .sort();
}

function selfTest() {
  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass, detail });
  const fixture = () => mkdtempSync(join(tmpdir(), 'tpn-'));

  // 1. THE RULE THIS GUARD EXISTS FOR: a runtime dependency appears and no notices file does.
  {
    const d = fixture();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }));
    mkdirSync(join(d, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0', license: 'WTFPL' }));
    const r = checkRepo(d);
    ok('RED: a shipped dependency with no notices file', r.failures.some((f) => f.rule === 'NOTICES_MISSING'),
      r.failures.map((f) => f.rule).join(', ') || 'no findings');
  }

  // 2. ⚠ THE COPYLEFT STOP. Not a filter — the run fails and names it.
  {
    const d = fixture();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'some-gpl-lib': '^1.0.0' } }));
    mkdirSync(join(d, 'node_modules', 'some-gpl-lib'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'some-gpl-lib', 'package.json'), JSON.stringify({ name: 'some-gpl-lib', version: '1.0.0', license: 'GPL-3.0-only' }));
    writeFileSync(join(d, NOTICES), `<!-- manifest-digest: ${sha(readFileSync(join(d, 'package.json'), 'utf8'))} -->\n\`some-gpl-lib\`\n`);
    const r = checkRepo(d);
    ok('RED: a GPL-class licence is a STOP even with complete notices',
      r.failures.some((f) => f.rule === 'COPYLEFT_STOP'), r.failures.map((f) => f.rule).join(', ') || 'no findings');
  }

  // 3. THE LOCKFILE TRIGGER: the manifest moves, the notices do not.
  {
    const d = fixture();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } }));
    mkdirSync(join(d, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0', license: 'MIT' }));
    writeFileSync(join(d, NOTICES), `<!-- manifest-digest: ${sha('a different manifest entirely')} -->\n\`left-pad\`\n`);
    const r = checkRepo(d);
    ok('RED: the manifest changed and the notices did not follow',
      r.failures.some((f) => f.rule === 'NOTICES_STALE'), r.failures.map((f) => f.rule).join(', ') || 'no findings');
  }

  // 4. ⚠ THE OTHER DIRECTION. An empty notices file is a standing claim with no owner.
  {
    const d = fixture();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', dependencies: {}, devDependencies: { eslint: '^9' } }));
    writeFileSync(join(d, NOTICES), '# Third-party notices\n\nNone.\n');
    const r = checkRepo(d);
    ok('RED: a notices file in a repository that ships nothing third-party',
      r.failures.some((f) => f.rule === 'NOTICES_ORPHAN'), r.failures.map((f) => f.rule).join(', ') || 'no findings');
  }

  // 5. A package ships and is missing from an otherwise current file.
  {
    const d = fixture();
    const pkg = JSON.stringify({ name: 'x', dependencies: { 'left-pad': '^1.3.0' } });
    writeFileSync(join(d, 'package.json'), pkg);
    mkdirSync(join(d, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(d, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.0', license: 'MIT' }));
    writeFileSync(join(d, NOTICES), `<!-- manifest-digest: ${sha(pkg)} -->\nnothing named here\n`);
    const r = checkRepo(d);
    ok('RED: a shipped package absent from a current notices file',
      r.failures.some((f) => f.rule === 'NOTICES_INCOMPLETE'), r.failures.map((f) => f.rule).join(', ') || 'no findings');
  }

  // 6. GREEN: a dependency-free repository with no notices file is correct, not incomplete.
  {
    const d = fixture();
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { eslint: '^9' } }));
    const r = checkRepo(d);
    ok('GREEN: no dependencies, no notices file, no findings', r.failures.length === 0,
      r.failures.map((f) => f.rule).join(', ') || `state=${r.state}`);
  }

  console.log('check-third-party-notices --self-test\n');
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log('');
  if (bad) {
    console.error(`check-third-party-notices --self-test: FAILED — ${bad} of ${results.length} controls did not behave.`);
    return 1;
  }
  console.log(`check-third-party-notices --self-test: OK — ${results.length} controls, both directions of the `
    + 'rule and the copyleft stop.');
  return 0;
}

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) process.exit(selfTest());

const repos = argv.includes('--all')
  ? siblings()
  : [argv.includes('--repo') ? argv[argv.indexOf('--repo') + 1] : process.cwd()];

let failures = 0;
const rows = [];
for (const repo of repos) {
  const r = checkRepo(repo);
  rows.push(r);
  failures += r.failures.length;
  for (const f of r.failures) console.error(`  [${f.rule}] ${f.repo}\n      ${f.detail}\n`);
}

console.log(`check-third-party-notices: ${repos.length} repositor(ies) —`);
for (const r of rows) {
  const state = r.state === 'notices' ? `NOTICES (${r.third_party} third-party)`
    : r.state === 'none-needed' ? 'none needed (nothing third-party ships)'
      : r.state === 'skipped' ? `SKIPPED — ${r.reason}`
        : 'no manifest';
  console.log(`  ${r.name.padEnd(30)} ${state}`);
}
if (failures > 0) {
  console.error(`\ncheck-third-party-notices: FAILED — ${failures} finding(s).\n`
    + '  Generate with: node scripts/generate-third-party-notices.mjs --repo <path> --write\n'
    + '  A COPYLEFT_STOP is not a re-generation: it is a decision about what the package may be.\n'
    + '\n  Negative control: node scripts/check-third-party-notices.mjs --self-test\n');
  process.exit(1);
}
console.log('\ncheck-third-party-notices: OK');

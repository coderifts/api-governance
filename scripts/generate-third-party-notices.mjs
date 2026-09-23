#!/usr/bin/env node
/*
 * THIRD_PARTY_NOTICES generator, for any repository in the fleet. 1956.
 *
 * WHAT IT DOES. Resolves the RUNTIME dependency tree of one repository — npm `dependencies` (not
 * devDependencies) or Python `project.dependencies` / requirements.txt — reads each package's
 * licence from its own metadata, and writes a THIRD_PARTY_NOTICES file naming every third-party
 * package that actually ships.
 *
 * ⚠ IT WRITES NOTHING WHERE THERE IS NOTHING TO NOTICE, and that is the design decision, not a
 * shortcut. MEASURED 2026-09-23 across the fleet: api-governance, agent-hooks, gateway-verifier and
 * k8s-admission have ZERO dependencies of any kind; agent-guard and contract-gate have dev
 * dependencies only, and dev dependencies do not ship; conformance has two runtime dependencies and
 * BOTH ARE FIRST-PARTY (@coderifts/agent-guard, @coderifts/sdk). Of the whole fleet, exactly two
 * repositories ship third-party code: python-sdk (requests) and python-verifier (cryptography).
 *
 * An empty THIRD_PARTY_NOTICES in the other thirty-odd repositories would not be compliance. It
 * would be a FILE THAT ASSERTS "we checked and there is nothing" — a claim that has to be true and
 * has to stay true, with nothing keeping it so. The dependency-light design is the real answer, and
 * check-third-party-notices.mjs is what makes it stay the answer: it fails the moment a runtime
 * dependency appears in a repository that has no notices.
 *
 * ⚠ FIRST-PARTY PACKAGES ARE NAMED AND EXCLUDED, never silently dropped. A @coderifts/* dependency
 * is our own code under our own licence; listing it as a third-party notice would be wrong, and
 * dropping it without saying so would hide how the tree was pruned.
 *
 * ⚠ LICENCES ARE READ, NOT ASSUMED. npm licences come from each installed package's own
 * package.json; Python licences from the registry's metadata (license_expression, then license,
 * then the License:: classifiers, in that order). A package whose licence cannot be read is written
 * into the file as UNRESOLVED with its name — never omitted, and never guessed.
 *
 * Usage:
 *   node scripts/generate-third-party-notices.mjs --repo <path> [--write]
 *   node scripts/generate-third-party-notices.mjs --repo <path> --json
 *
 * Node 18+. npm resolution is offline (reads node_modules); Python resolution needs the network.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

const argv = process.argv.slice(2);
const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const REPO = at('--repo');
const WRITE = argv.includes('--write');
const JSON_OUT = argv.includes('--json');
if (!REPO) {
  console.error('usage: generate-third-party-notices.mjs --repo <path> [--write] [--json]');
  process.exit(1);
}
const NOTICES = join(REPO, 'THIRD_PARTY_NOTICES.md');

/** Ours. Named so the pruning is visible in the output rather than implied by an absence. */
const FIRST_PARTY = /^@coderifts\//;

/**
 * Licences we refuse to ship without a human decision.
 *
 * ⚠ THIS IS A STOP, NOT A FILTER. The generator does not drop a GPL-class package and carry on; it
 * writes it into the file, marks it, and the guard fails. A licence obligation that a script can
 * silently satisfy is a licence obligation nobody has read.
 */
const STOP_CLASS = /\b(GPL-[23]|AGPL|LGPL|SSPL|CC-BY-NC|BUSL|Commons Clause)/i;
/** Weak copyleft: shippable, but it is told rather than assumed. */
const NOTE_CLASS = /\b(MPL-2\.0|EPL-[12]\.0|CDDL)/i;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** npm: the RUNTIME closure, resolved from node_modules so the versions are the ones that ship. */
function npmTree(repo) {
  const pkgPath = join(repo, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const pkg = readJson(pkgPath);
  const runtime = Object.keys(pkg.dependencies || {});
  const out = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const dir = join(repo, 'node_modules', ...name.split('/'));
    const mp = join(dir, 'package.json');
    if (!existsSync(mp)) {
      out.push({ name, version: null, license: null, unresolved: 'not installed — run npm install before generating' });
      return;
    }
    const m = readJson(mp);
    const license = m.license || (Array.isArray(m.licenses) ? m.licenses.map((l) => l.type).join(' OR ') : null);
    out.push({
      name,
      version: m.version ?? null,
      license: typeof license === 'string' ? license : (license?.type ?? null),
      first_party: FIRST_PARTY.test(name),
      unresolved: license ? null : 'no license field in the package\'s own package.json',
    });
    for (const d of Object.keys(m.dependencies || {})) visit(d);
  };
  runtime.forEach(visit);
  return {
    ecosystem: 'npm',
    manifest: 'package.json',
    declared_runtime: runtime,
    dev_only: Object.keys(pkg.devDependencies || {}),
    packages: out,
  };
}

/** Python: declared runtime requirements, with licences read from the registry. */
async function pythonTree(repo) {
  const pyproject = join(repo, 'pyproject.toml');
  const reqs = join(repo, 'requirements.txt');
  let declared = [];
  let manifest = null;
  if (existsSync(pyproject)) {
    manifest = 'pyproject.toml';
    const txt = readFileSync(pyproject, 'utf8');
    const block = /(^|\n)dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(txt);
    if (block) declared = [...block[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  } else if (existsSync(reqs)) {
    manifest = 'requirements.txt';
    declared = readFileSync(reqs, 'utf8').split('\n').map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } else {
    return null;
  }

  const nameOf = (spec) => spec.split(/[<>=!~;[\s]/)[0].trim();
  const out = [];
  const seen = new Set();
  const visit = async (spec, marker = null) => {
    const name = nameOf(spec);
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    let info;
    try {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info = (await res.json()).info;
    } catch (err) {
      out.push({ name, version: null, license: null, marker, unresolved: `PyPI metadata unreadable: ${err.message}` });
      return;
    }
    const classifiers = (info.classifiers || []).filter((c) => c.startsWith('License'));
    const license = info.license_expression
      || (typeof info.license === 'string' && info.license.trim() && info.license.trim().length < 60 ? info.license.trim() : null)
      || (classifiers.length ? classifiers.map((c) => c.split('::').pop().trim()).join('; ') : null);
    out.push({
      name,
      version: info.version ?? null,
      license,
      first_party: false,
      marker,
      unresolved: license ? null : 'no license_expression, license or License:: classifier on PyPI',
    });
    // ⚠ ONLY `extra ==` MARKERS ARE SKIPPED, and the first version of this loop got it wrong.
    //
    // It skipped EVERY requirement carrying a `;` marker, on the reasoning that a marker means
    // optional. It does not. `extra == "socks"` is optional — nobody installs it unless they ask.
    // `platform_python_implementation != "PyPy"` and `python_version < "3.13"` are NOT optional:
    // they ship on every platform where the condition holds, which is most of them.
    //
    // MEASURED, and it is why this comment exists: cryptography requires
    // `cffi >=2.0.0; platform_python_implementation != "PyPy"` and
    // `typing-extensions >=4.13.2; python_version < "3.13"`. The first version listed cryptography
    // alone and called the notices complete. The bug hid behind `requests`, whose four transitive
    // dependencies carry no markers at all and so came out right by luck.
    //
    // A conditional dependency is RECORDED WITH ITS CONDITION rather than flattened: a reader who
    // needs to know whether cffi ships on their interpreter can see the marker that decides it.
    for (const r of (info.requires_dist || [])) {
      const marker = r.includes(';') ? r.split(';').slice(1).join(';').trim() : null;
      if (marker && /\bextra\s*==/.test(marker)) continue;
      await visit(r, marker);
    }
  };
  for (const d of declared) await visit(d);
  return { ecosystem: 'python', manifest, declared_runtime: declared, dev_only: [], packages: out };
}

const tree = npmTree(REPO) ?? await pythonTree(REPO);
const repoName = basename(REPO);

if (!tree) {
  const result = { repo: repoName, ecosystem: null, needs_notices: false,
    reason: 'no package.json, pyproject.toml or requirements.txt — nothing declares a dependency here' };
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  else console.log(`${repoName}: no manifest — nothing to notice.`);
  process.exit(0);
}

const thirdParty = tree.packages.filter((p) => !p.first_party);
const stop = thirdParty.filter((p) => p.license && STOP_CLASS.test(p.license));
const note = thirdParty.filter((p) => p.license && NOTE_CLASS.test(p.license));
const unresolved = thirdParty.filter((p) => p.unresolved);
const firstParty = tree.packages.filter((p) => p.first_party);

const result = {
  repo: repoName,
  ecosystem: tree.ecosystem,
  manifest: tree.manifest,
  declared_runtime: tree.declared_runtime,
  dev_only_count: tree.dev_only.length,
  first_party_excluded: firstParty.map((p) => p.name),
  third_party: thirdParty,
  needs_notices: thirdParty.length > 0,
  stop_class: stop.map((p) => `${p.name} (${p.license})`),
  note_class: note.map((p) => `${p.name} (${p.license})`),
  unresolved: unresolved.map((p) => `${p.name}: ${p.unresolved}`),
};

if (JSON_OUT) { console.log(JSON.stringify(result, null, 2)); process.exit(stop.length ? 1 : 0); }

if (!result.needs_notices) {
  console.log(`${repoName}: ${tree.ecosystem}, ${tree.declared_runtime.length} declared runtime `
    + `dependenc(ies)${firstParty.length ? `, all ${firstParty.length} first-party (${firstParty.map((p) => p.name).join(', ')})` : ''}`
    + `, ${tree.dev_only.length} dev-only. NO third-party code ships — no notices file written.`);
  console.log('  (An empty THIRD_PARTY_NOTICES would assert "we checked and there is nothing", which is a\n'
    + '   claim needing an owner. check-third-party-notices.mjs is that owner: it fails the moment a\n'
    + '   runtime dependency appears here.)');
  process.exit(0);
}

const lines = [
  `# Third-party notices — ${repoName}`,
  '',
  '<!-- GENERATED by api-governance scripts/generate-third-party-notices.mjs. Do not hand-edit:',
  '     run the generator. The list below is the RUNTIME closure — dev dependencies do not ship. -->',
  // ⚠ THE STALENESS TRIGGER. check-third-party-notices.mjs compares this to the manifest on disk, so
  // a dependency ADDED, REMOVED or VERSION-BUMPED makes this file red — not merely touching it, and
  // not the passage of time. A date would have said when it was written; this says what it describes.
  `<!-- manifest-digest: sha256:${createHash('sha256').update(readFileSync(join(REPO, tree.manifest), 'utf8')).digest('hex')} -->`,
  '',
  `This package ships the third-party code listed below. Resolved from \`${tree.manifest}\` on `
  + `${new Date().toISOString().slice(0, 10)}; each licence is read from that package's own metadata, `
  + 'never assumed.',
  '',
  ...(firstParty.length ? [
    `First-party dependencies are excluded by name rather than silently pruned: ${firstParty.map((p) => `\`${p.name}\``).join(', ')} `
    + 'are CodeRifts packages under the CodeRifts licence.', ''] : []),
  '| Package | Version | Licence | Ships when |',
  '|---|---|---|---|',
  ...thirdParty.map((p) => `| \`${p.name}\` | ${p.version ?? '—'} | ${p.license ?? `**UNRESOLVED** — ${p.unresolved}`} | ${p.marker ? `\`${p.marker}\`` : 'always'} |`),
  '',
  ...(stop.length ? [
    '## ⚠ STOP — copyleft-class licence present', '',
    'The following require a decision before this package ships:', '',
    ...stop.map((p) => `- \`${p.name}\` — ${p.license}`), ''] : []),
  ...(note.length ? [
    '## Weak-copyleft, shipped as-is', '',
    ...note.map((p) => `- \`${p.name}\` — ${p.license}. File-level copyleft; used unmodified.`), ''] : []),
  ...(unresolved.length ? [
    '## Unresolved', '',
    'Named rather than omitted — a licence that could not be read is not a licence that is absent:', '',
    ...unresolved.map((p) => `- \`${p.name}\`: ${p.unresolved}`), ''] : []),
  '## What this file does not say', '',
  '- It does not reproduce the licence texts. It names the package, version and licence so each can be',
  '  fetched from its own source of truth; a pasted copy is one more thing that goes stale.',
  '- It does not cover development dependencies, which do not ship.',
  '- It is generated from the declared runtime closure. A dependency pulled in at runtime by other',
  '  means would not appear here, and nothing in this repository does that.',
  '- The **Ships when** column carries the environment marker verbatim where there is one. A marked',
  '  package still ships wherever its condition holds — only `extra ==` requirements are optional,',
  '  and those are excluded.',
  '',
];
const body = `${lines.join('\n')}`;

if (WRITE) {
  writeFileSync(NOTICES, body, 'utf8');
  console.log(`Wrote ${NOTICES} — ${thirdParty.length} third-party package(s)`);
} else {
  console.log(body);
}
if (stop.length) {
  console.error(`\n⚠ STOP: ${stop.length} copyleft-class licence(s) — ${result.stop_class.join(', ')}`);
  process.exit(1);
}

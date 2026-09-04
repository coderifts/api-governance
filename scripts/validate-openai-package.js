#!/usr/bin/env node
'use strict';

/**
 * Validate the Codex/OpenAI api-governance-openai package for internal consistency.
 *
 * Checks:
 *   1. .codex-plugin/plugin.json parses + required fields (measured plugin-json-spec)
 *   2. .mcp.json parses + points at the live Streamable HTTP endpoint
 *   3. Tool names advertised in skills/.../SKILL.md match generated mcp.json exactly
 *      (exactly 3: preflight_change_set, verify_receipt, get_decision_details)
 *   4. AGENTS.md is byte-identical to agent-setup / generate-agent-host-files output
 *   5. openai-agent-instructions.md is byte-identical to the same generator
 *   6. marketplace entry points at this plugin path
 *
 * Usage (from api-governance repo root or anywhere):
 *   node scripts/validate-openai-package.js
 *   node /path/to/api-governance/scripts/validate-openai-package.js
 *
 * Env:
 *   CODERIFTS_APP_ROOT  — path to coderifts-app (default: ~/coderifts-app)
 *   API_GOVERNANCE_ROOT — path to this repo (default: dirname of script / ..)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const rec = require('../lib/recorded-app-generator');

const ROOT = process.env.API_GOVERNANCE_ROOT
  ? path.resolve(process.env.API_GOVERNANCE_ROOT)
  : path.resolve(__dirname, '..');
const APP = process.env.CODERIFTS_APP_ROOT
  ? path.resolve(process.env.CODERIFTS_APP_ROOT)
  : path.join(process.env.HOME || '', 'coderifts-app');

const PKG = path.join(ROOT, 'plugins', 'api-governance-openai');
const CANONICAL_TOOLS = [
  'preflight_change_set',
  'verify_receipt',
  'get_decision_details',
];
const MCP_URL = 'https://app.coderifts.com/mcp';

let failed = 0;
function ok(label, detail) {
  console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`);
}
function fail(label, detail) {
  failed += 1;
  console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    fail(label, `missing ${p}`);
    return false;
  }
  return true;
}

// ── 1. Manifest ──────────────────────────────────────────────────────────────
const pluginJsonPath = path.join(PKG, '.codex-plugin', 'plugin.json');
if (mustExist(pluginJsonPath, 'plugin.json exists')) {
  try {
    const pj = readJson(pluginJsonPath);
    const required = ['name', 'version', 'description', 'skills', 'mcpServers', 'interface'];
    const missing = required.filter((k) => pj[k] == null || pj[k] === '');
    if (missing.length) fail('plugin.json required fields', missing.join(', '));
    else ok('plugin.json parses + required fields', `name=${pj.name} version=${pj.version}`);
    if (pj.name !== 'api-governance-openai') {
      fail('plugin.json name', `expected api-governance-openai got ${pj.name}`);
    } else {
      ok('plugin.json name matches folder', pj.name);
    }
    if (pj.mcpServers !== './.mcp.json') {
      fail('plugin.json mcpServers path', String(pj.mcpServers));
    } else {
      ok('plugin.json mcpServers → ./.mcp.json');
    }
    if (pj.skills !== './skills/') {
      fail('plugin.json skills path', String(pj.skills));
    } else {
      ok('plugin.json skills → ./skills/');
    }
  } catch (e) {
    fail('plugin.json parse', e.message);
  }
}

// ── 2. MCP wiring ────────────────────────────────────────────────────────────
const mcpPath = path.join(PKG, '.mcp.json');
if (mustExist(mcpPath, '.mcp.json exists')) {
  try {
    const mcp = readJson(mcpPath);
    const servers = mcp.mcpServers || {};
    const keys = Object.keys(servers);
    if (keys.length !== 1) fail('.mcp.json server count', `expected 1 got ${keys.length}: ${keys}`);
    else ok('.mcp.json single server entry', keys[0]);
    const s = servers.coderifts || servers[keys[0]];
    if (!s || s.url !== MCP_URL) fail('.mcp.json url', s && s.url);
    else ok('.mcp.json url', MCP_URL);
    if (s && s.type && s.type !== 'http') fail('.mcp.json type', s.type);
    else if (s) ok('.mcp.json type', s.type || '(absent; url-only also seen in Claude package docs)');
  } catch (e) {
    fail('.mcp.json parse', e.message);
  }
}

// ── 3. Tool parity vs generated mcp.json ─────────────────────────────────────
const registryMcp = path.join(ROOT, 'mcp.json');
if (mustExist(registryMcp, 'repo mcp.json exists')) {
  const reg = readJson(registryMcp);
  const regNames = (reg.tools || []).map((t) => t.name);
  if (JSON.stringify(regNames) !== JSON.stringify(CANONICAL_TOOLS)) {
    fail('mcp.json tool set', JSON.stringify(regNames));
  } else {
    ok('mcp.json has exactly 3 canonical tools', regNames.join(', '));
  }

  const skillPath = path.join(PKG, 'skills', 'api-governance', 'SKILL.md');
  if (mustExist(skillPath, 'SKILL.md exists')) {
    const skill = fs.readFileSync(skillPath, 'utf8');
    const advertised = [];
    for (const name of CANONICAL_TOOLS) {
      // bold tool name form used in package skill body
      if (skill.includes(`**${name}**`)) advertised.push(name);
    }
    if (JSON.stringify(advertised) !== JSON.stringify(CANONICAL_TOOLS)) {
      fail('SKILL.md tool names', JSON.stringify(advertised));
    } else {
      ok('SKILL.md advertises exact 3 tool names', advertised.join(', '));
    }
    // No fourth tool: scan for bold tool-like identifiers that are not the three
    const boldTools = [...skill.matchAll(/\*\*([a-z][a-z0-9_]{2,})\*\*/g)].map((m) => m[1]);
    const extras = [...new Set(boldTools)].filter(
      (n) => n.includes('_') && !CANONICAL_TOOLS.includes(n),
    );
    if (extras.length) fail('SKILL.md extra tool-like names', extras.join(', '));
    else ok('SKILL.md no extra snake_case tool names');
  }
}

// ── 4–5. AGENTS.md + openai-agent-instructions empty-diff vs regeneration ────
// LIVE when the generator exists; RECORDED against the vendored snapshot otherwise.
let openaiPin;
try {
  openaiPin = rec.loadPin();
} catch (e) {
  fail('RECORDED snapshot', e.message);
}
const genScript = path.join(APP, 'scripts', 'generate-agent-host-files.js');
const openaiLive = fs.existsSync(genScript);
if (openaiLive) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cr-agent-host-'));
  const r = spawnSync(process.execPath, [genScript, '--out', tmp], {
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'silent' },
  });
  if (r.status !== 0) {
    fail('regenerate agent-host files', (r.stderr || r.stdout || '').slice(0, 400));
  } else {
    ok('regenerated agent-host files', `${tmp} ${rec.modeBanner('LIVE')}`);
    for (const rel of ['AGENTS.md', 'openai-agent-instructions.md']) {
      const pkgFile = path.join(PKG, rel);
      const genFile = path.join(tmp, rel);
      const snapRel = `openai/${rel}`;
      if (!mustExist(pkgFile, `${rel} in package`)) continue;
      if (!mustExist(genFile, `${rel} regenerated`)) continue;
      const a = fs.readFileSync(pkgFile);
      const b = fs.readFileSync(genFile);
      if (!a.equals(b)) {
        fail(`${rel} empty-diff vs regeneration`, `byte length pkg=${a.length} gen=${b.length}`);
      } else {
        ok(`${rel} empty-diff vs agent-setup generation`, `${a.length} bytes ${rec.modeBanner('LIVE')}`);
      }
      if (openaiPin) {
        const snap = rec.snapshotBytes(snapRel);
        if (!snap.equals(b)) {
          fail(
            `RECORDED snapshot STALE vs live generation (${rel})`,
            'regenerate fixtures/recorded/app-generator/openai from coderifts-app',
          );
        }
      }
    }
  }
} else if (openaiPin) {
  ok('app generator absent — comparing package files to RECORDED snapshot', rec.modeBanner('RECORDED'));
  for (const rel of ['AGENTS.md', 'openai-agent-instructions.md']) {
    const pkgFile = path.join(PKG, rel);
    if (!mustExist(pkgFile, `${rel} in package`)) continue;
    const a = fs.readFileSync(pkgFile);
    const snap = rec.snapshotBytes(`openai/${rel}`);
    if (!a.equals(snap)) {
      fail(`${rel} empty-diff vs RECORDED snapshot`, rec.snapshotPath(`openai/${rel}`));
    } else {
      ok(`${rel} empty-diff vs RECORDED snapshot`, `${a.length} bytes ${rec.modeBanner('RECORDED')}`);
    }
  }
}

// ── 6. Marketplace ───────────────────────────────────────────────────────────
const marketPath = path.join(ROOT, '.agents', 'plugins', 'marketplace.json');
if (mustExist(marketPath, 'marketplace.json exists')) {
  try {
    const m = readJson(marketPath);
    const entry = (m.plugins || []).find((p) => p.name === 'api-governance-openai');
    if (!entry) fail('marketplace entry', 'api-governance-openai missing');
    else {
      ok('marketplace entry present', entry.name);
      const pth = entry.source && entry.source.path;
      if (pth !== './plugins/api-governance-openai') {
        fail('marketplace source.path', String(pth));
      } else {
        ok('marketplace source.path', pth);
      }
      if (!entry.policy || !entry.policy.installation || !entry.policy.authentication) {
        fail('marketplace policy fields', JSON.stringify(entry.policy));
      } else {
        ok('marketplace policy', `${entry.policy.installation}/${entry.policy.authentication}`);
      }
    }
  } catch (e) {
    fail('marketplace.json parse', e.message);
  }
}

// ── Claude package untouched invariant (optional soft check) ─────────────────
const claudeSkill = path.join(ROOT, 'plugins', 'api-governance', 'skills', 'api-governance', 'SKILL.md');
if (fs.existsSync(claudeSkill)) {
  ok('Claude plugin still present (untouched path)', 'plugins/api-governance/…');
}

// ── 7. Production pattern (ID108) + offline smoke script ─────────────────────
const recipePath = path.join(PKG, 'docs', 'openai-production-pattern.md');
if (mustExist(recipePath, 'openai-production-pattern.md exists')) {
  const body = fs.readFileSync(recipePath, 'utf8');
  if (!body.includes('executeOpenAIToolCall')) {
    fail('production pattern names executeOpenAIToolCall', 'missing dispatcher face');
  } else {
    ok('production pattern documents executeOpenAIToolCall');
  }
  if (!body.includes('calls_outside_guarded_path_invisible') && !body.includes('outside the guarded table')) {
    fail('production pattern LIMITS / table honesty', 'missing guarded-table honesty line');
  } else {
    ok('production pattern states guarded-table honesty');
  }
}

const smokePath = path.join(PKG, 'scripts', 'smoke-execute-openai-tool-call.mjs');
if (mustExist(smokePath, 'smoke-execute-openai-tool-call.mjs exists')) {
  const smoke = fs.readFileSync(smokePath, 'utf8');
  if (!smoke.includes('executeOpenAIToolCall')) {
    fail('smoke uses executeOpenAIToolCall', 'missing');
  } else {
    ok('smoke script references executeOpenAIToolCall');
  }
}

console.log('');
if (failed) {
  console.log(`RESULT: FAIL (${failed} check(s)) ${rec.modeBanner(openaiLive ? 'LIVE' : 'RECORDED')}`);
  process.exit(1);
}
console.log(`RESULT: ALL PASS ${rec.modeBanner(openaiLive ? 'LIVE' : 'RECORDED')}`);
process.exit(0);

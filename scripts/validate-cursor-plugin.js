#!/usr/bin/env node
'use strict';

/**
 * Validate the Cursor api-governance-cursor package.
 *
 * Manifest fields are the closed set from
 * https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json
 * (required: name; additionalProperties: false).
 *
 * Env:
 *   CODERIFTS_APP_ROOT      — coderifts-app (default: ~/coderifts-app). When present,
 *                             the generated-rule check is LIVE. When absent, RECORDED
 *                             against fixtures/recorded/app-generator (weaker, named).
 *   CODERIFTS_WEBSITE_DIR   — coderifts-website (default: ~/coderifts-website)
 *   API_GOVERNANCE_ROOT     — this repo (default: dirname(script)/..)
 */

const fs = require('fs');
const path = require('path');
const rec = require('../lib/recorded-app-generator');

const ROOT = process.env.API_GOVERNANCE_ROOT
  ? path.resolve(process.env.API_GOVERNANCE_ROOT)
  : path.resolve(__dirname, '..');
const APP = process.env.CODERIFTS_APP_ROOT
  ? path.resolve(process.env.CODERIFTS_APP_ROOT)
  : path.join(process.env.HOME || '', 'coderifts-app');
const WEBSITE = process.env.CODERIFTS_WEBSITE_DIR
  ? path.resolve(process.env.CODERIFTS_WEBSITE_DIR)
  : path.join(process.env.HOME || '', 'coderifts-website');

const PKG = path.join(ROOT, 'plugins', 'api-governance-cursor');
const CANONICAL_TOOLS = [
  'preflight_change_set',
  'verify_receipt',
  'get_decision_details',
];
const MCP_URL = 'https://app.coderifts.com/mcp';
const PLUGIN_NAME = 'coderifts-api-governance';
const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const ALLOWED_KEYS = new Set([
  'name', 'displayName', 'description', 'version', 'minClientVersions',
  'author', 'publisher', 'homepage', 'repository', 'license', 'logo',
  'keywords', 'category', 'tags', 'commands', 'agents', 'skills', 'rules',
  'hooks', 'variables', 'mcpServers',
]);
const AUTHOR_KEYS = new Set(['name', 'email']);

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

function noDotDot(rel, label) {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('..')) {
    fail(label, `path must be relative and contain no ..: ${rel}`);
    return false;
  }
  return true;
}

// ── 1. Manifest (Cursor schema) ─────────────────────────────────────────────
const pluginJsonPath = path.join(PKG, '.cursor-plugin', 'plugin.json');
let pj = null;
if (mustExist(pluginJsonPath, '.cursor-plugin/plugin.json exists')) {
  try {
    pj = readJson(pluginJsonPath);
    const extra = Object.keys(pj).filter((k) => !ALLOWED_KEYS.has(k));
    if (extra.length) fail('plugin.json additionalProperties', extra.join(', '));
    else ok('plugin.json keys ⊆ Cursor schema', Object.keys(pj).join(', '));

    if (typeof pj.name !== 'string' || !NAME_RE.test(pj.name)) {
      fail('plugin.json name', String(pj.name));
    } else if (pj.name !== PLUGIN_NAME) {
      fail('plugin.json name', `expected ${PLUGIN_NAME} got ${pj.name}`);
    } else {
      ok('plugin.json name', pj.name);
    }

    if (!pj.author || typeof pj.author.name !== 'string' || !pj.author.name) {
      fail('plugin.json author.name', 'required when author is present');
    } else {
      const aExtra = Object.keys(pj.author).filter((k) => !AUTHOR_KEYS.has(k));
      if (aExtra.length) fail('plugin.json author extra keys', aExtra.join(', '));
      else ok('plugin.json author', `${pj.author.name} <${pj.author.email || ''}>`);
    }

    if (pj.skills !== './skills/') fail('plugin.json skills', String(pj.skills));
    else ok('plugin.json skills → ./skills/');
    if (pj.rules !== './rules/') fail('plugin.json rules', String(pj.rules));
    else ok('plugin.json rules → ./rules/');
    if (pj.hooks !== './hooks/hooks.json') fail('plugin.json hooks', String(pj.hooks));
    else ok('plugin.json hooks → ./hooks/hooks.json');
    if (pj.mcpServers !== './mcp.json') fail('plugin.json mcpServers', String(pj.mcpServers));
    else ok('plugin.json mcpServers → ./mcp.json');

    ['skills', 'rules', 'hooks', 'mcpServers', 'logo'].forEach((k) => {
      if (pj[k]) noDotDot(pj[k], `plugin.json ${k} path`);
    });

    if (!pj.variables || pj.variables.type !== 'object') {
      fail('plugin.json variables.type', 'must be object');
    } else if (!pj.variables.properties || !pj.variables.properties.CODERIFTS_API_KEY) {
      fail('plugin.json variables', 'CODERIFTS_API_KEY missing');
    } else {
      ok('plugin.json variables declares CODERIFTS_API_KEY');
    }

    if (typeof pj.description !== 'string' || !/deterministic/i.test(pj.description) || !/fail-closed/i.test(pj.description)) {
      fail('plugin.json description differentiator', 'must state deterministic + fail-closed vs AI scan');
    } else {
      ok('plugin.json description carries deterministic/fail-closed differentiator');
    }
  } catch (e) {
    fail('plugin.json parse', e.message);
  }
}

// ── 2. MCP wiring (Cursor mcp.json, not the website tool card) ───────────────
const mcpPath = path.join(PKG, 'mcp.json');
if (mustExist(mcpPath, 'mcp.json exists')) {
  try {
    const mcp = readJson(mcpPath);
    if (mcp.schema_version || mcp.tools) {
      fail('mcp.json shape', 'looks like the website tool-card, not Cursor mcpServers');
    }
    const server = (mcp.mcpServers || {}).coderifts;
    if (!server) fail('mcp.json mcpServers.coderifts', 'missing');
    else if (server.url !== MCP_URL) fail('mcp.json url', String(server.url));
    else if (!String((server.headers || {}).Authorization || '').includes('${CODERIFTS_API_KEY}')) {
      fail('mcp.json Authorization', 'must use ${CODERIFTS_API_KEY} placeholder');
    } else {
      ok('mcp.json hosted Streamable HTTP', MCP_URL);
    }
  } catch (e) {
    fail('mcp.json parse', e.message);
  }
}

// ── 3. Skill + tools ────────────────────────────────────────────────────────
const skillPath = path.join(PKG, 'skills', 'coderifts-api-governance', 'SKILL.md');
if (mustExist(skillPath, 'SKILL.md exists')) {
  const text = fs.readFileSync(skillPath, 'utf8');
  if (!text.startsWith('---\n')) fail('SKILL.md frontmatter', 'missing ---');
  else ok('SKILL.md has YAML frontmatter');
  if (!/^name:\s*coderifts-api-governance\s*$/m.test(text)) {
    fail('SKILL.md name', 'expected coderifts-api-governance');
  } else {
    ok('SKILL.md name', PLUGIN_NAME);
  }
  const missingTools = CANONICAL_TOOLS.filter((t) => !text.includes(t));
  if (missingTools.length) fail('SKILL.md tools', missingTools.join(', '));
  else ok('SKILL.md names the three canonical tools');
}

// ── 4. Rule ─────────────────────────────────────────────────────────────────
const rulePath = path.join(PKG, 'rules', 'coderifts.mdc');
if (mustExist(rulePath, 'rules/coderifts.mdc exists')) {
  const text = fs.readFileSync(rulePath, 'utf8');
  if (!text.includes('alwaysApply: true')) fail('rule frontmatter', 'alwaysApply missing');
  else ok('rule frontmatter alwaysApply: true');
  if (!text.includes('execution_action')) fail('rule body', 'execution_action missing');
  else ok('rule body carries execution_action');
}

// ── 5. Hooks adapter → existing 912 CLI ─────────────────────────────────────
const hooksPath = path.join(PKG, 'hooks', 'hooks.json');
if (mustExist(hooksPath, 'hooks/hooks.json exists')) {
  try {
    const hooks = readJson(hooksPath);
    const pre = (((hooks.hooks || {}).preToolUse) || [])[0];
    if (!pre || typeof pre.command !== 'string' || !pre.command.includes('coderifts') || !pre.command.includes('claude-hook')) {
      fail('hooks.json preToolUse', 'must invoke coderifts claude-hook');
    } else {
      ok('hooks.json preToolUse → coderifts claude-hook', pre.command);
    }
  } catch (e) {
    fail('hooks.json parse', e.message);
  }
}

// ── 6. Marketplace entry ────────────────────────────────────────────────────
const marketPath = path.join(ROOT, '.cursor-plugin', 'marketplace.json');
if (mustExist(marketPath, '.cursor-plugin/marketplace.json exists')) {
  try {
    const m = readJson(marketPath);
    const extraTop = Object.keys(m).filter((k) => !['name', 'owner', 'metadata', 'plugins'].includes(k));
    if (extraTop.length) fail('marketplace extra keys', extraTop.join(', '));
    const entry = (m.plugins || []).find((p) => p.name === PLUGIN_NAME);
    if (!entry) fail('marketplace plugins', `no ${PLUGIN_NAME}`);
    else if (entry.source !== 'plugins/api-governance-cursor') {
      fail('marketplace source', String(entry.source));
    } else {
      ok('marketplace lists plugin', `${entry.name} ← ${entry.source}`);
    }
  } catch (e) {
    fail('marketplace.json parse', e.message);
  }
}

// ── 7. Drift vs canonical sources (when checkouts exist) ────────────────────
const websiteSkill = path.join(WEBSITE, '.well-known', 'agent-skills', 'coderifts-api-governance', 'SKILL.md');
if (fs.existsSync(websiteSkill) && fs.existsSync(skillPath)) {
  const a = fs.readFileSync(websiteSkill);
  const b = fs.readFileSync(skillPath);
  if (!a.equals(b)) fail('SKILL.md drift vs website well-known', websiteSkill);
  else ok('SKILL.md byte-identical to website well-known');
} else {
  ok('SKILL.md website drift skipped (no CODERIFTS_WEBSITE_DIR)');
}

const generatedRule = path.join(APP, 'generated', 'agent-host', '.cursor', 'rules', 'coderifts.mdc');
let pin;
try {
  pin = rec.loadPin();
} catch (e) {
  fail('RECORDED snapshot', e.message);
  pin = null;
}
const cursorLive = fs.existsSync(generatedRule);
if (pin && fs.existsSync(rulePath)) {
  const kitBytes = fs.readFileSync(rulePath);
  const snapBytes = rec.snapshotBytes('cursor/coderifts.mdc');
  if (cursorLive) {
    const liveBytes = fs.readFileSync(generatedRule);
    if (!kitBytes.equals(liveBytes)) {
      fail('rules/coderifts.mdc drift vs generated agent-host', generatedRule);
    } else {
      ok('rules/coderifts.mdc byte-identical to generated/agent-host', rec.modeBanner('LIVE'));
    }
    if (!snapBytes.equals(liveBytes)) {
      fail(
        'RECORDED snapshot STALE vs live generated rule',
        'regenerate fixtures/recorded/app-generator/cursor/coderifts.mdc from coderifts-app',
      );
    } else {
      ok('RECORDED cursor rule matches live generated', rec.modeBanner('LIVE'));
    }
  } else {
    if (!kitBytes.equals(snapBytes)) {
      fail('rules/coderifts.mdc drift vs RECORDED snapshot', rec.snapshotPath('cursor/coderifts.mdc'));
    } else {
      ok('rules/coderifts.mdc byte-identical to RECORDED snapshot', rec.modeBanner('RECORDED'));
    }
  }
}

const inRepoLicense = path.join(PKG, 'LICENSE');
const inRepoLogo = path.join(PKG, 'assets', 'logo.png');
if (mustExist(inRepoLicense, 'LICENSE')) ok('LICENSE resolves');
if (mustExist(inRepoLogo, 'assets/logo.png')) ok('logo resolves');

if (failed) {
  console.log(`\nvalidate-cursor-plugin: ${failed} failure(s) ${rec.modeBanner(cursorLive ? 'LIVE' : 'RECORDED')}`);
  process.exit(1);
}
console.log(`\nvalidate-cursor-plugin: GREEN ${rec.modeBanner(cursorLive ? 'LIVE' : 'RECORDED')}`);

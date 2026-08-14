#!/usr/bin/env node
'use strict';

/**
 * Validate the api-governance/copilot/ kit: vendored GENERATED files stay
 * byte-identical to coderifts-app generator output, and 3-tool discipline holds.
 *
 * Pattern sibling of scripts/validate-openai-package.js (CODERIFTS_APP_ROOT env).
 *
 * Usage:
 *   node scripts/validate-copilot-kit.js
 *   CODERIFTS_APP_ROOT=/path/to/coderifts-app node scripts/validate-copilot-kit.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.API_GOVERNANCE_ROOT
  ? path.resolve(process.env.API_GOVERNANCE_ROOT)
  : path.resolve(__dirname, '..');
const APP = process.env.CODERIFTS_APP_ROOT
  ? path.resolve(process.env.CODERIFTS_APP_ROOT)
  : path.join(process.env.HOME || '', 'coderifts-app');

const KIT = path.join(ROOT, 'copilot');
const CANONICAL_TOOLS = [
  'preflight_change_set',
  'verify_receipt',
  'get_decision_details',
];
const MCP_URL = 'https://app.coderifts.com/mcp';

/** Paths under copilot/ → relative path under coderifts-app generated/ */
const VENDORED = [
  {
    kit: '.vscode/mcp.json',
    app: 'generated/copilot-mcp/.vscode/mcp.json',
    generator: 'scripts/generate-copilot-mcp.js',
  },
  {
    kit: 'copilot-cloud-agent-mcp.json',
    app: 'generated/copilot-mcp/copilot-cloud-agent-mcp.json',
    generator: 'scripts/generate-copilot-mcp.js',
  },
  {
    kit: 'copilot-custom-agent-mcp.frontmatter.md',
    app: 'generated/copilot-mcp/copilot-custom-agent-mcp.frontmatter.md',
    generator: 'scripts/generate-copilot-mcp.js',
  },
  {
    kit: 'docs/copilot-mcp.md',
    app: 'generated/copilot-mcp/docs/copilot-mcp.md',
    generator: 'scripts/generate-copilot-mcp.js',
  },
  {
    kit: '.github/copilot-instructions.md',
    app: 'generated/agent-host/.github/copilot-instructions.md',
    generator: 'scripts/generate-agent-host-files.js',
  },
];

let failed = 0;
function ok(label, detail) {
  console.log(`PASS  ${label}${detail ? ' — ' + detail : ''}`);
}
function fail(label, detail) {
  failed += 1;
  console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`);
}

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    fail(label, `missing ${p}`);
    return false;
  }
  return true;
}

function extractToolsFromJson(obj, acc = new Set()) {
  if (obj == null) return acc;
  if (Array.isArray(obj)) {
    // tools: ["preflight_change_set", ...] or tools: [{name: ...}]
    for (const el of obj) {
      if (typeof el === 'string' && /^[a-z][a-z0-9_]+$/.test(el) && el.includes('_')) {
        acc.add(el);
      } else if (el && typeof el === 'object') {
        extractToolsFromJson(el, acc);
      }
    }
    return acc;
  }
  if (typeof obj === 'object') {
    if (Array.isArray(obj.tools)) {
      for (const t of obj.tools) {
        if (typeof t === 'string') {
          // allow "coderifts/preflight_change_set" prefix form
          const bare = t.includes('/') ? t.split('/').pop() : t;
          if (bare && bare.includes('_')) acc.add(bare);
        } else if (t && typeof t.name === 'string') {
          acc.add(t.name);
        }
      }
    }
    for (const v of Object.values(obj)) extractToolsFromJson(v, acc);
  }
  return acc;
}

function extractToolsFromText(text) {
  const found = new Set();
  for (const name of CANONICAL_TOOLS) {
    if (text.includes(name)) found.add(name);
  }
  // Extra snake_case tool-like tokens that look like MCP tool names (heuristic)
  const re = /\b([a-z][a-z0-9]+(?:_[a-z0-9]+)+)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1];
    // Ignore common non-tool tokens
    if (
      tok === 'mcp_servers' ||
      tok === 'execution_action' ||
      tok === 'safe_for_agent' ||
      tok === 'decision_id' ||
      tok === 'base_to' ||
      tok === 'tools_list' ||
      tok.startsWith('copilot_') ||
      tok.includes('coderifts_api')
    ) {
      continue;
    }
    // Only flag if it looks like a peer of the three (verb_noun tool pattern with 2+ underscores or known aliases)
    if (tok.includes('_') && tok.length > 8 && !CANONICAL_TOOLS.includes(tok)) {
      // Known non-tool snake tokens in the docs
      const allow = new Set([
        'preflight_mode',
        'analysis_outcome',
        'may_execute',
        'chain_receipt',
        'not_permission_fail_closed',
        'monitoring_sink',
        'input_fingerprint',
        'verdict_fingerprint',
        'body_hash',
        'format_version',
        'schema_version',
        'prompt_string',
        'mcp_manifest',
        'agent_tools',
        'tool_call',
        'change_set',
        'server_info',
        'json_rpc',
        'text_event',
        'streamable_http',
        'api_key',
        'decision_result',
        'currently_authorized',
        'execution_action',
        'safe_for_agent',
      ]);
      if (!allow.has(tok) && /^(get|verify|preflight|list|authorize|analyze|submit|create|update|delete)_/.test(tok)) {
        found.add(tok);
      }
    }
  }
  return found;
}

// ── Kit present ──────────────────────────────────────────────────────────────
if (!mustExist(KIT, 'copilot/ kit directory')) {
  console.log('RESULT: FAIL');
  process.exit(1);
}
ok('copilot/ kit present', KIT);

// ── Generators --check (optional soft signal) + byte-identity ────────────────
const genCopilot = path.join(APP, 'scripts', 'generate-copilot-mcp.js');
const genHost = path.join(APP, 'scripts', 'generate-agent-host-files.js');
if (!mustExist(genCopilot, 'generate-copilot-mcp.js') || !mustExist(genHost, 'generate-agent-host-files.js')) {
  console.log('RESULT: FAIL (need CODERIFTS_APP_ROOT)');
  process.exit(1);
}

// Prefer comparing to a fresh regeneration in a temp dir (empty-diff vs live generator),
// matching validate-openai-package.js AGENTS.md check — not only on-disk generated/.
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-copilot-kit-'));
const r1 = spawnSync(process.execPath, [genCopilot, '--out', tmp], {
  encoding: 'utf8',
  env: { ...process.env, LOG_LEVEL: 'silent' },
});
if (r1.status !== 0) {
  fail('regenerate copilot-mcp', (r1.stderr || r1.stdout || '').slice(0, 500));
} else {
  ok('regenerated copilot-mcp into temp', tmp);
}

const tmpHost = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-agent-host-'));
const r2 = spawnSync(process.execPath, [genHost, '--out', tmpHost], {
  encoding: 'utf8',
  env: { ...process.env, LOG_LEVEL: 'silent' },
});
if (r2.status !== 0) {
  fail('regenerate agent-host', (r2.stderr || r2.stdout || '').slice(0, 500));
} else {
  ok('regenerated agent-host into temp', tmpHost);
}

// Map kit path → fresh regenerated path
function freshPath(entry) {
  if (entry.generator.includes('copilot')) {
    // generate-copilot-mcp --out writes the same relative layout as generated/copilot-mcp/
    return path.join(tmp, entry.kit);
  }
  // agent-host: FORMAT_PATHS copilot_instructions → .github/copilot-instructions.md
  return path.join(tmpHost, '.github/copilot-instructions.md');
}

for (const entry of VENDORED) {
  const kitFile = path.join(KIT, entry.kit);
  if (!mustExist(kitFile, `kit ${entry.kit}`)) continue;
  const fresh = freshPath(entry);
  // copilot generator --out layout: may nest under outDir directly with same rel paths
  let compareTo = fresh;
  if (!fs.existsSync(compareTo) && entry.generator.includes('copilot')) {
    // Some generators write under outDir with paths relative to generated/copilot-mcp root
    compareTo = path.join(tmp, entry.kit);
  }
  if (!fs.existsSync(compareTo)) {
    // Fall back to app on-disk generated/ (still single-source artifact)
    compareTo = path.join(APP, entry.app);
  }
  if (!mustExist(compareTo, `source for ${entry.kit}`)) continue;
  const a = fs.readFileSync(kitFile);
  const b = fs.readFileSync(compareTo);
  if (!a.equals(b)) {
    fail(`${entry.kit} empty-diff`, `kit=${a.length} source=${b.length} (${compareTo})`);
  } else {
    ok(`${entry.kit} empty-diff vs generation`, `${a.length} bytes`);
  }
}

// ── 3-tool discipline ────────────────────────────────────────────────────────
const cloudPath = path.join(KIT, 'copilot-cloud-agent-mcp.json');
if (fs.existsSync(cloudPath)) {
  try {
    const j = JSON.parse(fs.readFileSync(cloudPath, 'utf8'));
    if (!j.mcpServers) fail('cloud config root key', 'expected mcpServers');
    else ok('cloud config root key mcpServers');
    const tools = j.mcpServers.coderifts && j.mcpServers.coderifts.tools;
    if (!Array.isArray(tools) || JSON.stringify(tools) !== JSON.stringify(CANONICAL_TOOLS)) {
      fail('cloud config tools allowlist', JSON.stringify(tools));
    } else {
      ok('cloud config tools exactly 3 canonical', tools.join(', '));
    }
    const url = j.mcpServers.coderifts && j.mcpServers.coderifts.url;
    if (url !== MCP_URL) fail('cloud config url', String(url));
    else ok('cloud config url', MCP_URL);
  } catch (e) {
    fail('cloud config parse', e.message);
  }
}

const vscodePath = path.join(KIT, '.vscode/mcp.json');
if (fs.existsSync(vscodePath)) {
  try {
    const j = JSON.parse(fs.readFileSync(vscodePath, 'utf8'));
    if (!j.servers) fail('vscode config root key', 'expected servers');
    else ok('vscode config root key servers');
    if (j.mcpServers) fail('vscode config must not use mcpServers root', 'trap');
    else ok('vscode config no mcpServers root (servers-vs-mcpServers discipline)');
    const url = j.servers.coderifts && j.servers.coderifts.url;
    if (url !== MCP_URL) fail('vscode config url', String(url));
    else ok('vscode config url', MCP_URL);
  } catch (e) {
    fail('vscode config parse', e.message);
  }
}

const fmPath = path.join(KIT, 'copilot-custom-agent-mcp.frontmatter.md');
if (fs.existsSync(fmPath)) {
  const text = fs.readFileSync(fmPath, 'utf8');
  for (const name of CANONICAL_TOOLS) {
    if (!text.includes(name)) fail('frontmatter includes tool', name);
  }
  if (
    text.includes('preflight_change_set')
    && text.includes('verify_receipt')
    && text.includes('get_decision_details')
  ) {
    ok('frontmatter lists all 3 canonical tools');
  }
  // tools: allowlist in YAML
  const toolsBlock = text.match(/tools:\s*\n((?:\s+-\s+\S+\n)+)/);
  if (toolsBlock) {
    const listed = [...toolsBlock[1].matchAll(/-\s+(\S+)/g)].map((m) => m[1]);
    if (JSON.stringify(listed) !== JSON.stringify(CANONICAL_TOOLS)) {
      fail('frontmatter mcp-servers tools list', JSON.stringify(listed));
    } else {
      ok('frontmatter mcp-servers tools exactly 3', listed.join(', '));
    }
  }
}

const docsPath = path.join(KIT, 'docs/copilot-mcp.md');
if (fs.existsSync(docsPath)) {
  const text = fs.readFileSync(docsPath, 'utf8');
  for (const name of CANONICAL_TOOLS) {
    if (!text.includes('`' + name + '`') && !text.includes(name)) {
      fail('docs mentions tool', name);
    }
  }
  ok('docs/copilot-mcp.md mentions all 3 tools');
  if (!text.includes('servers-vs-mcpServers') && !text.includes('servers-vs-mcpServers trap') && !text.includes('**`servers`**')) {
    // table uses servers / mcpServers
    if (!text.includes('`servers`') || !text.includes('`mcpServers`')) {
      fail('docs servers-vs-mcpServers table', 'missing root-key callouts');
    } else ok('docs documents servers vs mcpServers');
  } else {
    ok('docs documents servers-vs-mcpServers trap');
  }
}

const instrPath = path.join(KIT, '.github/copilot-instructions.md');
if (fs.existsSync(instrPath)) {
  const text = fs.readFileSync(instrPath, 'utf8');
  if (!text.includes('GENERATED')) fail('copilot-instructions GENERATED header', 'missing');
  else ok('copilot-instructions keeps GENERATED header');
  for (const name of CANONICAL_TOOLS) {
    if (!text.includes(name)) fail('copilot-instructions tool', name);
  }
  ok('copilot-instructions names all 3 tools');
}

// SOURCE.md present (packaging provenance, not generated)
if (mustExist(path.join(KIT, 'SOURCE.md'), 'SOURCE.md provenance')) {
  ok('SOURCE.md present');
}

// Claude / Codex packages untouched (soft)
if (fs.existsSync(path.join(ROOT, 'plugins', 'api-governance', '.mcp.json'))) {
  ok('Claude plugin tree still present');
}
if (fs.existsSync(path.join(ROOT, 'plugins', 'api-governance-openai', '.codex-plugin', 'plugin.json'))) {
  ok('Codex package tree still present');
}

console.log('');
if (failed) {
  console.log(`RESULT: FAIL (${failed} check(s))`);
  process.exit(1);
}
console.log('RESULT: ALL PASS');
process.exit(0);

'use strict';

/*
 * The plugin hooks fail closed (2026-09-29, plugins101).
 *
 * Measured: of the three plugins only the Cursor one carries a hook config, and it said
 * `failClosed: false` — Cursor's documented default, under which a crashed or unreachable hook ALLOWS
 * the write (the cursor.directory scan finding). It also ran `claude-hook` on `Write|Edit`, where
 * `Edit` is not a Cursor tool and `Delete` went ungated. Now it is the shape coderifts-app's
 * agent-host generator already ships (src/cursor-hook-settings.js): `coderifts cursor-hook`,
 * `Write|Delete`, timeout 60, failClosed true — with `npx --yes`, because a plugin user has no
 * global CLI.
 *
 * The Claude and Codex plugins carry NO hook config: the Claude carrier deliberately never shipped one
 * (coderifts-app scripts/lib/marketplace-carrier.js, "THE HOOKS ARE NOT MIRRORED"), and adding a hook
 * to either is a behaviour change, not this guard's business. Held here: every hook config a plugin
 * ships is fail-closed and identical, and that set is exactly the Cursor one until someone decides
 * otherwise.
 *
 * 2026-10-03 (CC-2 T2/T3, Claude plugin 1.2.0) — that decision was made for the Claude carrier: it
 * now ships a MOD (hooks/register.js, a function hooks module generated from coderifts-app
 * agent/hooks/register.js) under a hooks.json that names the module and carries NO command hook.
 * A module is not a command hook config, so the fail-closed rule above does not read it; the mod's
 * own refusal on error and timeout is tested in coderifts-app (agent/mod-tests). Held here: the
 * Claude carrier's hook file is exactly that one module, and it never grows a command hook.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLUGINS = ['api-governance', 'api-governance-cursor', 'api-governance-openai'];

const EXPECTED = {
  version: 1,
  hooks: {
    preToolUse: [
      { command: 'npx --yes coderifts cursor-hook', matcher: 'Write|Delete', timeout: 60, failClosed: true },
    ],
  },
};

function hookFiles() {
  return PLUGINS
    .map((p) => [p, path.join(ROOT, 'plugins', p, 'hooks', 'hooks.json')])
    .filter(([, f]) => fs.existsSync(f))
    .map(([p, f]) => [p, JSON.parse(fs.readFileSync(f, 'utf8'))]);
}

/** The command-hook configs: a hooks.json that carries `hooks`, not only `modules`. */
function hookConfigs() {
  return hookFiles().filter(([, cfg]) => cfg.hooks !== undefined);
}

test('⚠⚠ every hook config a plugin ships is fail-closed', () => {
  for (const [p, cfg] of hookConfigs()) {
    for (const [event, entries] of Object.entries(cfg.hooks || {})) {
      for (const e of entries) assert.equal(e.failClosed, true, `${p} ${event} ${e.command}: failClosed is ${e.failClosed}`);
    }
  }
});

test('⚠ the hook configs are identical, and are the cursor-hook shape', () => {
  const cfgs = hookConfigs();
  assert.ok(cfgs.length > 0, 'no plugin ships a hook config');
  for (const [p, cfg] of cfgs) assert.deepEqual(cfg, EXPECTED, `${p} hook config`);
});

test('the set of plugins with a hook is the Cursor one — a new hook is a decision, not drift', () => {
  assert.deepEqual(hookConfigs().map(([p]) => p), ['api-governance-cursor']);
});

test('⚠ the Claude carrier ships the CodeRifts mod and no command hook', () => {
  const files = Object.fromEntries(hookFiles());
  const claude = files['api-governance'];
  assert.ok(claude, 'the Claude carrier ships no hooks/hooks.json');
  assert.deepEqual(Object.keys(claude).sort(), ['description', 'modules']);
  assert.deepEqual(claude.modules, ['./register.js']);
  assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'api-governance', 'hooks', 'register.js')), 'the module it names is missing');
  assert.equal(files['api-governance-openai'], undefined, 'the Codex carrier grew a hook file');
});

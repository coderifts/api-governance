'use strict';

/**
 * 1374 — RECORDED fallback for the app-generator drift gates.
 *
 * Bite 1: clean-room (no coderifts-app) exits 0 in RECORDED mode.
 * Bite 2: LIVE still catches a real kit drift when the app checkout exists.
 * Bite 3: a corrupt vendored snapshot exits 1 — no silent skip.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const rec = require('../lib/recorded-app-generator');

function run(script, extraEnv) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function cleanRoomEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ag-home-'));
  const env = { ...process.env, HOME: home };
  delete env.CODERIFTS_APP_ROOT;
  delete env.CODERIFTS_WEBSITE_DIR;
  return { home, env };
}

describe('1374 — clean-room RECORDED (no coderifts-app)', () => {
  it('validate-copilot-kit exits 0 and prints [RECORDED — weaker than LIVE]', () => {
    const { env } = cleanRoomEnv();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-copilot-kit.js')], {
      encoding: 'utf8',
      env,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[RECORDED — weaker than LIVE\]/);
    assert.equal(/\[LIVE\]/.test(r.stdout), false);
  });

  it('validate-cursor-plugin exits 0 and prints [RECORDED — weaker than LIVE]', () => {
    const { env } = cleanRoomEnv();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-cursor-plugin.js')], {
      encoding: 'utf8',
      env,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[RECORDED — weaker than LIVE\]/);
    assert.equal(/rule generated drift skipped/.test(r.stdout), false);
  });

  it('clean-room validator chain exits 0 (RECORDED) — the npm test body without this file', () => {
    const { env } = cleanRoomEnv();
    const chain = spawnSync(
      process.execPath,
      ['-e', `
        const {spawnSync}=require('child_process');
        const scripts=['validate-openai-package.js','validate-copilot-kit.js','validate-cursor-plugin.js','validate-tools-wire.mjs'];
        for (const s of scripts) {
          const r=spawnSync(process.execPath,['scripts/'+s],{encoding:'utf8',env:process.env,cwd:${JSON.stringify(ROOT)}});
          process.stdout.write(r.stdout||'');
          process.stderr.write(r.stderr||'');
          if (r.status!==0) process.exit(r.status||1);
        }
      `],
      { encoding: 'utf8', env, cwd: ROOT },
    );
    assert.equal(chain.status, 0, chain.stdout + chain.stderr);
    assert.match(chain.stdout, /\[RECORDED — weaker than LIVE\]/);
  });
});

describe('1374 — LIVE still catches a real drift', () => {
  it('cursor LIVE fails when the published rule is mutated', (t) => {
    const generated = path.join(rec.appRoot(), 'generated', 'agent-host', '.cursor', 'rules', 'coderifts.mdc');
    if (!fs.existsSync(generated)) {
      t.skip('no coderifts-app generated rule — LIVE bite needs the app');
      return;
    }
    const rule = path.join(ROOT, 'plugins', 'api-governance-cursor', 'rules', 'coderifts.mdc');
    const orig = fs.readFileSync(rule);
    try {
      fs.writeFileSync(rule, Buffer.concat([orig, Buffer.from('\n# drift-bite\n')]));
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-cursor-plugin.js')], {
        encoding: 'utf8',
        env: process.env,
      });
      assert.notEqual(r.status, 0, 'LIVE must fail on a mutated rule');
      assert.match(r.stdout + r.stderr, /drift vs generated|empty-diff|FAIL/);
    } finally {
      fs.writeFileSync(rule, orig);
    }
  });
});

describe('1374 — corrupt snapshot exits 1', () => {
  it('pin mismatch on cursor rule snapshot is FAIL, not skip', () => {
    const snap = rec.snapshotPath('cursor/coderifts.mdc');
    const orig = fs.readFileSync(snap);
    try {
      fs.writeFileSync(snap, Buffer.from('CORRUPT-SNAPSHOT\n'));
      const { env } = cleanRoomEnv();
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-cursor-plugin.js')], {
        encoding: 'utf8',
        env,
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /corrupt|STALE_RECORDED|RECORDED snapshot/);
      assert.equal(/rule generated drift skipped/.test(r.stdout), false);
    } finally {
      fs.writeFileSync(snap, orig);
    }
  });

  it('missing pin.json exits 1', () => {
    const pin = rec.PIN_PATH;
    const orig = fs.readFileSync(pin);
    try {
      fs.rmSync(pin);
      const { env } = cleanRoomEnv();
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validate-copilot-kit.js')], {
        encoding: 'utf8',
        env,
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /RECORDED snapshot missing/);
    } finally {
      fs.writeFileSync(pin, orig);
    }
  });
});

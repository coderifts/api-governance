/**
 * LIVE vs RECORDED expected generator output (1374 / 1127 pattern).
 *
 * LIVE  — coderifts-app checkout present: compare against live generator /
 *         generated/ output, AND fail if this recording is stale.
 * RECORDED — no checkout: compare against the vendored snapshot. Missing or
 *         corrupt snapshot exits 1 — no skip. RECORDED cannot see a snapshot
 *         that fell behind its source; validate-rule-provenance.mjs covers
 *         that, against a public anchor, so RECORDED is narrow, not blind.
 *
 * @module api-governance/lib/recorded-app-generator
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.API_GOVERNANCE_ROOT
  ? path.resolve(process.env.API_GOVERNANCE_ROOT)
  : path.resolve(__dirname, '..');
const SNAP_DIR = path.join(ROOT, 'fixtures', 'recorded', 'app-generator');
const PIN_PATH = path.join(SNAP_DIR, 'pin.json');

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function appRoot() {
  return process.env.CODERIFTS_APP_ROOT
    ? path.resolve(process.env.CODERIFTS_APP_ROOT)
    : path.join(process.env.HOME || '', 'coderifts-app');
}

function generatorsPresent() {
  const root = appRoot();
  return fs.existsSync(path.join(root, 'scripts', 'generate-copilot-mcp.js'))
    && fs.existsSync(path.join(root, 'scripts', 'generate-agent-host-files.js'));
}

function loadPin() {
  if (!fs.existsSync(PIN_PATH)) {
    const err = new Error(
      `RECORDED snapshot missing at ${PIN_PATH}. `
      + 'Reporting a comparison that did not happen is worse than failing. '
      + 'Restore fixtures/recorded/app-generator/.',
    );
    err.code = 'NO_RECORDED';
    throw err;
  }
  const pin = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
  if (!Array.isArray(pin.artifacts) || pin.artifacts.length === 0) {
    const err = new Error('RECORDED pin has no artifacts — refusing to skip');
    err.code = 'NO_RECORDED';
    throw err;
  }
  for (const a of pin.artifacts) {
    const p = path.join(SNAP_DIR, a.path);
    if (!fs.existsSync(p)) {
      const err = new Error(
        `RECORDED snapshot missing ${a.path} at ${p}. `
        + 'Reporting a comparison that did not happen is worse than failing.',
      );
      err.code = 'NO_RECORDED';
      throw err;
    }
    const got = sha256hex(fs.readFileSync(p));
    if (got !== a.sha256) {
      const err = new Error(
        `RECORDED snapshot corrupt ${a.path}: pin ${a.sha256} bytes ${got}`,
      );
      err.code = 'STALE_RECORDED';
      throw err;
    }
  }
  return pin;
}

function snapshotPath(rel) {
  return path.join(SNAP_DIR, rel);
}

function snapshotBytes(rel) {
  return fs.readFileSync(snapshotPath(rel));
}

/**
 * The banner says what the run could check and what it could not — a pass that does not name its
 * own blind spot reads as a stronger claim than it is, which is how two carriers sat 268 bytes
 * behind the canonical rule through eight consecutive green scheduled runs.
 *
 * RECORDED does verify something real: the kit is byte-identical to the recording. What it cannot
 * do without the (private) app checkout is re-derive the generator's output, so a recording that
 * has fallen behind its source still matches a kit that fell behind with it. That blind spot is
 * covered by a SEPARATE public gate — validate-rule-provenance.mjs holds the recordings to the
 * rule text published in @coderifts/sdk. The banner names it so that removing one gate cannot
 * quietly widen the other.
 */
function modeBanner(mode) {
  return mode === 'LIVE'
    ? '[LIVE]'
    : '[RECORDED — kit matches the recording; generator output not re-derived. '
      + 'The recording is held to the published rule by validate:rule-provenance]';
}

module.exports = {
  ROOT,
  SNAP_DIR,
  PIN_PATH,
  sha256hex,
  appRoot,
  generatorsPresent,
  loadPin,
  snapshotPath,
  snapshotBytes,
  modeBanner,
};

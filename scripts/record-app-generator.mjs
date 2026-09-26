#!/usr/bin/env node
/**
 * Re-record fixtures/recorded/app-generator from the two coderifts-app generators.
 *
 *   node scripts/generate-copilot-mcp.js
 *   node scripts/generate-agent-host-files.js
 *
 * Default generator output (the app's generated/ tree) is the source. Each pin
 * artifact is copied from its app_path into the fixture path, then sha256 and
 * bytes are rewritten. producer.commit is `git -C <app> rev-parse HEAD`.
 *
 * The bytes are whatever those generators emit from the working tree. The pin's
 * does_not_prove already says a later checkout can differ. This script does not
 * publish the kits; the validators compare those separately.
 *
 * No staging outside this process: the generators write their own default trees.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env.CODERIFTS_APP_ROOT
  ? resolve(process.env.CODERIFTS_APP_ROOT)
  : join(process.env.HOME || '', 'coderifts-app');
const SNAP = join(ROOT, 'fixtures', 'recorded', 'app-generator');
const PIN_PATH = join(SNAP, 'pin.json');

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'silent' },
  });
  if (r.status !== 0) {
    process.stderr.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    process.stderr.write(`record-app-generator: ${cmd} ${args.join(' ')} exited ${r.status}\n`);
    process.exit(r.status || 1);
  }
  return (r.stdout || '').trim();
}

const pin = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
if (!Array.isArray(pin.artifacts) || pin.artifacts.length === 0) {
  process.stderr.write('record-app-generator: pin has no artifacts\n');
  process.exit(1);
}

run(process.execPath, [join(APP, 'scripts', 'generate-copilot-mcp.js')], APP);
run(process.execPath, [join(APP, 'scripts', 'generate-agent-host-files.js')], APP);

const commit = run('git', ['-C', APP, 'rev-parse', 'HEAD'], ROOT);
pin.producer.commit = commit;

for (const artifact of pin.artifacts) {
  if (typeof artifact.app_path !== 'string' || typeof artifact.path !== 'string') {
    process.stderr.write('record-app-generator: artifact missing path or app_path\n');
    process.exit(1);
  }
  const src = join(APP, artifact.app_path);
  if (!existsSync(src)) {
    process.stderr.write(`record-app-generator: generator did not write ${artifact.app_path}\n`);
    process.exit(1);
  }
  const buf = readFileSync(src);
  const dest = join(SNAP, artifact.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  artifact.sha256 = createHash('sha256').update(buf).digest('hex');
  artifact.bytes = buf.length;
}

writeFileSync(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`);
process.stdout.write(`recorded ${pin.artifacts.length} artifacts at ${commit}\n`);

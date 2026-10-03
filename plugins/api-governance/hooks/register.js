// CodeRifts mod: blast-radius, for API contracts (2026-10-03, CC-2 T2).
//
// tool.call (Write / Edit / MultiEdit): when the call touches a contract file (named in
// .coderifts.yml `schema:`, or matching the contract patterns), it sends the before/after text to
// CodeRifts preflight and holds the call until the answer is in:
//   authorize (CODERIFTS_API_KEY set)  CONTINUE / CONTINUE_WITH_MONITORING → next(e); anything else
//                                      refuses the call
//   analyze   (no key)                 NO_BREAK_DETECTED → next(e); anything else refuses the call
// Its own deadline (8 s, inside the 10 s a hook has) and its .catch both REFUSE: an error, a
// timeout or an answer it cannot read never lets the edit through.
//
// ui.render (AbovePrompt): one band with the last decision and the receipt digest, on the
// terminal and the Desktop app. Where neither draws, the same line goes to the transcript.
//
// What this mod does not prove, and what it leaves to the required check, is in README.md
// ("What this mod does not prove") and in the does_not_prove list below, word for word.
//
// Generated into the plugin by scripts/generate-claude-package.js. Edit this file, not the copy.

const API_BASE = 'https://app.coderifts.com';
const DEADLINE_MS = 8000;
const TIMED_OUT = Object.freeze({ timedOut: true });
const ALLOW_ACTIONS = Object.freeze(['CONTINUE', 'CONTINUE_WITH_MONITORING']);
const MERGE_GATE = 'The merge gate is the required CodeRifts check on the pull request.';

export const DOES_NOT_PROVE = Object.freeze([
  'Installed as a mod, the user can approve the call with another mod, and disableAllHooks or --safe-mode turns it off.',
  'A managed mod is final for the tool calls it sees. A shell command that writes a contract file or reaches an API through Bash is covered only as far as the mod inspects Bash; the required check is the guarantee.',
]);

// The last decision, for the band. null until the first contract call.
let last = null;

export function register(on) {
  on('tool.call', { tool: ['Write', 'Edit', 'MultiEdit'] }, async ($, e, next) => {
    const cwd = await $.session.cwd();
    const filePath = String(e.file_path ?? '');
    const rel = relativeTo(cwd, filePath);
    const named = parseSchemaList(await readOrNull($, joinPath(cwd, '.coderifts.yml')));
    if (!named.includes(rel) && !looksLikeContractPath(rel)) {
      return next(e);
    }

    const before = (await readOrNull($, filePath)) ?? '';
    const after = applyCall(e, before);
    if (after === null) {
      return refuse($, rel, 'the edit could not be applied to the file as it is on disk, so there is no after text to check', null);
    }

    const key = await $.env.get('CODERIFTS_API_KEY');
    const base = String((await $.env.get('CODERIFTS_API_BASE')) || API_BASE).replace(/\/$/, '');
    const mode = key ? 'authorize' : 'analyze';
    const body = {
      preflight_mode: mode,
      artifacts: [{ id: 'api', type: artifactType(rel), before, after }],
      ...(mode === 'authorize' ? { context: { operation: 'merge', environment: 'staging' } } : {}),
    };
    const headers = { 'content-type': 'application/json', accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };

    const answer = await Promise.race([
      $.http.fetch(`${base}/api/v1/preflight`, { method: 'POST', headers, body: JSON.stringify(body) }),
      $.clock.sleep(DEADLINE_MS).then(() => TIMED_OUT),
    ]);
    if (answer === TIMED_OUT) {
      return refuse($, rel, `CodeRifts did not answer within ${DEADLINE_MS / 1000} s`, null);
    }
    const verdict = readVerdict(mode, answer);
    const digest = await receiptDigest(verdict.receipt);
    if (!verdict.allow) {
      return refuse($, rel, verdict.why, digest, verdict.label);
    }
    await show($, `CodeRifts · ${verdict.label} · ${rel}${digest ? ` · receipt ${shortDigest(digest)}` : ''}`, { label: verdict.label, digest, rel });
    return next(e);
  }).catch(($, e, next) => ({
    deny: next.called
      ? `CodeRifts mod failed after the ${e.tool} call ran (${next.error.kind}); treat the change as unchecked. ${MERGE_GATE}`
      : `CodeRifts did not check this ${e.tool} (${next.error.kind}: ${String(next.error.message).slice(0, 120)}), so it was refused. Retry the edit; ${MERGE_GATE}`,
  }));

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (last === null) {
      return next(e);
    }
    const { Box, Text } = $.ui.resolve(e);
    const color = last.refused ? 'red' : 'green';
    return Box({
      flexDirection: 'row',
      children: [
        Text({ key: 'mark', color, bold: true, children: last.refused ? '✗ CodeRifts ' : '✓ CodeRifts ' }),
        Text({ key: 'line', children: `${last.label} · ${last.rel}`, wrap: 'truncate-end' }),
        last.digest ? Text({ key: 'digest', dimColor: true, children: ` · receipt ${shortDigest(last.digest)}` }) : null,
      ],
    });
  });
}

// ---- deciding --------------------------------------------------------------

/** What the preflight answer means for this call. Anything unreadable refuses. */
export function readVerdict(mode, answer) {
  let doc = null;
  try {
    doc = JSON.parse(answer.text);
  } catch {
    return { allow: false, label: `HTTP ${answer.status}`, why: `CodeRifts answered HTTP ${answer.status} with no readable decision` };
  }
  if (!answer.ok) {
    const msg = doc && (doc.message || doc.error);
    return { allow: false, label: `HTTP ${answer.status}`, why: `CodeRifts answered HTTP ${answer.status}${msg ? ` (${String(msg).slice(0, 160)})` : ''}` };
  }
  const dr = doc && typeof doc.decision_result === 'object' && doc.decision_result !== null ? doc.decision_result : {};
  const breaks = breakSummary(doc);
  if (mode === 'analyze') {
    const outcome = doc && doc.analysis_outcome;
    return outcome === 'NO_BREAK_DETECTED'
      ? { allow: true, label: 'analyze: no break (not an authorization)', receipt: null }
      : { allow: false, label: `analyze: ${outcome || 'no outcome'}`, why: `the change ${breaks || `was analysed as ${outcome || 'unknown'}`}` };
  }
  const action = dr.execution_action || (doc && doc.execution_action) || null;
  const receipt = dr.receipt && typeof dr.receipt.token === 'string' ? dr.receipt.token : null;
  if (ALLOW_ACTIONS.includes(action)) {
    return { allow: true, label: action, receipt };
  }
  return { allow: false, label: action || 'no execution_action', receipt, why: `CodeRifts decided ${action || 'nothing it names'}${breaks ? `: the change ${breaks}` : ''}` };
}

/** "breaks 2 things: path.remove /a, …" or ''. */
function breakSummary(doc) {
  const list = doc && Array.isArray(doc.breaking_changes_details) ? doc.breaking_changes_details : [];
  if (list.length === 0) return '';
  const named = list.slice(0, 3).map((b) => `${b.type || 'change'} ${b.path || ''}`.trim()).join(', ');
  return `breaks ${list.length} ${list.length === 1 ? 'thing' : 'things'}: ${named}${list.length > 3 ? ', …' : ''}`;
}

async function refuse($, rel, why, digest, label = 'refused') {
  await show($, `CodeRifts refused · ${rel} · ${why}${digest ? ` · receipt ${shortDigest(digest)}` : ''}`, { label, digest, rel, refused: true });
  return { deny: `CodeRifts refused this edit of ${rel}: ${why}. Next step: change the contract so it does not break its consumers, or get the change authorized (coderifts.preflight_change_set with preflight_mode=authorize). ${MERGE_GATE}` };
}

/** The band where the terminal or the Desktop app draws, one transcript line everywhere else. */
async function show($, line, state) {
  last = { refused: false, ...state };
  const surfaces = await $.session.surfaces();
  if (surfaces.includes('terminal') || surfaces.includes('desktop')) {
    $.ui.invalidate('ui.render');
  } else {
    await $.ui.log(line);
  }
}

// ---- the files -------------------------------------------------------------

async function readOrNull($, path) {
  try {
    const text = await $.fs.read(path);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** The file's text after this call, or null when the call does not apply to `before`. */
export function applyCall(e, before) {
  if (e.tool === 'Write') return String(e.content ?? '');
  const edits = e.tool === 'MultiEdit' ? (Array.isArray(e.edits) ? e.edits : []) : [e];
  let text = before;
  for (const edit of edits) {
    const from = String(edit.old_string ?? '');
    const to = String(edit.new_string ?? '');
    if (from === '') {
      if (text !== '') return null;
      text = to;
    } else if (!text.includes(from)) {
      return null;
    } else {
      text = edit.replace_all ? text.split(from).join(to) : text.replace(from, () => to);
    }
  }
  return text;
}

/** Mirrors the plugin's early guard and @coderifts/contract-path looksLikeContractPath. */
export function looksLikeContractPath(p) {
  const s = String(p || '').toLowerCase();
  if (s.includes('node_modules/') || s.includes('vendor/')) return false;
  return /\.(ya?ml|json|graphql|gql|proto)$/.test(s) && (s.includes('openapi') || s.includes('swagger') || s.includes('asyncapi')
    || s.endsWith('.graphql') || s.endsWith('.gql') || s.endsWith('.proto') || s.includes('mcp'));
}

export function artifactType(p) {
  const s = String(p).toLowerCase();
  if (s.endsWith('.graphql') || s.endsWith('.gql')) return 'graphql';
  if (s.endsWith('.proto')) return 'grpc';
  if (s.includes('asyncapi')) return 'asyncapi';
  if (s.includes('mcp')) return 'mcp_manifest';
  return 'openapi';
}

/** The `schema:` list of a .coderifts.yml, block or flow form. Nothing else is read. */
export function parseSchemaList(yml) {
  if (!yml) return [];
  const clean = (v) => v.trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
  const lines = String(yml).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^schema:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[1].replace(/\s+#.*$/, '').trim();
    if (rest.startsWith('[')) {
      return rest.replace(/^\[|\]$/g, '').split(',').map(clean).filter(Boolean);
    }
    const out = [];
    for (let j = i + 1; j < lines.length && /^\s+-\s+|^\s*$|^\s+#/.test(lines[j]); j += 1) {
      const item = /^\s+-\s+(.+)$/.exec(lines[j]);
      if (item) out.push(clean(item[1].replace(/\s+#.*$/, '')));
    }
    return out;
  }
  return [];
}

function joinPath(dir, name) {
  return `${String(dir).replace(/\/$/, '')}/${name}`;
}

function relativeTo(cwd, filePath) {
  const root = `${String(cwd).replace(/\/$/, '')}/`;
  return filePath.startsWith(root) ? filePath.slice(root.length) : filePath.replace(/^\.\//, '');
}

// ---- the receipt -----------------------------------------------------------

async function receiptDigest(token) {
  if (!token) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return `sha256:${[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function shortDigest(d) {
  return `${d.slice(0, 19)}…`;
}

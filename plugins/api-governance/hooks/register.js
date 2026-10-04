// CodeRifts mod: blast-radius, for API contracts (2026-10-03, CC-2 T2).
//
// tool.call (Write / Edit / MultiEdit): when the call touches a contract file (named in
// .coderifts.yml `schema:`, or matching the contract patterns), it sends the before/after text to
// CodeRifts preflight and holds the call until the answer is in:
//   authorize (the api_key option set)  CONTINUE / CONTINUE_WITH_MONITORING → next(e); anything else
//                                       refuses the call
//   analyze   (no key)                  NO_BREAK_DETECTED → next(e); anything else refuses the call
// It contacts one address, https://app.coderifts.com/api/v1/preflight, written at the call.
// Its own deadline (8 s, inside the 10 s a hook has) and its .catch both REFUSE: an error, a
// timeout or an answer it cannot read never lets the edit through.
//
// ui.render (AbovePrompt): one band with this turn's decisions and the receipt digest, on the
// terminal and the Desktop app. Where neither draws, each decision is one transcript line.
//
// 1.2.1 (2026-10-03): a refusal holds the band for the rest of its turn. Measured on 1.2.0: Claude
// sent two Edits of one file in one turn; the mod refused the breaking one (STOP) and allowed the
// other (an example value, CONTINUE), and the band showed only the last one — "✓ CONTINUE" over a
// refused change. Now the band leads with the refusal and counts both.
//
// 1.2.2 (2026-10-03, the Claude directory review): the key is the plugin's `api_key` option
// (userConfig, sensitive), read from register's second parameter — no environment variable is read
// any more, and the address is a fixed literal. The band and the transcript line carry the
// decision_id, so the receipt this mod saw can be fetched (get_decision_details) and verified.
//
// What this mod does not prove, and what it leaves to the required check, is in README.md
// ("What this mod does not prove") and in the does_not_prove list below, word for word.
//
// 2026-10-03 (CC-2 T2): which call touches a contract file is decided by contract-write.mjs, the
// one decision function agent-hooks and `coderifts claude-hook` run too (a copy of
// @coderifts/contract-path's, written by scripts/generate-contract-write-copies.js). With it the
// mod reads Bash: a shell command that writes a named contract file is refused, with a pointer to
// Write/Edit; one that can reach a directory holding a contract without naming it asks (tool.check).
//
// Generated into the plugin by scripts/generate-claude-package.js. Edit this file, not the copy.

import { afterText, decideToolCall } from './contract-write.mjs';

const DEADLINE_MS = 8000;
const TIMED_OUT = Object.freeze({ timedOut: true });
const ALLOW_ACTIONS = Object.freeze(['CONTINUE', 'CONTINUE_WITH_MONITORING']);
const MERGE_GATE = 'The merge gate is the required CodeRifts check on the pull request.';

// GOVERNANCE_UNAVAILABLE (2026-10-04): the one sentence the App, the CLI hook and agent-hooks write
// verbatim when CodeRifts could not decide. The call is still refused; the sentence says why.
function governanceUnavailable(why) {
  return `GOVERNANCE_UNAVAILABLE: CodeRifts could not decide (${why}); this is not a finding about your change.`;
}

export const DOES_NOT_PROVE = Object.freeze([
  'Installed as a mod, it is one of the mods the user installed: a mod that runs before it can answer or rewrite the call, or what this mod reads, so it never sees the change; disableAllHooks in any settings file (the .claude/settings.json of the project included), --safe-mode or --bare turns it off.',
  'Only an organization mod (installed in place from a marketplace directory the administrator owns, and enabled in managed settings) runs before the mods users install and keeps its refusal for the calls it sees; installed from its GitHub marketplace this plugin never counts as one, and --safe-mode or three crashes of the hooks worker unload even that.',
  'Bash is read from the command text: a shell write to a named contract file is refused, and one that can reach a directory holding a contract without naming it asks; a command shape it does not recognise passes, and the required check is the guarantee.',
  'It does not prove that the mod was running: a plugin can fail to load its mod without a message; /plugin shows "1 mod active" when it runs, and the required check is the guarantee.',
  'A contract generated from source code — annotations, decorators, a build step — changes when the source changes; the hooks see the source edit, not the contract; the required check sees the generated contract.',
]);

// This turn's decisions, for the band: { refused, allowed, last, lastRefused }. Reset by turn.start.
let turn = emptyTurn();

function emptyTurn() {
  return { refused: 0, allowed: 0, last: null, lastRefused: null };
}

export function register(on, options) {
  // The plugin's `api_key` option (userConfig, sensitive): stored by Claude Code in secure storage
  // and handed here. No key → analyze, which authorizes nothing.
  const key = options && typeof options.api_key === 'string' && options.api_key.trim() !== '' ? options.api_key.trim() : null;

  on('tool.call', { tool: ['Write', 'Edit', 'MultiEdit', 'Bash'] }, async ($, e, next) => {
    const d = await decideToolCall({ tool: e.tool, input: e }, await modIo($));
    if (d.action === 'pass' || d.action === 'ask') return next(e); // an ask is put in tool.check, below
    if (e.tool === 'Bash') return refuseShell($, d);
    if (d.action === 'refuse') return refuse($, d.rel, d.why, null);
    const { rel } = d;

    const mode = key ? 'authorize' : 'analyze';
    const artifact = { id: 'api', type: d.type, before: d.before, after: d.after };

    const answer = await Promise.race([
      $.http.fetch('https://app.coderifts.com/api/v1/preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(key
          ? { preflight_mode: 'authorize', artifacts: [artifact], context: { operation: 'merge', environment: 'staging' } }
          : { preflight_mode: 'analyze', artifacts: [artifact] }),
      }),
      $.clock.sleep(DEADLINE_MS).then(() => TIMED_OUT),
    ]);
    if (answer === TIMED_OUT) {
      return refuseUnavailable($, rel, `CodeRifts did not answer within ${DEADLINE_MS / 1000} s`);
    }
    const verdict = readVerdict(mode, answer);
    if (verdict.unavailable) return refuseUnavailable($, rel, verdict.why);
    const digest = await receiptDigest(verdict.receipt);
    if (!verdict.allow) {
      return refuse($, rel, verdict.why, digest, verdict.label, verdict.decisionId);
    }
    await show($, `CodeRifts · ${verdict.label} · ${rel}${trail(digest, verdict.decisionId)}`, { label: verdict.label, digest, rel, decisionId: verdict.decisionId });
    return next(e);
  }).catch(($, e, next) => ({
    deny: next.called
      ? `CodeRifts mod failed after the ${e.tool} call ran (${next.error.kind}); treat the change as unchecked. ${MERGE_GATE}`
      : `CodeRifts did not check this ${e.tool} (${next.error.kind}: ${String(next.error.message).slice(0, 120)}), so it was refused. ${governanceUnavailable(`the check failed: ${next.error.kind}`)} Retry the edit; ${MERGE_GATE}`,
  }));

  // A shell write that can reach a contract without naming it is put to the user: tool.check is
  // where a mod asks. A deny from the rules or another hook stands.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const decided = await next(e);
    if ((typeof decided === 'string' ? decided : decided && decided.decision) === 'deny') return decided;
    const d = await decideToolCall({ tool: 'Bash', input: e.input || {} }, await modIo($));
    if (d.action !== 'ask') return decided;
    await show($, `CodeRifts asks · ${d.scopes.join(', ')} · ${d.why}`, { label: 'ask', digest: null, rel: d.scopes.join(', '), refused: true, decisionId: null });
    return { decision: 'ask', reason: `CodeRifts: ${d.why}. ${MERGE_GATE}` };
  }).catch(($, e, next) => ({
    // A failed check is not a pass: the user is asked (tool.call fails closed the same way).
    decision: 'ask',
    reason: `CodeRifts could not check this Bash command. ${governanceUnavailable(`the check failed: ${next.error.kind}`)} ${MERGE_GATE}`,
  }));

  on('turn.start', ($, e, next) => {
    turn = emptyTurn();
    $.ui.invalidate('ui.render');
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (turn.last === null) {
      return next(e);
    }
    const { Box, Text } = $.ui.resolve(e);
    const shown = turn.lastRefused ?? turn.last;
    const counts = turn.refused + turn.allowed > 1 ? ` · ${turn.refused} refused, ${turn.allowed} allowed this turn` : '';
    return Box({
      flexDirection: 'row',
      children: [
        Text({ key: 'mark', color: shown.refused ? 'red' : 'green', bold: true, children: shown.refused ? '✗ CodeRifts ' : '✓ CodeRifts ' }),
        Text({ key: 'line', children: `${shown.label} · ${shown.rel}`, wrap: 'truncate-end' }),
        shown.digest || shown.decisionId ? Text({ key: 'digest', dimColor: true, children: trail(shown.digest, shown.decisionId) }) : null,
        counts ? Text({ key: 'counts', dimColor: true, children: counts }) : null,
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
    return { allow: false, unavailable: true, label: `HTTP ${answer.status}`, why: `CodeRifts answered HTTP ${answer.status} with no readable decision` };
  }
  if (!answer.ok) {
    const msg = doc && (doc.message || doc.error);
    // A server fault, a timeout or a rate limit is CodeRifts not deciding; a 4xx about the request is an answer.
    const notDeciding = answer.status >= 500 || answer.status === 408 || answer.status === 429;
    return { allow: false, unavailable: notDeciding, label: `HTTP ${answer.status}`, why: `CodeRifts answered HTTP ${answer.status}${msg ? ` (${String(msg).slice(0, 160)})` : ''}` };
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
  const decisionId = typeof dr.decision_id === 'string' && dr.decision_id !== '' ? dr.decision_id : null;
  if (ALLOW_ACTIONS.includes(action)) {
    return { allow: true, label: action, receipt, decisionId };
  }
  return { allow: false, label: action || 'no execution_action', receipt, decisionId, why: `CodeRifts decided ${action || 'nothing it names'}${breaks ? `: the change ${breaks}` : ''}` };
}

/** "breaks 2 things: path.remove /a, …" or ''. */
function breakSummary(doc) {
  const list = doc && Array.isArray(doc.breaking_changes_details) ? doc.breaking_changes_details : [];
  if (list.length === 0) return '';
  const named = list.slice(0, 3).map((b) => `${b.type || 'change'} ${b.path || ''}`.trim()).join(', ');
  return `breaks ${list.length} ${list.length === 1 ? 'thing' : 'things'}: ${named}${list.length > 3 ? ', …' : ''}`;
}

async function refuseUnavailable($, rel, why) {
  await show($, `CodeRifts could not decide · ${rel} · ${why}`, { label: 'GOVERNANCE_UNAVAILABLE', digest: null, rel, refused: true, decisionId: null });
  return { deny: `CodeRifts refused this edit of ${rel}. ${governanceUnavailable(why)} Retry the edit; ${MERGE_GATE}` };
}

async function refuse($, rel, why, digest, label = 'refused', decisionId = null) {
  await show($, `CodeRifts refused · ${rel} · ${why}${trail(digest, decisionId)}`, { label, digest, rel, refused: true, decisionId });
  return { deny: `CodeRifts refused this edit of ${rel}: ${why}. Next step: change the contract so it does not break its consumers, or get the change authorized (coderifts.preflight_change_set with preflight_mode=authorize). ${MERGE_GATE}` };
}

/** The band where the terminal or the Desktop app draws, one transcript line everywhere else. */
async function show($, line, state) {
  const decision = { refused: false, ...state };
  turn = {
    refused: turn.refused + (decision.refused ? 1 : 0),
    allowed: turn.allowed + (decision.refused ? 0 : 1),
    last: decision,
    lastRefused: decision.refused ? decision : turn.lastRefused,
  };
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

/** The file's text after this call, or null when the call does not apply to `before` (contract-write's afterText). */
export function applyCall(e, before) {
  return afterText(e.tool, e, before);
}

/**
 * What contract-write reads through the mods API: the file (missing → null; there but unreadable →
 * a throw, which refuses), one directory level for its walk, and the project's `.coderifts.yml`
 * schema list. No environment variable is read. Each of these is an event an earlier mod can rewrite.
 */
async function modIo($) {
  const cwd = await $.session.cwd();
  return {
    cwd,
    named: parseSchemaList(await readOrNull($, joinPath(cwd, '.coderifts.yml'))),
    readFile: async (p) => ((await $.fs.exists(p)) ? $.fs.read(p) : null),
    listDir: async (dir) => {
      try {
        const entries = await $.fs.list(dir === '.' ? cwd : joinPath(cwd, dir));
        // $.fs.list names a directory 'dir' (measured on 2.1.288) and throws on a file.
        return Array.isArray(entries) ? entries.map((x) => ({ name: x.name, kind: x.kind === 'dir' || x.kind === 'directory' ? 'directory' : 'file' })) : null;
      } catch {
        return null;
      }
    },
  };
}

/** A shell command that writes a named contract file: refused, with the way that is checked. */
async function refuseShell($, d) {
  const names = (d.paths || []).map((x) => x.path).join(', ') || d.rel || 'a contract file';
  await show($, `CodeRifts refused · ${names} · shell write`, { label: 'refused', digest: null, rel: names, refused: true, decisionId: null });
  return { deny: `CodeRifts refused this shell command: ${d.why}. ${MERGE_GATE}` };
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

// ---- the receipt -----------------------------------------------------------

async function receiptDigest(token) {
  if (!token) return null;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return `sha256:${[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** " · decision dec_… · receipt sha256:…" — the id fetches the receipt, the digest identifies it. */
function trail(digest, decisionId) {
  return `${decisionId ? ` · decision ${decisionId}` : ''}${digest ? ` · receipt ${shortDigest(digest)}` : ''}`;
}

function shortDigest(d) {
  return `${d.slice(0, 19)}…`;
}

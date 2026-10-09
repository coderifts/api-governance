// CodeRifts mod: blast-radius, for API contracts.
//
// tool.check (Write / Edit / MultiEdit / Bash): when the call touches a contract file (named in
// .coderifts.yml `schema:`, or matching the contract patterns), the mod sends the before/after text
// to CodeRifts preflight before the call runs, and answers in one of four ways:
//   STOP                                  { decision: 'deny' }  the reason and the next step in the text
//   REQUEST_APPROVAL                      { decision: 'ask' }   the user decides
//   GOVERNANCE_UNAVAILABLE                { decision: 'ask' }   "this is not a finding about your change"
//   CONTINUE, or not a contract call      next(e)               the session decides as without the mod
// Without the api_key option the request is preflight_mode=analyze, which authorizes nothing: no break
// passes the check on, a detected break asks. An ask is the mod's own answer, written in the return:
// the mod never reads what next(e) gives back, so it does not consult a deny rule below it (1.2.7).
// It contacts one address, https://app.coderifts.com/api/v1/preflight, written at the call. Its own
// deadline (8 s) and its .catch answer GOVERNANCE_UNAVAILABLE → ask: an error, a timeout or an answer it
// cannot read never passes the check on.
//
// 1.2.6 (2026-10-05, the Claude directory review: "The directory couldn't confirm that the mod leaves a
// permission decision with the user"): every answer is written in the hook's own return — next(e), or
// an object literal with the fixed decision 'deny' or 'ask' — and every mods API call is written in full
// inside the hook. tool.call could not ask (its answers are next(e), { deny } and { result }), so the
// decision moved to tool.check, where the user's ask happens. test/claude-mod-permission-literals holds
// both, statically and on the hooks themselves.
//
// The key is the plugin's `api_key` option (userConfig, sensitive), read from register's second
// parameter; no environment variable and no file is read for it. The band and the transcript line carry
// the decision_id, so the receipt this mod saw can be fetched (get_decision_details) and verified.
//
// Which call touches a contract file is decided by contract-write.mjs, the one decision function
// agent-hooks and `coderifts claude-hook` run too. With it the mod reads Bash: a shell command that
// writes a named contract file is refused, with a pointer to Write/Edit; one that can reach a directory
// holding a contract without naming it asks.
//
// What this mod does not prove is in README.md ("What this mod does not prove") and in the
// does_not_prove list below, word for word.
//
// Generated into the plugin by scripts/generate-claude-package.js. Edit this file, not the copy.

import { afterText, decideToolCall, pendingListings, readPlan } from './contract-write.mjs';

const DEADLINE_MS = 8000;
const TIMED_OUT = Object.freeze({ timedOut: true });
const PASS_ACTIONS = Object.freeze(['CONTINUE', 'CONTINUE_WITH_MONITORING']);
const MERGE_GATE = 'The merge gate is the required CodeRifts check on the pull request.';

// GOVERNANCE_UNAVAILABLE (2026-10-04): the one sentence the App, the CLI hook and agent-hooks write
// verbatim when CodeRifts could not decide.
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

// This turn's decisions, for the band: { refused, passed, last, lastRefused }. Reset by turn.start.
let turn = emptyTurn();

function emptyTurn() {
  return { refused: 0, passed: 0, last: null, lastRefused: null };
}

// 1.2.9 (2026-10-08/09, the directory's MOD_PERMISSION_ANSWER_UNREAD at register.js:88 of 1.2.7): the
// directory reads every return in a hook's text as the hook's answer, nested functions included, and
// 1.2.7's io readers returned calls (`return listingOf(await $.fs.list(...))`). Every $.fs call is made in
// the hook itself, AHEAD of the decision, from contract-write's readPlan / pendingListings, each awaited
// into a variable; contract-write then reads only these answers. ioFrom holds no mods API, so no call is
// reached "via" a helper (claude plugin validate). Something not read ahead is unreadable to contract-write
// (fail-closed). test/claude-mod-preread.test.js and test/claude-mod-directory-policy.test.js hold both.
function ioFrom(cwd, named, files, listings) {
  return {
    cwd,
    named,
    readFile: async (p) => {
      const f = Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
      if (!f) throw new Error(`${p} was not read ahead`);
      if (f.error !== undefined) throw new Error(f.error);
      return f.missing ? null : f.text;
    },
    listDir: async (dir) => {
      if (!Object.prototype.hasOwnProperty.call(listings, dir)) throw new Error(`${dir} was not listed ahead`);
      return listings[dir];
    },
  };
}

/** What the deadline resolves to (outside the hook for the same reason). */
function timedOut() {
  return TIMED_OUT;
}

export function register(on, options) {
  // The plugin's `api_key` option (userConfig, sensitive): stored by Claude Code in secure storage and
  // handed here. No key → analyze, which authorizes nothing.
  const key = options && typeof options.api_key === 'string' && options.api_key.trim() !== '' ? options.api_key.trim() : null;

  on('tool.check', { tool: ['Write', 'Edit', 'MultiEdit', 'Bash'] }, async ($, e, next) => {
    // What contract-write reads, through the mods API: the project's .coderifts.yml, the file, one
    // directory level for the Bash walk. An unreadable .coderifts.yml reads as no schema list (as 1.2.5's
    // readOrNull did); a contract file that is there but unreadable is contract-write's 'unreadable' (→ ask).
    const cwd = await $.session.cwd();
    let yml = null;
    try {
      yml = (await $.fs.exists(joinPath(cwd, '.coderifts.yml'))) ? await $.fs.read(joinPath(cwd, '.coderifts.yml')) : null;
    } catch {
      yml = null;
    }
    const named = parseSchemaList(typeof yml === 'string' ? yml : null);
    const call = { tool: e.tool, input: e.input || {} };
    // Read ahead (1.2.9): every file and every listing contract-write can ask for on this call.
    const plan = readPlan(call, { cwd, named });
    let files = {};
    for (const p of plan.files) {
      let entry;
      try {
        const there = await $.fs.exists(p);
        entry = there ? { text: await $.fs.read(p) } : { missing: true };
      } catch (err) {
        entry = { error: String((err && err.message) || err) };
      }
      files = { ...files, [p]: entry };
    }
    let listings = {};
    let pending = await pendingListings(plan.roots, listings);
    while (pending.length) {
      for (const dir of pending) {
        let entries;
        try {
          entries = listingOf(await $.fs.list(dir === '.' ? cwd : joinPath(cwd, dir)));
        } catch {
          entries = null;
        }
        listings = { ...listings, [dir]: entries };
      }
      pending = await pendingListings(plan.roots, listings);
    }
    const d = await decideToolCall(call, ioFrom(cwd, named, files, listings));
    if (d.action === 'pass') return next(e);

    let outcome;
    if (d.reason === 'mcp_json_held') {
      // 1.2.9 (P65d): a plain mcp.json that is both a client configuration and a tool manifest, or that
      // does not parse — never sent; the user is asked, with contract-write's one sentence.
      outcome = heldOutcome(d);
    } else if (e.tool === 'Bash') {
      outcome = shellOutcome(d);
    } else if (d.action === 'refuse') {
      outcome = localOutcome(d);
    } else if (d.action !== 'gate') {
      // Only a 'gate' decision is sent; anything else contract-write might answer asks.
      outcome = undecidedOutcome(d);
    } else {
      const artifact = { id: 'api', type: d.type, before: d.before, after: d.after };
      const answer = await Promise.race([
        $.http.fetch('https://app.coderifts.com/api/v1/preflight', {
          method: 'POST',
          // 1.2.5: the acquisition channel the server already counts (source_id `claude_marketplace`);
          // attribution only — it never reaches a decision. Named in the README's "what it sends".
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-coderifts-source': 'claude_marketplace', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(key
            ? { preflight_mode: 'authorize', artifacts: [artifact], context: { operation: 'merge', environment: 'staging' } }
            : { preflight_mode: 'analyze', artifacts: [artifact] }),
        }),
        $.clock.sleep(DEADLINE_MS).then(timedOut),
      ]);
      const verdict = answer === TIMED_OUT
        ? { branch: 'unavailable', label: 'GOVERNANCE_UNAVAILABLE', why: `CodeRifts did not answer within ${DEADLINE_MS / 1000} s` }
        : readVerdict(key ? 'authorize' : 'analyze', answer);
      outcome = preflightOutcome(verdict, d.rel, await receiptDigest(verdict.receipt));
    }

    // The band where the terminal or the Desktop app draws, one transcript line everywhere else.
    turn = recordTurn(turn, outcome.band);
    const surfaces = await $.session.surfaces();
    if (surfaces.includes('terminal') || surfaces.includes('desktop')) {
      $.ui.invalidate('ui.render');
    } else {
      await $.ui.log(outcome.line);
    }

    if (outcome.branch === 'deny') return { decision: 'deny', reason: outcome.reason };
    if (outcome.branch === 'next') return next(e);
    // 1.2.7 (the directory's MOD_PERMISSION_ANSWER_UNREAD): an ask is answered here, literally; what
    // next(e) would give back is never read, so a deny rule below this hook is not consulted.
    return { decision: 'ask', reason: outcome.reason };
  }).catch(($, e) => ({
    // A failed check is not a pass: the user is asked. next is not taken here, so nothing of it is read.
    decision: 'ask',
    reason: `CodeRifts could not check this ${e.tool} call. ${governanceUnavailable('the check failed')} ${MERGE_GATE}`,
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
    const counts = turn.refused + turn.passed > 1 ? ` · ${turn.refused} refused or asked, ${turn.passed} passed this turn` : '';
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

// ---- deciding (pure: no mods API call below this line) ---------------------

/**
 * What the preflight answer means for this call: { branch: 'pass' | 'stop' | 'approval' | 'rejected' |
 * 'unavailable' }. Anything unreadable is 'unavailable'; every branch but 'pass' and 'stop' asks.
 */
export function readVerdict(mode, answer) {
  let doc = null;
  try {
    doc = JSON.parse(answer.text);
  } catch {
    return { branch: 'unavailable', label: `HTTP ${answer.status}`, why: `CodeRifts answered HTTP ${answer.status} with no readable decision` };
  }
  if (!answer.ok) {
    const msg = doc && (doc.message || doc.error);
    const why = `CodeRifts answered HTTP ${answer.status}${msg ? ` (${String(msg).slice(0, 160)})` : ''}`;
    // A server fault, a timeout or a rate limit is CodeRifts not deciding; a 4xx about the request is an
    // answer about the request — both ask, only the first says GOVERNANCE_UNAVAILABLE.
    const notDeciding = answer.status >= 500 || answer.status === 408 || answer.status === 429;
    return { branch: notDeciding ? 'unavailable' : 'rejected', label: `HTTP ${answer.status}`, why };
  }
  const dr = doc && typeof doc.decision_result === 'object' && doc.decision_result !== null ? doc.decision_result : {};
  const breaks = breakSummary(doc);
  const fix = suggestedFix(doc);
  if (mode === 'analyze') {
    const outcome = doc && doc.analysis_outcome;
    if (outcome === 'NO_BREAK_DETECTED') return { branch: 'pass', label: 'analyze: no break (not an authorization)', receipt: null };
    if (outcome === 'BREAKS_DETECTED') {
      return { branch: 'approval', label: 'analyze: breaks detected', fix, why: `the change ${breaks || 'breaks its consumers'} (analyzed without a key, which authorizes nothing)` };
    }
    return { branch: 'unavailable', label: `analyze: ${outcome || 'no outcome'}`, why: `the analysis answered ${outcome || 'no outcome'}` };
  }
  const action = dr.execution_action || (doc && doc.execution_action) || null;
  const receipt = dr.receipt && typeof dr.receipt.token === 'string' ? dr.receipt.token : null;
  const decisionId = typeof dr.decision_id === 'string' && dr.decision_id !== '' ? dr.decision_id : null;
  if (PASS_ACTIONS.includes(action)) return { branch: 'pass', label: action, receipt, decisionId };
  if (action === 'STOP') return { branch: 'stop', label: action, receipt, decisionId, fix, why: `CodeRifts decided STOP${breaks ? `: the change ${breaks}` : ''}` };
  if (action === 'REQUEST_APPROVAL') return { branch: 'approval', label: action, receipt, decisionId, fix, why: `CodeRifts decided REQUEST_APPROVAL${breaks ? `: the change ${breaks}` : ''}` };
  return { branch: 'unavailable', label: action || 'no execution_action', receipt, decisionId, why: `CodeRifts answered ${action ? `the action ${action}, which this mod does not know` : 'no execution_action'}` };
}

/**
 * T19 (2026-10-06): the decision's own suggested fix, as one sentence group: the remediation the answer
 * carries (authorize: decision_result.remediation_transaction.required_changes; analyze:
 * analysis.remediations), at most two distinct instructions. Empty when there is none.
 */
const MAX_FIXES = 2;
const MAX_FIX_CHARS = 240;
function suggestedFix(doc) {
  const dr = doc && typeof doc.decision_result === 'object' && doc.decision_result !== null ? doc.decision_result : {};
  const rows = (dr.remediation_transaction && Array.isArray(dr.remediation_transaction.required_changes) && dr.remediation_transaction.required_changes)
    || (doc && doc.analysis && Array.isArray(doc.analysis.remediations) && doc.analysis.remediations)
    || [];
  const out = [];
  for (const row of rows) {
    const text = row && typeof row.instruction === 'string' ? row.instruction.trim().slice(0, MAX_FIX_CHARS) : '';
    if (text && !out.includes(text)) out.push(/[.!?]$/.test(text) ? text : `${text}.`);
    if (out.length === MAX_FIXES) break;
  }
  return out.join(' ');
}

/** The four branches of a preflight, as text and band. */
function preflightOutcome(verdict, rel, digest) {
  const band = { label: verdict.label, digest, rel, decisionId: verdict.decisionId || null };
  const t = trail(digest, verdict.decisionId);
  const fix = verdict.fix ? ` Suggested fix: ${verdict.fix}` : '';
  if (verdict.branch === 'pass') {
    return { branch: 'next', band: { ...band, refused: false }, line: `CodeRifts · ${verdict.label} · ${rel}${t}` };
  }
  if (verdict.branch === 'stop') {
    return {
      branch: 'deny',
      band: { ...band, refused: true },
      line: `CodeRifts refused · ${rel} · ${verdict.why}${t}`,
      reason: `CodeRifts refused this edit of ${rel}: ${verdict.why}. Next step: change the contract so it does not break its consumers, or get the change authorized (coderifts.preflight_change_set with preflight_mode=authorize).${fix} ${MERGE_GATE}`,
    };
  }
  if (verdict.branch === 'approval') {
    return {
      branch: 'ask',
      band: { ...band, refused: true },
      line: `CodeRifts asks · ${rel} · ${verdict.why}${t}`,
      reason: `CodeRifts asks for your approval of this edit of ${rel}: ${verdict.why}. Approve it only if the consumers of this contract are ready for the change.${fix} ${MERGE_GATE}`,
    };
  }
  if (verdict.branch === 'rejected') {
    return {
      branch: 'ask',
      band: { ...band, refused: true },
      line: `CodeRifts could not check · ${rel} · ${verdict.why}`,
      reason: `CodeRifts could not check this edit of ${rel}: ${verdict.why}. Fix the request or the file and retry, or decide yourself. ${MERGE_GATE}`,
    };
  }
  return {
    branch: 'ask',
    band: { ...band, label: 'GOVERNANCE_UNAVAILABLE', refused: true },
    line: `CodeRifts could not decide · ${rel} · ${verdict.why}`,
    reason: `CodeRifts could not check this edit of ${rel}. ${governanceUnavailable(verdict.why)} Retry the edit, or decide yourself. ${MERGE_GATE}`,
  };
}

/** contract-write's local answers for a Write / Edit / MultiEdit. */
function localOutcome(d) {
  const band = { label: 'refused', digest: null, rel: d.rel, refused: true, decisionId: null };
  if (d.reason === 'unreadable') {
    return { branch: 'ask', band: { ...band, label: 'GOVERNANCE_UNAVAILABLE' }, line: `CodeRifts could not decide · ${d.rel} · ${d.why}`, reason: `CodeRifts could not check this edit of ${d.rel}. ${governanceUnavailable(d.why)} ${MERGE_GATE}` };
  }
  // The edit does not apply to the file on disk: there is no after text to check, and none is guessed.
  return { branch: 'deny', band, line: `CodeRifts refused · ${d.rel} · ${d.why}`, reason: `CodeRifts refused this edit of ${d.rel}: ${d.why}. Next step: read the file again and redo the edit. ${MERGE_GATE}` };
}

/** P65d: a held plain mcp.json ('mixed' / 'unparseable'), from a file tool or a shell write — ask, nothing sent. */
function heldOutcome(d) {
  const rel = d.rel || (d.scopes || []).join(', ') || 'mcp.json';
  return { branch: 'ask', band: { label: 'not checked', digest: null, rel, refused: true, decisionId: null }, line: `CodeRifts asks · ${rel} · ${d.why}`, reason: `CodeRifts: ${d.why} ${MERGE_GATE}` };
}

/** A decision contract-write gives that this mod does not know: ask, nothing sent. */
function undecidedOutcome(d) {
  const rel = d.rel || 'a contract file';
  const why = `contract-write answered ${d.action || 'nothing'}`;
  return { branch: 'ask', band: { label: 'GOVERNANCE_UNAVAILABLE', digest: null, rel, refused: true, decisionId: null }, line: `CodeRifts could not decide · ${rel} · ${why}`, reason: `CodeRifts could not check this edit of ${rel}. ${governanceUnavailable(why)} ${MERGE_GATE}` };
}

/** contract-write's answers for a Bash command: a named contract write is refused, an unnamed reach asks. */
function shellOutcome(d) {
  if (d.action === 'ask') {
    const scopes = (d.scopes || []).join(', ');
    return { branch: 'ask', band: { label: 'ask', digest: null, rel: scopes, refused: true, decisionId: null }, line: `CodeRifts asks · ${scopes} · ${d.why}`, reason: `CodeRifts: ${d.why}. ${MERGE_GATE}` };
  }
  const names = (d.paths || []).map((x) => x.path).join(', ') || d.rel || 'a contract file';
  return { branch: 'deny', band: { label: 'refused', digest: null, rel: names, refused: true, decisionId: null }, line: `CodeRifts refused · ${names} · shell write`, reason: `CodeRifts refused this shell command: ${d.why}. ${MERGE_GATE}` };
}

/** "breaks 2 things: path.remove /a, …" or ''. */
function breakSummary(doc) {
  const list = doc && Array.isArray(doc.breaking_changes_details) ? doc.breaking_changes_details : [];
  if (list.length === 0) return '';
  const named = list.slice(0, 3).map((b) => `${b.type || 'change'} ${b.path || ''}`.trim()).join(', ');
  return `breaks ${list.length} ${list.length === 1 ? 'thing' : 'things'}: ${named}${list.length > 3 ? ', …' : ''}`;
}

/** The band's state after one more decision (new object; the old one is not changed). */
function recordTurn(state, band) {
  const decision = { refused: false, ...band };
  return {
    refused: state.refused + (decision.refused ? 1 : 0),
    passed: state.passed + (decision.refused ? 0 : 1),
    last: decision,
    lastRefused: decision.refused ? decision : state.lastRefused,
  };
}

// ---- the files -------------------------------------------------------------

/** The file's text after this call, or null when the call does not apply to `before` (contract-write's afterText). */
export function applyCall(e, before) {
  return afterText(e.tool, e, before);
}

/** $.fs.list entries as contract-write reads them ($.fs.list names a directory 'dir', measured on 2.1.288). */
function listingOf(entries) {
  return Array.isArray(entries) ? entries.map((x) => ({ name: x.name, kind: x.kind === 'dir' || x.kind === 'directory' ? 'directory' : 'file' })) : null;
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

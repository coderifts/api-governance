# Changelog

## 1.0.1

- The skill is `coderifts` (was `coderifts-api-governance`), at `skills/coderifts/SKILL.md`, and carries the one
  canonical body and the canonical trigger description (the Cursor-tuned text said "with a risk score").
- The hook fails closed: `failClosed: true` (Cursor's default is false — a crashed or unreachable hook would allow),
  runs `coderifts cursor-hook` (Cursor's JSON permission answer) instead of `claude-hook`, and matches Cursor's tool
  names `Write|Delete` (`Edit` is not a Cursor tool).

## 1.0.0

- Initial Cursor plugin: skill, generated Cursor rule, hosted MCP (three tools), and the existing `coderifts claude-hook` PreToolUse adapter.

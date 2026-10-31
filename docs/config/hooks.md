# Command lifecycle hooks

SessionStart means the first Effect of a Pulse run; `session_id` is the Run ID,
while `conversation_id` identifies the chat. It does not open a Jarvis session.

Pulse supports a bounded subset of Claude-style command hooks. There is no plugin,
HTTP-hook, prompt-hook, agent-hook or shell-language compatibility layer. Nothing
in project instructions, workspace config, skills or retrieved text enables hooks.

Use the CLI against your **host** config:

```
pulse hooks load ./hooks.json
pulse hooks check [hash]
pulse hooks enable <the-exact-hash-reported-by-load>
pulse hooks disable
```

`load` validates and stages only explicitly referenced script assets; it leaves the
version disabled. `enable` requires its exact hash and verifies staged assets.
Reload/re-enable after changes. `check [hash]` inspects the current or a retained
version, and `enable <hash>` can select a previously loaded version without
reinterpreting changed source files. Changes apply to new/restored runs; a running
run keeps its frozen definition snapshot. Unrelated config is preserved. Do not stage secret
files. Commands use literal argv (JSON array or simple quoted string); pipes,
redirects, shell expansion and `sh -c` are unsupported. Interpreter script paths
must lie within the definition folder and are copied into the pinned version.
Declare other imported assets explicitly with `assets`. Package-manager wrapper
commands are unsupported; use the installed interpreter/binary directly.

```json
{"hooks":{
  "SessionStart":[{"matcher":"startup|resume","hooks":[{"type":"command","command":["node","hooks/start.cjs"]}]}],
  "PreToolUse":[{"matcher":"Bash|Write|Edit","hooks":[{"type":"command","command":"node hooks/check.cjs","timeout":5}]}],
  "PostToolUse":[{"matcher":".*","hooks":[{"type":"command","command":["node","hooks/observe.cjs"],"assets":[]}]}],
  "PostToolUseFailure":[{"matcher":".*","hooks":[{"type":"command","command":["node","hooks/failure.cjs"]}]}],
  "Stop":[{"hooks":[{"type":"command","command":["node","hooks/stop.cjs"]}]}]
}}
```

Matchers support exact tool names, `Bash`/`Read`/`Write`/`Edit`/`MultiEdit`/`Glob`/`Grep` aliases, `|`
alternatives, optional `^`/`$`, and prefix `.*`. General regular expressions are
rejected. Write covers fs.write/overwrite/stage; Edit covers fs.apply_patch/apply_patches.
Other tool names must be matched explicitly or with `.*`. SessionStart matches `startup`/`resume`; Stop has no matcher. Only the five
events shown are implemented. Other handler/control fields fail explicitly.

The command receives bounded, redacted JSON on stdin: `hook_event_name`,
`session_id`, `conversation_id`, `cwd`, and for tools `tool_name`, `tool_use_id`,
`tool_input`, `effect_id`, `attempt_id`, `attempt_no`, `definition_hash`. Post hooks
receive the settled execution status, error code, `executionState`, and
`sideEffectState`, not full tool bodies, raw error text, or private reasoning.
An unknown `shell.stdin` delivery stays `SHELL_STDIN_DELIVERY_UNKNOWN` with
`remote_unknown` / `unknown`; it is not rewritten as a generic tool failure.
`shell.stdin` keystrokes are not copied into `tool_input.data`. The hook sees
`[redacted]` plus non-secret metadata such as `processId` and `bytes`. This is
not a general secret scanner.

The hook child starts from that caller allow-list, an isolated temporary HOME,
and sandbox-generated proxy or runtime variables. It does not inherit the rest
of the host environment. `strictAllowlist`, the read-only workspace, and the
temporary HOME stay in force. Ordinary `shell.exec` is unchanged. Hook scripts
cannot format/edit project files in this first version. If the payload cannot
be written, delivery is unknown: a zero exit and `{}` on stdout do not count
as success. PreToolUse then fails closed, stores an unknown receipt, and does
not run the tool on another attempt. A post hook records a diagnostic only. It
does not change an applied tool result or crash the host.

PreToolUse accepts empty stdout or a JSON object with `continue`, optional `reason`,
legacy `decision: block|approve`, or `hookSpecificOutput` containing
`hookEventName: PreToolUse`, `permissionDecision: deny|allow`, and optional
`permissionDecisionReason`. `allow`/`approve` only continue through Pulse's existing
checks; they never grant permission. Exit failure, timeout, invalid JSON and
unsupported output block the tool. Parameter replacement, added context, permission
updates and stop-control outputs are unsupported.

SessionStart, post hooks and Stop are observers. Empty stdout or `{}` (optional
`suppressOutput`) is supported; failures become diagnostic receipts. Post hooks run asynchronously so they cannot delay tool settlement past its deadline.
Completion drains diagnostic work; cancellation stops it. A crash can leave an observer
unexecuted or unknown; it is not automatically replayed. A post failure never rewinds or repeats the tool. Receipts identify run/effect/attempt/definition;
settled operations are not replayed. An interrupted pre hook with unknown outcome
fails closed across retries, including new attempt IDs. A revoked or changed
trusted definition blocks dependent operations. Existing runs without a hook
snapshot keep their original no-hook behavior.

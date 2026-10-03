# bash-guardrails

A Claude Mod that enforces **guard rules on tool calls**. Before Claude runs a `Bash` command (or calls the `Monitor` tool), the plugin checks it against a set of rules and, if one matches, blocks the call with a short explanation so Claude can correct course on its own. Each rule is a toggle, and only two are on by default.

## Why not auto mode or a regex hook?

**Auto mode.** Auto mode's classifier decides whether an action is *unsafe or unauthorized*. The pitfalls here are different: commands that are allowed and not malicious but reliably waste time or cause trouble, such as `find /` crawling the whole filesystem, `pgrep -f` matching the harness's own `bash -c` wrapper, or an `until grep` loop that never exits when the writer dies. The auto mode classifier can reasonably let them through, since nothing about them is unsafe. These rules are deterministic, so the same command is always handled the same way, and each denial tells Claude what to do instead. They work alongside auto mode rather than replacing it.

**Regex hooks.** The usual way to guard Bash is a hook that matches the command text with a regular expression. That is brittle in both directions. `echo "find / -name x"` trips a regex for `find /`, while `cd /x && find / -name y`, `bash -c "find / -type f"`, `echo $(find /)`, `\sudo ls` or `env X=1 timeout 5 find /` slip past a simple one. This plugin parses the command with a real shell parser (a vendored copy of [unbash](https://github.com/webpro-nl/unbash)) and checks the commands that would actually run, so quoting, escapes, pipelines, `&&` chains, subshells, command substitutions, heredocs and `bash -c` strings are all understood. Commands behind wrappers such as `env`, `timeout`, `nice`, `xargs`, `sudo` and `run0` are checked too.

## What it does

| Rule | Default | Blocks |
| --- | --- | --- |
| `malformed_bash` | on | Bash commands that fail to parse. Claude gets the parse error and retries. The other Bash rules, including `run0_confirm`, rely on the parse: with this rule off, a command that doesn't parse may be only partly checked, so a `run0` invocation in it can go unconfirmed. Keep it on if you use `run0_confirm`. |
| `find_root` | on | `find` rooted at `/` (including `//`, `/*` and `find -- /`), even with `-xdev`. It is independent of `find_xdev`. |
| `find_xdev` | off | `find` without `-xdev` or `-mount`, so searches never cross filesystem boundaries. |
| `pgrep_f` | off | `pgrep -f` without `-a`, and any `pkill -f`. `-f` can match helper processes such as the harness's own `bash -c` wrapper, and `pkill` would kill them; `pgrep -af` shows each command line so matches can be verified before killing by PID. |
| `pgrep_captured` | off | `pgrep` output captured by a pipe or substitution (`pgrep x \| wc -l`, `$(pgrep x)`, `<(pgrep x)`). |
| `until_grep` | off | `until grep ...` loops (also `egrep`, `fgrep` and `rg`), which never exit if the process writing the log dies. Claude is pointed to `tail -f --pid=<PID> <log> \| grep -m1 <pattern>` instead. |
| `monitor_disabled` | off | The `Monitor` tool. Claude is pointed to a background `Bash` command (`run_in_background`) that blocks until the next event and exits. |
| `sudo` | off | `sudo`, including wrapped (`env X=1 sudo ls`) and nested (`bash -c "sudo ls"`) forms. Claude is pointed to `run0`. |
| `run0_confirm` | off | Not a block: before any `run0` invocation, the user is asked to allow or deny it, with the exact wrapped command and the full Bash command shown. `run0`'s own graphical prompt does not show the command. |

Rules are checked in the order above and the first match decides. When a rule blocks a call, Claude sees the reason and the call does not run. Anything no rule matches runs as usual.

These rules are meant to catch common mistakes, not to be a security boundary. A command assembled at run time (`$cmd`, `eval "$x"`) or run through a program that is not a recognized wrapper (`ssh host find /`, `watch find /`) is not seen.

## When it runs

- On every `Bash` and `Monitor` tool call, including calls made by subagents.
- Other tools are never touched.
- If the hook itself fails, the call is blocked rather than run unchecked.

## Installation

Requires Claude Code v2.1.287 or later.

Install it from the official Anthropic plugin directory. In case you haven't added this marketplace yet, add it first, and refresh it to get the latest listing:

```
claude plugin marketplace add anthropic-plugin-directory
claude plugin marketplace update anthropic-plugin-directory
claude plugin install bash-guardrails@anthropic-plugin-directory
```

If you prefer using the TUI, inside a session, use `/plugin marketplace add`, `/plugin marketplace update` and `/plugin install` with the same arguments.

To update to a newer release later:

```
claude plugin marketplace update anthropic-plugin-directory
claude plugin update bash-guardrails@anthropic-plugin-directory
```

To try a local checkout while developing, load it directly instead:

```
claude --plugin-dir /path/to/cc-bash-guardrails
```

## Configuration

Each rule is a boolean `userConfig` option named as in the table above, for example `sudo` or `find_xdev`. Only `malformed_bash` and `find_root` default to `true`. Set the options in the plugin's configuration, or under `pluginConfigs` in your settings, keyed by the plugin's id (`bash-guardrails@anthropic-plugin-directory`).

## What the hook does

The plugin registers exactly one hook, on the `tool.call` event, with the filter `tool: ['Monitor', 'Bash']`. For each call it runs the enabled rules in order and returns `{ deny: reason }` for the first one that matches. If none matches, it calls `next` with the call unchanged. When `run0_confirm` is on and the command contains a `run0` invocation, it asks the user first through `$.ui.ask` and denies the call unless the answer is `Allow`. A dismissed prompt, or a session with no one to ask (such as `-p`), also denies. The plugin never modifies a tool call, and it hooks no other event.

An error handler on the hook denies the call if the hook throws or times out before passing the call on.

## What it runs, sends, and fetches

- It runs a single `tool.call` hook, written in TypeScript (`hooks/register.ts`, `hooks/rules.ts` and `hooks/shell.ts`), inside Claude Code.
- It makes **no model calls**, **no network requests**, and **no shell commands**. Commands are only parsed, never executed.
- It does not read or write any files, and it uses no credentials, environment variables, or MCP servers.
- It does not collect, store, or transmit any data. The only thing it shows is the optional `run0` confirmation dialog.
- Its one dependency is the vendored unbash parser (ISC license, in `hooks/vendor/unbash/`), which has no install step.

## Development

The rule logic is pure and kept free of the mods API: `firstDenial` and `run0Invocations` in `hooks/rules.ts`, on top of the parser wrapper `analyze` in `hooks/shell.ts`. Both are covered by unit tests in `tests/rules.test.ts`.

```
claude plugin validate .
claude plugin test
```

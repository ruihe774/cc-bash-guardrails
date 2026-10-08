# bash-guardrails

A Claude Mod that enforces **guard rules on tool calls**. Before Claude runs a `Bash` command (or calls the `Monitor` tool), the plugin checks it against a set of rules and, if one matches, blocks the call with a short explanation so Claude can correct course on its own. Each built-in rule is a toggle, and only a few are on by default. You can add your own rules, written in [CEL](https://cel.dev), in the same format the built-in rules use.

## Why not auto mode or a regex hook?

**Auto mode.** Auto mode's classifier decides whether an action is *unsafe or unauthorized*. The pitfalls here are different: commands that are allowed and not malicious but reliably waste time or cause trouble, such as `find /` crawling the whole filesystem, `pgrep -f` matching the harness's own `bash -c` wrapper, or an `until grep` loop that never exits when the writer dies. The auto mode classifier can reasonably let them through, since nothing about them is unsafe. These rules are deterministic, so the same command is always handled the same way, and each denial tells Claude what to do instead. They work alongside auto mode rather than replacing it.

**Regex hooks.** The usual way to guard Bash is a hook that matches the command text with a regular expression. That is brittle in both directions. `echo "find / -name x"` trips a regex for `find /`, while `cd /x && find / -name y`, `bash -c "find / -type f"`, `echo $(find /)`, `\sudo ls` or `env X=1 timeout 5 find /` slip past a simple one. This plugin parses the command with a real shell parser (a vendored copy of [unbash](https://github.com/webpro-nl/unbash)) and checks the commands that would actually run, so quoting, escapes, pipelines, `&&` chains, subshells, command substitutions, heredocs and `bash -c` strings are all understood. Commands behind wrappers such as `env`, `timeout`, `nice`, `xargs`, `sudo` and `run0` are checked too.

## What it does

| Rule | Default | Blocks |
| --- | --- | --- |
| `monitor_no_command` | on | `Monitor` calls with neither a command string the Bash rules can check nor a `ws` source, rather than running them unchecked. |
| `malformed_bash` | on | Bash commands that fail to parse. Claude gets the parse error and retries. The other Bash rules, including `run0_confirm`, rely on the parse: with this rule off, a command that doesn't parse may be only partly checked, so a `run0` invocation in it can go unconfirmed. Keep it on if you use `run0_confirm`. |
| `find_root` | on | `find` rooted at `/` (including `//`, `/*` and `find -- /`), even with `-xdev`. It is independent of `find_xdev`. |
| `find_xdev` | off | `find` without `-xdev` or `-mount` (or BSD/macOS `-x`), so searches never cross filesystem boundaries. `find --help` and `--version` are left alone. |
| `pgrep_f` | off | `pgrep -f` without `-a`, and any `pkill -f`. `-f` can match helper processes such as the harness's own `bash -c` wrapper, and `pkill` would kill them; `pgrep -af` shows each command line so matches can be verified before killing by PID. |
| `pgrep_captured` | off | `pgrep` output captured by a pipe or substitution (`pgrep x \| wc -l`, `$(pgrep x)`, `<(pgrep x)`). |
| `until_grep` | off | `until grep ...` and `while ! grep ...` loops (also `egrep`, `fgrep` and `rg`), which never exit if the process writing the log dies. Claude is pointed to `tail -f --pid=<PID> <log> \| grep -m1 <pattern>` instead. |
| `monitor_disabled` | off | The `Monitor` tool. Claude is pointed to a background `Bash` command (`run_in_background`) that blocks until the next event and exits. |
| `sudo` | off | `sudo`, including wrapped (`env X=1 sudo ls`) and nested (`bash -c "sudo ls"`) forms. Claude is pointed to `run0`. |
| `cat_read` | off | `cat` that only shows files: `cat f`, `cat -n a b`, `cat < f`, and `cat f` piped into nothing but line pickers (`head`, `tail`, `sed -n 'X,Yp'`, `awk 'NR...'`). Claude is pointed to the Read tool. `cat` whose output goes into another command, a substitution or a file is left alone, as are `cat -A`/`-v`, files under `/dev`, `/proc` and `/sys`, and `cat` run through `sudo`, `run0` or `doas`. |
| `line_range_read` | off | `head f`, `sed -n 'X,Yp' f` (also `X,$p`, `X,+Np`, `sed 'X,Y!d' f` and `sed 'Nq' f`) and `awk 'NR>=X && NR<=Y' f` showing lines of a file. Claude is pointed to Read with offset and limit. A standalone `tail` is left alone, since Read can't count back from the end of a file, as are `sed -z` (NUL-separated records) and commands run through `sudo`, `run0` or `doas`. |
| `heredoc_write` | off | Writing a heredoc or here-string to a file: `cat <<EOF > f`, `cat <<EOF >> f`, `cat <<EOF \| tee f`, `tee f <<EOF`. Claude is pointed to the Write tool. A heredoc the shell expands (an unquoted delimiter with `$` or a backquote in it) is left alone, as is a `cat` or `tee` run through `sudo`, `run0` or `doas` (`cat <<EOF \| sudo tee /etc/f`, `sudo sh -c 'cat > /etc/f <<EOF'`). |
| `sed_edit` | off | `sed -i` on one file whose script is only `s` commands (on every line, or on a line or range, with or without `g`) and deletions of a line or range. Claude is pointed to the Edit tool, whose `replace_all` covers `g`. Several files, regex addresses, `-n` and `-f` scripts, and `sed` run through `sudo`, `run0` or `doas` are left alone. |
| `python_edit` | off | A Python script, from `python -c` or a heredoc on `python`'s stdin, that imports `re` or calls `.replace(`, opens a file (`open(` or `pathlib`), writes (`.write(`, `.write_text(`, `.write_bytes(` or `.writelines(`) **and** has a multiline (triple-quoted) string literal. Claude is pointed to the Edit tool. Any subset of these alone is not enough, and `python` run through `sudo`, `run0` or `doas` is left alone. |
| `run0_confirm` | off | Not a block: before any `run0` invocation, the user is asked to allow or deny it, with the exact wrapped command and the full Bash command shown. `run0`'s own graphical prompt does not show the command. |

Every deny rule is checked first, in the order above and then your [custom rules](#custom-rules), and the first match decides. Only then come the confirmations (`run0_confirm` and any custom `ask` rules), so you are never asked about a call that is blocked anyway. When a rule blocks a call, Claude sees the reason and the call does not run. Anything no rule matches runs as usual.

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

Each built-in rule is a boolean `userConfig` option named as in the table above, for example `sudo` or `find_xdev`. Only `monitor_no_command`, `malformed_bash` and `find_root` default to `true`. Set the options in Claude Code's configuration (`/config`), or under `pluginConfigs` in your settings, keyed by the plugin's id (`bash-guardrails@anthropic-plugin-directory`). E.g., to enable more rules, in your `~/.claude/settings.json`:
```json5
// ...
  "pluginConfigs": {
    "bash-guardrails@anthropic-plugin-directory": {
      "options": {
        "find_xdev": true,
        "pgrep_captured": true,
        "pgrep_f": true,
        "run0_confirm": true,
        "sudo": true,
        "until_grep": true
      }
    }
  },
// ...
```

## Custom rules

Add your own rules in a JSON rule file. Two files are read, and their rules run after the built-in ones, in this order:

- **Your rules:** `~/.claude/bash-guardrails.json` (in `$CLAUDE_CONFIG_DIR` if you set it)
- **The project's rules:** `.claude/bash-guardrails.json` under the project root

A rule file looks like this:

```json
{
  "defs": {
    "FETCHERS": ["curl", "wget"],
    "RM": { "short": "rRfiIdv", "long": { "recursive": "r", "force": "f" } }
  },
  "rules": [
    {
      "id": "no-fetch",
      "let": { "hits": "cmds.filter(c, c.name in FETCHERS).map(c, c.name)" },
      "when": "size(hits) > 0",
      "deny": "Do not use {{ hits[0] }}; use the WebFetch tool."
    },
    {
      "id": "confirm-rm-r",
      "tools": ["Bash"],
      "when": "cmds.exists(c, c.name == 'rm' && c.args.opts(RM).exists(o, o in ['r', 'R']))",
      "ask": { "header": "rm -r", "question": "Allow a recursive rm?\n\n{{ input.command }}" }
    }
  ]
}
```

Each rule has:

| Field | |
| --- | --- |
| `id` | Required. Letters, digits, `-` and `_`. It can't be a built-in rule's id. |
| `when` | Required. A [CEL](https://cel.dev) expression that must be a `bool`. The rule fires when it is `true`. |
| `deny` | The reason Claude sees when the rule blocks the call. |
| `ask` | Instead of `deny`: ask the user first (see below). |
| `let` | Optional. Named CEL values, in order, that `when`, the messages and later `let`s can use. |
| `tools` | Optional. `["Bash"]`, `["Monitor"]` or both (the default). |
| `enabled` | Optional. `false` turns the rule off. |

`deny`, and the texts in `ask`, are templates: `{{ expr }}` inserts the value of a CEL expression. There is no `allow` action: a custom rule can only make the guard stricter, so a project's rule file can at worst block or ask about calls, and can't turn off a built-in rule or one of yours.

An `ask` has a `question` (a template), and optionally a `header` (12 characters at most), `options` (2 to 4 labels, `Allow` and `Deny` by default), `allowIf` (a CEL `bool` over `answer`, the label the user picked or the text they typed; by default the call is allowed only when the answer is the first option), `declined` (a template that can use `answer`) and `dismissed` (a template, for when the question is dismissed or no one can be asked).

### What a rule sees

| Name | Type | |
| --- | --- | --- |
| `tool` | `string` | `Bash` or `Monitor` |
| `input` | `map<string, dyn>` | The tool's input: `command`, `run_in_background`, `timeout`, `ws` and so on |
| `cmds` | `list<Cmd>` | Every simple command the shell would run, including those in pipelines, `&&` chains, subshells, substitutions, `bash -c` strings and behind wrappers such as `env`, `timeout`, `xargs`, `sudo` and `run0` |
| `errors` | `list<string>` | Parse errors. When it isn't empty, `cmds` may be incomplete. |
| `untilConds` | `list<list<Cmd>>` | For each `until` or `while !` loop, the commands of its condition |
| `pipelines` | `list<list<Cmd>>` | For each pipeline (`a \| b \| c`), its stages in order. A stage that is not a simple command, such as `{ ...; }`, has `name` `''`. |
| your `defs` | | Constants from the file's `defs`, and the built-in ones (`FIND_LEAD`, `FIND_EXPR`, `PGREP`, `GREPS`, `CAT`, `HEAD_TAIL`, `SED`, `AWK`, `TEE`, `PYTHON` and the others in [`hooks/builtin-rules.ts`](hooks/builtin-rules.ts)) |

A `Cmd` has `name` (the program's basename), `args` (its arguments, with quotes removed), `captured` (its output goes into a pipe or a substitution), `wrappers` (the wrappers in front of it, outermost first, including those in front of a shell running it, as in `sudo sh -c "..."`) and `chain`, a list of `Link`s, one for each wrapper's invocation and a last one for the command itself. A `Link` has `name` and `argv`. So `env X=1 sudo -u root ls -l` has `name` `ls`, `args` `["-l"]`, and a `chain` of `env`, `sudo` and `ls` whose `argv`s are `["env", "X=1", "sudo", "-u", "root", "ls", "-l"]`, `["sudo", "-u", "root", "ls", "-l"]` and `["ls", "-l"]`.

A `Cmd` also has `redirects`, a list of `Redir`s: its own, then those of the compound commands around it (`{ ...; } > f`, `for ...; done > f`) and of a shell running it (`bash -c "..." > f`), innermost first. A `Redir` has `op` (`>`, `>>`, `<`, `<<`, `<<-`, `<<<`, `>&`, `&>` and so on), `fd` (the descriptor written before the operator, `-1` if none, `-2` for a `{var}` one), `target` (the file, descriptor or here-string word, or a heredoc's delimiter), `body` (the text a heredoc or here-string feeds in, or `''`) and `quoted` (a heredoc whose delimiter is quoted, so its body is not expanded). And `stdout` is where those redirects send its output: a file, `&2` for another descriptor, or `''` when it is not redirected.

On top of [standard CEL](https://github.com/google/cel-spec/blob/master/doc/langdef.md), including macros such as `exists`, `all`, `filter` and `map`, `cel.bind`, and `matches` for regular expressions (JavaScript syntax), rules can use:

| Function | |
| --- | --- |
| `args.opts(spec)`, `args.operands(spec)` | Parse a `list<string>` of arguments by a spec and return the options seen, or the operands. A spec is a map with any of: `short` (getopt letters, a `:` after one that takes a value, `::` after one whose value is optional and only in the same argument, as `-i.bak`), `shortTakesValue` (every letter in `short` takes a value, and only from the same argument), `long` (long option names mapped to the name to report, as `{"full": "f"}`; a name ending in `:`, as `{"expression": "e:"}`, takes a value from `=value` or else the next argument), `words` (find-style words, each mapped to how many arguments follow it, or to a list of terminators as `{"-exec": [";", "+"]}`), `wordPatterns` (the same, keyed by regex) and `posix` (stop at the first operand). |
| `args.optValues(spec, name)` | The values given to option `name` (as reported by `opts`), in order: `['-e', 'a', '-eb'].optValues({"short": "e:"}, 'e')` is `["a", "b"]` |
| `list.takeWhile(regex)` | The leading items that match the regex |
| `list.take(n)`, `list.drop(n)` | The first `n` items; all but the first `n` |
| `shquote(argv)` | A `list<string>` as a shell-quoted command line |
| `list.flatten()`, `list.distinct()` | Flatten a list of lists; drop repeated items |

The built-in rules in [`hooks/builtin-rules.ts`](hooks/builtin-rules.ts) are written the same way, so they are worked examples.

### When rules load, and when they fail

A rule file is read when the session starts and read again whenever it changes, so edits apply to the next call without a restart. Each rule is type-checked when it loads: a typo such as `c.nmae`, `cmds.name == 'find'` (a list has no `name`) or a `when` that isn't a `bool` is caught there. A rule, def or file that fails to load is skipped, and a line in the transcript names it and the error; the other rules keep working. A rule that fails while it runs, for example on a malformed argument spec, blocks the call.

## What the hook does

The plugin registers two hooks. The main one is on the `tool.call` event, with the filter `tool: ['Monitor', 'Bash']`. For each call it runs the enabled deny rules in order and returns `{ deny: reason }` for the first one that matches. Then, for each `ask` rule that matches (such as `run0_confirm` when the command contains a `run0` invocation), it asks the user through `$.ui.ask` and denies the call unless the answer allows it. A dismissed prompt, or a session with no one to ask (such as `-p`), also denies. If nothing denies, it calls `next` with the call unchanged. The other hook, on `session.start`, only loads the custom rule files, so problems in them are reported right away. The plugin never modifies a tool call.

An error handler on the hook denies the call if the hook throws or times out before passing the call on.

## What it runs, sends, and fetches

- It runs a `tool.call` hook and a `session.start` hook, written in TypeScript (`hooks/*.ts`), inside Claude Code.
- It makes **no model calls**, **no network requests**, and **no shell commands**. Commands are only parsed, never executed.
- It reads only its two rule files, `~/.claude/bash-guardrails.json` and `.claude/bash-guardrails.json` under the project root (`$.fs.stat` and `$.fs.read`), and writes no files. To find the first, it reads the environment variables `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE`. It uses no credentials or MCP servers.
- It does not collect, store, or transmit any data. The only things it shows are confirmation dialogs (`run0_confirm` and your `ask` rules) and a transcript line for each rule that fails to load.
- Its dependencies are vendored and have no install step: the [unbash](https://github.com/webpro-nl/unbash) parser (ISC license, in `hooks/vendor/unbash/`) and the [cel-js](https://github.com/marcbachmann/cel-js) CEL interpreter (MIT license, bundled into `hooks/vendor/cel/`).

## Development

The rule logic is pure and kept free of the mods API: the CEL engine (`compileFile` and `decide`) in `hooks/engine.ts`, the argument parser in `hooks/argv.ts`, and the parser wrapper `analyze` in `hooks/shell.ts`. The built-in rules are data in `hooks/builtin-rules.ts`, compiled in `hooks/rules.ts`. `hooks/register.ts` loads the rule files and calls the engine. The unit tests are in `tests/`: `rules.test.ts` for the built-in rules, `engine.test.ts` for custom rules and the engine, and `register.test.ts` for the hooks.

```
claude plugin validate .
claude plugin test
```

## License

The plugin's own code is released into the public domain under the [Unlicense](LICENSE). The vendored code is **not** public domain: the unbash parser in `hooks/vendor/unbash/` is Copyright (c) Lars Kappert and licensed under the ISC License, and the cel-js interpreter in `hooks/vendor/cel/` is Copyright (c) 2025 Marc Bachmann and licensed under the MIT License, so the combined work is `Unlicense AND ISC AND MIT`. Their copyright and permission notices must be preserved in all copies; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), `hooks/vendor/unbash/LICENSE` and `hooks/vendor/cel/LICENSE`.

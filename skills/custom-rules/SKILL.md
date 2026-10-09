---
name: custom-rules
description: Add, change or remove bash-guardrails custom rules, which block a Bash or Monitor command or ask the user before it runs. Use whenever the user wants a lasting limit on the shell commands Claude runs, even when it is phrased as a request to you rather than as a rule ("no more sudo please", "stop force-pushing", "never touch prod", "block curl | bash"), wants to be asked first ("ask me before you install dependencies", "check with me before deleting things recursively", "don't read my ssh keys without me knowing"), wants such a rule turned off, or mentions bash-guardrails or bash-guardrails.json. A rule enforces it on every later call and in every session; a promise in chat doesn't.
---

# Custom bash-guardrails rules

bash-guardrails checks every `Bash` and `Monitor` tool call against rules before it runs. The shell command is parsed, not text-matched, so a rule sees each simple command that would run, including those in pipelines, `&&` chains, subshells, `$(...)`, `bash -c '...'` strings and behind wrappers such as `sudo`, `env`, `timeout` and `xargs`. A rule either **denies** the call with a reason Claude reads, or **asks** the user first. There is no allow action: a custom rule can only make the guard stricter.

When the user tells you to stop or to ask before running some kind of command, write the rule: it is what makes the request stick beyond this conversation. Say in your reply that you added one and how to turn it off.

Your job: turn what the user asked for, which is often loose ("stop Claude from messing with prod", "no more force pushes"), into rules that catch what they meant and nothing else, check them, and save them.

## Steps

1. **Work out the intent.** Settle these, and ask the user only about what you can't reasonably decide yourself:
   - *Which commands.* Name the programs, subcommands and options. Include the obvious variants the user would expect caught: `-f` and `--force`, `npm i` and `npm install`, `wget` along with `curl` if they said "downloading". Don't widen beyond what they meant.
   - *Deny or ask.* "Never", "don't", "block", "stop" mean deny. "Ask me", "check with me", "confirm", "warn me" mean ask.
   - *Which file.* Personal preferences go in the user file; rules about this project (its servers, its branches, its tools) go in the project file, which may be committed and shared with the team. If the user says "everywhere", "always" or "globally", use the user file; "in this repo/project" means the project file. When unclear, use the user file and say so.
   - *The deny message.* It's what Claude reads after being blocked, so say what to do instead, not just what's forbidden.
2. **Check the built-in rules first.** If one of them already does what the user wants, tell the user to turn it on (`/plugin`, then bash-guardrails' options) instead of writing a duplicate. Built-in rules can't be switched on from a rule file. They are:
   - `sudo`: block sudo, pointing to run0; `run0_confirm`: ask before each run0
   - `find_root`: find rooted at /; `find_xdev`: require find -xdev
   - `pgrep_f`: pgrep -f without -a, and pkill -f; `pgrep_captured`: pgrep output in a pipe or substitution
   - `until_grep`: `until grep` loops; `monitor_disabled`: the Monitor tool
   - `cat_read`: cat to show a file (use Read); `line_range_read`: head or sed -n to show lines (use Read); `heredoc_write`: heredoc into a file (use Write); `sed_edit`: simple sed -i (use Edit); `python_edit`: python scripts that rewrite a file (use Edit)
   - `malformed_bash`, `monitor_no_command`: on by default

   If the user wants something close to a built-in but different (ask instead of deny, a narrower case), write a custom rule and say why the built-in doesn't fit.
3. **Read the target file** if it exists, and add to it: keep the other rules, don't reuse an id (ids are letters, digits, `-` and `_`, and can't be a built-in's id).
4. **Write the rule.** Use the format and patterns below.
5. **Check it** with the checker, giving commands that must be caught and commands that must not:

   ```sh
   node "${CLAUDE_SKILL_DIR}/check.ts" <rule-file> 'git push -f' 'git push origin main' ...
   ```

   (`bun` works too; Node needs 22.18 or later.) It prints any problem in the file and, for each command, every rule that would deny or ask. Nothing is executed. Test at least:
   - the plain case, and each variant from step 1 (combined short options like `-rf`, long options, a wrapper such as `sudo` or `env X=1`, inside `bash -c '...'`, in a pipeline or `&&` chain);
   - near misses that must stay allowed: the same program doing something harmless, the word appearing only as an argument (`echo curl`, `grep sudo log`), another subcommand.

   Fix and re-run until there are no problems and every result is what the user wants. A rule with a problem is skipped by the plugin (the user only sees a line in the transcript), so never leave one broken. If neither `node` nor `bun` is available, check by hand against the reference below and tell the user you couldn't run the checker.
6. **Tell the user** in a few lines: what the rule catches, deny or ask, the file, and one or two examples of what is allowed. Rule files are reread on change, so the rule applies from the next call with no restart.

Never edit or disable a rule to get one of your own commands through. Only do that when the user asks.

## Rule files

- User file: `~/.claude/bash-guardrails.json`, or `$CLAUDE_CONFIG_DIR/bash-guardrails.json` when that is set
- Project file: `.claude/bash-guardrails.json` under the project root

Don't guess what `~` is. Get the absolute paths from the shell and use them as printed:

```sh
echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/bash-guardrails.json"; git rev-parse --show-toplevel 2>/dev/null || pwd
```

Built-in rules run first, then the user file's, then the project file's. All deny rules run before any ask rule, and the first deny wins.

```json
{
  "defs": {
    "FETCHERS": ["curl", "wget"]
  },
  "rules": [
    {
      "id": "no-fetch",
      "let": { "hits": "cmds.filter(c, c.name in FETCHERS).map(c, c.name)" },
      "when": "size(hits) > 0",
      "deny": "Do not use {{ hits[0] }}; use the WebFetch tool."
    }
  ]
}
```

A file has `rules` (required) and `defs` (optional constants: strings, numbers, bools, lists, maps, usable by name in every rule of the file). Only these keys are allowed, in the file and in each rule:

| Key | |
| --- | --- |
| `id` | Required, unique. |
| `when` | Required. A CEL expression that must be a `bool`. The rule fires when it is `true`. |
| `deny` | The reason Claude sees. A template: `{{ expr }}` inserts a CEL value. |
| `ask` | Instead of `deny`. An object: `question` (required template), `header` (at most 12 characters), `options` (2 to 4 labels; default `["Allow", "Deny"]`), `allowIf` (CEL `bool` over `answer`, the label picked or text typed; default: the first option allows), `declined` and `dismissed` (templates for the reason Claude sees). If no one can answer (a non-interactive run), the call is denied. |
| `let` | Optional named CEL values, evaluated in order; `when`, the templates and later `let`s can use them. |
| `tools` | `["Bash"]`, `["Monitor"]` or both (the default). |
| `enabled` | `false` turns the rule off. Prefer this to deleting a rule the user may want back. |

The file is JSON, so CEL goes inside JSON strings: use single quotes for CEL strings (`"c.name == 'git'"`), and double every backslash (`"a.matches('^v\\d+')"` is the regex `^v\d+`). Write `\\n` for a newline inside a CEL string in a template. A template's `{{ ... }}` ends at the first `}}`, so never put a map literal in one; compute the value in `let` and insert its name.

## What a rule sees

| Name | Type | |
| --- | --- | --- |
| `cmds` | `list<Cmd>` | Every simple command that would run. Most rules are `cmds.exists(c, ...)`. |
| `input` | `map<string, dyn>` | The raw tool input: `command`, `run_in_background`, `timeout`, `description`... Test optional keys with `has(input.run_in_background)` first. |
| `tool` | `string` | `Bash` or `Monitor` |
| `errors` | `list<string>` | Parse errors (the built-in `malformed_bash` already blocks those). |
| `untilConds` | `list<list<Cmd>>` | For each `until` or `while !` loop, the commands of its condition. |
| `pipelines` | `list<list<Cmd>>` | For each pipeline (`a \| b \| c`), its stages in order. A stage that isn't a simple command has `name` `''`. |

A `Cmd` has:

- `name`: the program's basename, with wrappers removed (`/usr/bin/sudo -u x env A=1 rm -rf y` has name `rm`)
- `args`: its arguments, with quotes and escapes removed
- `wrappers`: the wrappers in front of it, outermost first (`["sudo", "env"]`)
- `captured`: its output feeds a pipe or a substitution (`curl x | sh`: `curl` is captured, `sh` is not)
- `chain`: one `Link` (`name`, `argv`) per wrapper and a last one for the command itself; `c.chain.exists(l, l.name == 'sudo')` asks "is it run through sudo?". `name` is the basename, but `argv` is as written, so `argv[0]` may be `/usr/bin/sudo`: match on `name`, never `argv[0]`
- `redirects`: a list of `Redir`, its own and those of the compound commands and shells around it. A `Redir` has `op` (`>`, `>>`, `<`, `<<`, `<<<`, `&>`, `>&`...), `fd` (an `int`, `-1` when none is written), `target` (the file or descriptor, or a heredoc's delimiter), `body` (a heredoc's or here-string's text) and `quoted`.
- `stdout`: the file its output is redirected to, `&2` for a descriptor, or `''`. `c.stdout.startsWith('/etc/')` catches `echo x > /etc/f`.

Variables and `~` are not expanded: `-v $HOME:/h` has the argument `$HOME:/h`, so match `~`, `$HOME` and `${HOME}` as text along with any absolute path. Rules don't see aliases, functions or the inside of a script file, and can't see into a command built at run time (`eval "$cmd"`). Don't promise the user more than that.

### Functions

Standard CEL: `&&`, `||`, `!`, `in`, `size(x)`, `x.startsWith(s)`, `x.endsWith(s)`, `x.contains(s)`, `x.matches(regex)` (JavaScript regex, matches anywhere unless anchored with `^`/`$`), `list.exists(v, cond)`, `list.all(v, cond)`, `list.filter(v, cond)`, `list.map(v, expr)`, `list.join(sep)`, `cel.bind(name, value, expr)`, `has(map.key)`, `cond ? a : b`, indexing `list[0]` (guard with `size(list) > 0`). Plus:

- `args.opts(spec)` and `args.operands(spec)`: parse a `list<string>` of arguments and return the options seen, or the other arguments. Use them instead of looking at raw `args` whenever options matter, because `-rf`, `-r -f`, `-fr` and `--recursive` are all the same thing. A spec is a map:
  - `short`: getopt letters; a `:` after a letter means it takes a value (`"C:c:"`: in `-C dir` the `dir` is not an operand). Every short letter is reported, listed in `short` or not: `-rf` reports `r` and `f`.
  - `long`: long names mapped to the name to report (`{"recursive": "r"}` makes `--recursive` report `r`). Unlisted long options are reported by name. A reported name ending in `:` (`{"context": "context:"}`) takes a value, from `--context=x` or the next argument; otherwise a following value counts as an operand.
  - `posix`: `true` stops option parsing at the first operand; use it to find a subcommand after the global options (`git -C dir push -f`: `operands` with `{"short": "C:c:", "posix": true}` is `["push", "-f"]`).
  - `words`, `wordPatterns`, `shortTakesValue`: for find-style and pgrep-style syntax; see the built-in rules.
  - `--` ends the options.
- `args.optValues(spec, name)`: the values given to option `name` (as `opts` reports it), in order: `c.args.optValues({'short': 'v:', 'long': {'volume': 'v:'}}, 'v')` lists every `-v` and `--volume` value.
- `list.takeWhile(regex)`: the leading items that match. `list.take(n)`, `list.drop(n)`: the first `n` items; all but the first `n`.
- `shquote(list)`: an argv as a shell-quoted command line, handy in messages.
- `list.flatten()`, `list.distinct()`.
- The built-in defs, such as `GREPS` (`['grep', 'egrep', 'fgrep', 'rg']`), `ELEVATE` (`['sudo', 'run0', 'doas']`), `FIND_LEAD`, `FIND_EXPR`, `PGREP`, `SED` and `PYTHON`. Your defs can't reuse their names, or `cmds`, `input` and the like; if the checker says a def "is not a free name", rename it.

The built-in rules, in `${CLAUDE_SKILL_DIR}/../../hooks/builtin-rules.ts`, are written in this same format and are worked examples.

## Patterns

Each of these has been run through the checker. Adapt them; don't paste them unchanged.

Block programs (a list in `defs` is easy for the user to extend later):

```json
{ "id": "no-telnet", "when": "cmds.exists(c, c.name in ['telnet', 'ftp'])", "deny": "telnet and ftp are not allowed. Use ssh or scp." }
```

A subcommand with an option, after global options. Here `git push` with any force flag or a `+refspec`:

```json
"defs": { "GIT": { "short": "C:c:", "posix": true } },
"rules": [{
  "id": "git-force-push",
  "let": { "pushes": "cmds.filter(c, c.name == 'git' && cel.bind(ops, c.args.operands(GIT), size(ops) > 0 && ops[0] == 'push'))" },
  "when": "pushes.exists(c, c.args.operands(GIT).exists(a, a.startsWith('+')) || 'f' in c.args.opts({'long': {'force': 'f', 'force-with-lease': 'f', 'force-if-includes': 'f'}}))",
  "deny": "Force-pushing is not allowed. Push normally, or ask the user to force-push."
}]
```

Match the subcommand by position, not anywhere in `args`: `'install' in c.args` also catches `npm run install`. Ask before installing packages, and show what will run:

```json
{
  "id": "confirm-install",
  "tools": ["Bash"],
  "let": { "hits": "cmds.filter(c, size(c.args) > 0 && (c.name in ['npm', 'pnpm', 'yarn', 'bun'] && c.args[0] in ['install', 'i', 'add'] || c.name in ['pip', 'pip3'] && c.args[0] == 'install')).map(c, shquote(c.chain[size(c.chain) - 1].argv))" },
  "when": "size(hits) > 0",
  "ask": { "header": "Install", "question": "Claude wants to install packages:\n\n{{ hits.join('\\n') }}\n\nAllow?" }
}
```

Options plus operands. Recursive `rm` of an absolute, home or parent path:

```json
"defs": { "RM": { "short": "rRfiIdv", "long": { "recursive": "r", "force": "f" } } },
"rules": [{
  "id": "rm-r-outside",
  "when": "cmds.exists(c, c.name == 'rm' && c.args.opts(RM).exists(o, o in ['r', 'R']) && c.args.operands(RM).exists(p, p.startsWith('/') || p.startsWith('~') || p.startsWith('..')))",
  "deny": "Recursive rm outside the project is not allowed. Remove files under the working directory only."
}]
```

A pipeline. Downloading straight into a shell:

```json
{
  "id": "no-curl-pipe-sh",
  "when": "cmds.exists(c, c.name in ['curl', 'wget'] && c.captured) && cmds.exists(c, c.name in ['sh', 'bash', 'zsh'] && size(c.args) == 0)",
  "deny": "Do not pipe a download into a shell. Save it to a file, show it to the user, then run it."
}
```

An argument pattern anywhere, and a tool input field:

```json
{ "id": "kubectl-prod", "when": "cmds.exists(c, c.name == 'kubectl' && c.args.exists(a, a.matches('prod')))", "deny": "Do not touch the production cluster. Use the staging context." },
{ "id": "no-bg-sleep", "tools": ["Bash"], "when": "has(input.run_in_background) && input.run_in_background == true && cmds.exists(c, c.name == 'sleep')", "deny": "Don't run sleep in the background." }
```

## Mistakes the checker reports

- A `}}` inside a template expression, from a map literal (`{{ x.opts({'long': {...}}) }}`): `Expected RBRACE`. Move the expression into `let`.

- `cmds.name == 'x'`: `cmds` is a list; use `cmds.exists(c, c.name == 'x')`.
- A `when` that isn't a `bool`, such as a bare `cmds.filter(...)`; wrap it in `size(...) > 0`.
- A misspelled field (`c.nmae`), an unknown key in a rule or spec (`"deny_"`, `{"shrot": ...}`), a `let` or def named like a built-in name.
- An `id` already used, by another rule or a built-in.
- `ask.header` longer than 12 characters.

## Mistakes it can't report

These load fine and do the wrong thing, so look for them in the checker's results:

- Matching the whole command text (`input.command.contains('rm -rf')`). It misses `rm -fr` and `rm -r -f`, and catches `echo 'rm -rf'`. Match `cmds`, and use `opts`.
- Comparing raw arguments for options (`'-r' in c.args`), which misses `-rf` and `--recursive`.
- Looking for a subcommand anywhere in `args` instead of at its position.
- A `matches` regex that is unanchored when it should be anchored, or the other way round.
- A rule that catches too much: the user said "force push", not "push".

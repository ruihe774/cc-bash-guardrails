# v0.2 design: custom rules in a DSL

Status: **implemented in v0.2** (see the main README's "Custom rules"). Nothing here is loaded by the plugin.

The prototypes diff against the v0.1 rule code (`firstDenial`, `run0Invocations` in `hooks/rules.ts`), which v0.2 removed. To run them, check out commit `001d692` first.

Decisions taken in the implementation, where this note left them open or differs:

- **Ask order:** every deny rule (built-in, then the user file, then the project file) runs before any `ask` rule, so the user is never asked about a call that is then denied.
- **`monitor-no-command`** is its own rule with its own toggle (`monitor_no_command`, on by default).
- **Problems are reported with `$.ui.log`** (a transcript line), not `$.ui.notice`, which only annotates an open tool dialog.
- **Rule files:** `~/.claude/bash-guardrails.json` (or `$CLAUDE_CONFIG_DIR/bash-guardrails.json`) and `.claude/bash-guardrails.json` under `$.session.root()`. Plain JSON. Custom files see the built-in defs, may not redefine them, and may not reuse a built-in id. Custom rules can set `"enabled": false` on themselves only.
- **The built-in rule file** is `hooks/builtin-rules.ts`: the mod loader imports only code files, not `.json`.
- **`let` types** are inferred by the type checker, not fixed to `list<string>`. **`Cmd` and `Link`** are registered with constructors, since cel-js rejects indexing (`c.chain[0]`) into plain objects of a registered type.
- **`ask`** defaults: options `Allow`/`Deny`, allowed when the answer is the first option, and generic `declined` / `dismissed` texts.

Goal: let users write their own guard rules. Gate: the v0.1 rules must be expressible in the same DSL, so no rule stays "first-class" in code.

**Recommendation: CEL, using [`@marcbachmann/cel-js`](https://www.npmjs.com/package/@marcbachmann/cel-js), vendored as a single bundled file.** Jexl also passes the gate, but CEL type-checks rules when they load, and its macros take named variables. Together those remove the ways Jexl rules go wrong without any error.

## Results

Both prototypes write all nine v0.1 rules (including the `run0` confirmation) as data and diff them against the v0.1 code (`firstDenial`, `run0Invocations`):

- **Inputs:** every command string in `tests/rules.test.ts` plus a few edge cases (198 strings), under both tools (`Bash`, `Monitor`), five option configs, and three input shapes (`{command}`, `{}`, `{ws}`).
- **Result:** 6,138 comparisons. **0 mismatches** for both Jexl and CEL.
- **Cost per call:** CEL 0.020–0.023 ms, Jexl 0.027 ms, v0.1 0.043 ms. The DSL versions parse the command once per call, while v0.1 re-parses it for each rule.
- **Runtime check:** cel-js, bundled into one file, loads and runs inside the real mod runtime (`claude plugin validate` and `claude plugin test` both pass).

## Design

### What a rule sees

```
tool        string                     'Bash' | 'Monitor'
input       map<string, dyn>           the raw tool input (command, ws, run_in_background, ...)
cmds        list<Cmd>                  every simple command, as analyze() finds it
errors      list<string>               parse errors (non-empty: cmds may be incomplete)
untilConds  list<list<Cmd>>            per `until` / `while !` loop, the commands of its condition
<DEFS>      constants from the rule file's "defs"

Cmd   { name: string, args: list<string>, captured: bool, wrappers: list<string>, chain: list<Link> }
Link  { name: string, argv: list<string> }   // each wrapper's invocation, then the command itself
```

`chain` replaces the two parallel lists in `SimpleCommand` (`wrappers[]` and `wrapped[][]`). A DSL can't pair up items from two lists by position, and `run0` and `sudo` both need that pairing.

### Rule file

```jsonc
{
  "defs": { "FIND_EXPR": { "words": { "-name": 1, "-exec": [";", "+"] /* ... */ } }, "GREPS": ["grep", "egrep", "fgrep", "rg"] },
  "rules": [
    {
      "id": "find-xdev",
      "tools": ["Bash", "Monitor"],
      "when": "cmds.exists(c, c.name == 'find' && !c.args.opts(FIND_EXPR).exists(o, o in ['-xdev', '-mount']))",
      "deny": "find must specify -xdev ..."
    },
    {
      "id": "run0-confirm",
      "tools": ["Bash", "Monitor"],
      "let": { "items": "cmds.map(c, c.chain.filter(l, l.name == 'run0').map(l, shquote(l.argv))).flatten().distinct()" },
      "when": "size(items) > 0",
      "ask": {
        "header": "run0",
        "question": "Allow Claude to run with elevated privileges via run0?\n\n{{ items.map(i, '  ' + i).join('\\n') }}\n\n...",
        "options": ["Allow", "Deny"],
        "allowIf": "answer == 'Allow'",
        "declined": "The user declined run0{{ answer == 'Deny' ? '' : ': ' + answer }}. Do not retry without asking.",
        "dismissed": "run0 was not approved: ..."
      }
    }
  ]
}
```

See `rules-cel.json` for all nine rules.

- **`when`** is a CEL expression that must type-check to `bool`.
- **Actions** are `deny` or `ask`. There is deliberately **no `allow` action**: rules can only make the guard stricter.
- **`{{ expr }}`** in messages and questions inserts a value, and is type-checked like `when`.
- **`let`** names a value that `when` and the messages share. Inside a single expression, `cel.bind(name, value, expr)` already does this.
- **Order:** rules run in file order and the first `deny` wins. An `ask` the user allows moves on to the next rule, so asks go last, as `run0_confirm` does today.

### Built-in functions

These are generic: the domain knowledge (which `find` primaries take a value, which `pgrep` options take an argument) lives in the rule file's `defs`.

| Function | Why CEL needs it |
|---|---|
| `list<string>.opts(spec)`, `.operands(spec)` | A spec-driven argument parser (getopt short options, long-option aliases, find-style single-dash words with an arity or a terminator such as `-exec … ;`, and POSIX stop-at-first-operand). `find-xdev` needs a stateful scan over the arguments, which CEL can't express. This is the one thing that makes the gate pass. |
| `list<string>.takeWhile(regex)` | For `find`'s start points. A registered function can't take a lambda, so it takes a regex. |
| `shquote(list<string>)` | For showing `run0` commands. |
| `flatten()`, `distinct()` | Not built into cel-js. |

Spec quirk to keep: in the `pgrep` spec, `shortTakesValue` means an option that takes a value takes it only from the rest of the same argument, never from the next argument. That matches v0.1, so `pgrep -u -f` stays denied. A strict getopt would read `-f` as the user name.

### Where rules come from

- **Built-in rules** ship as a rule file inside the plugin. The `userConfig` booleans keep working, keyed by rule id (`find-xdev` → `find_xdev`).
- **Custom rules** come from files, not `userConfig`. `userConfig` can hold a `string[]`, but a regex inside a CEL string inside JSON gets escaped three times over; raw strings (`r'...'`) remove one layer. Candidate locations are `~/.claude/bash-guardrails.json` and a project file.
- **Project rules may only add rules.** They can never disable a built-in or user rule, and since there is no `allow` action, a malicious project file can at worst block calls or ask.
- **Load once, reload on change:** read and compile at `session.start`, and re-check the file's mtime on each call (`$.fs.stat`).
- **Docs and manifest:** the README's "does not read or write any files" statement has to change, and `fs.read` / `fs.stat` will appear in the module's declared uses (`plugin.register` `uses`).

### Failure handling

- **A rule that fails to parse or type-check** is skipped, and the user sees a notice (`$.ui.notice`) naming the rule and the CEL error. Failing closed here would block every Bash call until the file is fixed.
- **An error while a rule runs** denies the call, matching v0.1's `.catch` handler.

### Small behaviour changes to decide on

- **Monitor without a command** becomes its own rule (`monitor-no-command`). In v0.1 this refusal fires only when at least one shell rule is enabled. The prototypes copy that in code, but v0.2 should give it its own toggle.
- **The run0 prompt order** becomes "wherever the `ask` rule sits", rather than hard-coded after all denies.

## CEL vs Jexl

| | Jexl 2.3.0 | CEL (`@marcbachmann/cel-js` 8.0.0) |
|---|---|---|
| Passes the gate | yes (with the argument parser) | yes (with the argument parser) |
| Lambdas / named variables | none; only `.` in a filter, and a nested filter can't refer to the outer item | `exists`, `all`, `exists_one`, `filter`, `map` with named variables; `cel.bind` for locals |
| Checked when rules load | no | yes, against the declared shape of the data rules see |
| `cmds.name == 'find'` | **quietly checks the first command only** (the regex-hook bug this plugin exists to avoid) | rejected: `List index must be int` |
| `cmds.length` | `undefined`; you need `\|len` | rejected |
| Empty list as a condition | truthy | rejected: `Ternary condition must be bool` |
| `x.toString`, `x.constructor` | fail to parse (name lookup on a plain object) | rejected (`Cannot index type 'string'`) |
| Typos (`c.nmae`) | quietly `undefined` | rejected: `No such key: nmae` |
| Regex | via functions you register | `matches()`, using JavaScript `RegExp` rather than the RE2 the CEL spec calls for: lookaheads work, but there's no protection from a slow user regex (same as Jexl) |
| Ints | JavaScript numbers | `BigInt`: functions you register must return `bigint` for `int` |
| Package | CommonJS plus `@babel/runtime`; ~2k lines to convert to ES modules by hand; last release 2020 | ES modules, no dependencies, MIT; actively maintained |
| In the mod runtime | no codegen (interpreter) | no codegen; `Buffer` use is guarded; **loads only once bundled** (see below) |

Ruled out:

- **Compile-to-JS libraries** (such as filtrex): the mod runtime makes `eval` and `new Function` throw.
- **`@bufbuild/cel`**: follows the CEL spec more strictly and has a pure-JS RE2, but it is ~24k lines plus `@bufbuild/re2`, protobuf and cel-spec packages.

### Vendoring cel-js

Copied as-is, its 18 files fail in the mod runtime with `Cannot access 'UnsignedInt' before initialization`: `functions.js` and `registry.js` import each other, which bun and Node tolerate but the mod loader doesn't. A single-file bundle works:

```
bun build node_modules/@marcbachmann/cel-js/lib/index.js --format=esm --target=browser --outfile=hooks/vendor/cel.js
```

That gives one 155 KB file of about 4.5k lines. Record the version and this command in `THIRD_PARTY_NOTICES.md`; unlike unbash, the vendored file is a build output.

## Files here

| File | What it is |
|---|---|
| `rules-cel.json`, `proto-cel.ts` | CEL rule file; the typed environment, built-in functions, engine and diff harness. It also prints how the type checker handles the Jexl traps. |
| `rules-jexl.json`, `proto-jexl.ts` | The same in Jexl, kept for comparison. It prints the Jexl traps. |
| `mod-probe/`, `probe.sh` | A minimal mod that runs bundled cel-js in the real mod runtime. Its test is named `.mod-test.ts` so the repo's own `claude plugin test` doesn't pick it up; `probe.sh` copies it to a temp dir, bundles cel-js and runs it. |

The prototypes import `hooks/shell.ts` and `hooks/rules.ts`, and read `tests/rules.test.ts` for their inputs, so they keep diffing against the current rules as those change. The harness pulls every quoted string out of the test file, so non-command strings get checked too; that does no harm.

Run them (needs [bun](https://bun.sh); `probe` also needs `claude`):

```
cd design/v0.2-custom-rules
bun install
bun run cel      # expect: 0 mismatches
bun run jexl     # expect: 0 mismatches
bun run probe    # expect: 2 pass
```

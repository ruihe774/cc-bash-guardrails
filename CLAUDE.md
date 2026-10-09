# bash-guardrails

A Claude Mod (new feature, v2.1.287+) that enforces guard rules on tool calls. A mod is a plugin directory whose hooks run as JS/TS middleware. Rules, built-in and custom alike, are written in CEL (v0.2).

## Layout

Only `plugin/` is the plugin and gets installed; everything else at the root (design, docs) stays in the repo.

- `plugin/.claude-plugin/plugin.json`: manifest
- `plugin/hooks/hooks.json`: `modules` points to `./register.ts`
- `plugin/hooks/register.ts`: exports `register(on, options)`; loads the custom rule files and calls the engine
- `plugin/hooks/builtin-rules.ts`: the built-in rules, as rule-file data; compiled and toggled in `plugin/hooks/rules.ts`
- `plugin/hooks/engine.ts`: the CEL engine (compile, type-check, decide); `plugin/hooks/argv.ts`: the spec-driven argument parser; `plugin/hooks/shell.ts`: shell parsing
- `plugin/skills/custom-rules/`: the skill Claude follows to write custom rules for a user; `check.ts` runs the engine under `node`/`bun`, so keep `plugin/hooks/*.ts` loadable by plain type stripping (no parameter properties, enums or namespaces)
- `plugin/hooks/vendor/`: vendored code, don't edit (`cel/cel.js` is a bun bundle; see `plugin/THIRD_PARTY_NOTICES.md` to rebuild it)
- `design/`: design notes and prototypes, not loaded by the plugin
- `plugin/tests/*.test.ts`: run with `claude plugin test plugin`

## Conventions

- Register with `on('tool.call', { tool: 'Bash' }, async ($, e, next) => ...)`.
- Return `next(e)` to allow, `{ deny: reason }` to block. `e` is frozen; pass a copy to `next` to modify.
- Always call the mods API in full: `$.fs.read(...)`, never destructured. Only `register.ts` touches `$`; keep the rest pure.
- A hooks module can import only code files (no `.json`), so built-in data lives in `.ts` modules.
- A new built-in rule needs a matching boolean `userConfig` option (its id with `_`) in `plugin/.claude-plugin/plugin.json`.
- Types live in `plugin/.claude-plugin/types/claude-code/index.d.ts` (generated per version, authoritative). Load the mod with `claude --plugin-dir plugin` to regenerate.

## Docs (downloaded; consult before changing APIs)

- `docs/mods-reference.md`: events, API methods, limits
- `docs/mods-create.md`: writing a mod
- `docs/mods-test.md`: testing

Mods change between releases; if docs and types disagree, trust the types.

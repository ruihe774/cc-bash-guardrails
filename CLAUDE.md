# bash-guardrails

A Claude Mod (new feature, v2.1.287+) that enforces guard rules on tool calls. A mod is a plugin directory whose hooks run as JS/TS middleware.

## Layout

- `.claude-plugin/plugin.json`: manifest
- `hooks/hooks.json`: `modules` points to `./register.ts`
- `hooks/register.ts`: exports `register(on, options)`; rules in `hooks/rules.ts`, shell parsing in `hooks/shell.ts`
- `hooks/vendor/`: vendored code, don't edit
- `tests/*.test.ts`: run with `claude plugin test`

## Conventions

- Register with `on('tool.call', { tool: 'Bash' }, async ($, e, next) => ...)`.
- Return `next(e)` to allow, `{ deny: reason }` to block. `e` is frozen; pass a copy to `next` to modify.
- Always call the mods API in full: `$.fs.read(...)`, never destructured.
- Types live in `.claude-plugin/types/claude-code/index.d.ts` (generated per version, authoritative). Load the mod with `claude --plugin-dir .` to regenerate.

## Docs (downloaded; consult before changing APIs)

- `docs/mods-reference.md`: events, API methods, limits
- `docs/mods-create.md`: writing a mod
- `docs/mods-test.md`: testing

Mods change between releases; if docs and types disagree, trust the types.

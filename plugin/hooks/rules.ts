// The built-in rules, compiled once, and the userConfig toggles that switch them.
// Kept free of the mods API so it can be unit tested.
import { builtinRules } from './builtin-rules.ts'
import { compileFile, type CompiledRule } from './engine.ts'

export const builtin = compileFile(builtinRules, 'built-in', { isBuiltin: true })
// The shipped rules are part of the code: a broken one is a bug, not a user's typo
if (builtin.problems.length)
  throw new Error(`bash-guardrails: built-in rules failed to compile: ${builtin.problems.map((p) => `${p.id}: ${p.message}`).join('; ')}`)

export const builtinIds = builtin.rules.map((r) => r.id)

// The userConfig key that toggles a built-in rule: its id with underscores
export const ruleKey = (id: string) => id.replace(/-/g, '_')

// Defaults live in the manifest's userConfig, which Claude Code fills into
// options; a built-in whose option is missing is off. Custom rules carry their own `enabled`.
export const ruleEnabled = (options: Record<string, unknown> | undefined) => (r: CompiledRule) =>
  r.isBuiltin ? options?.[ruleKey(r.id)] === true : r.enabled

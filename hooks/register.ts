import { compileText, decide, type CompiledFile, type CompiledRule } from './engine.ts'
import { builtin, builtinIds, ruleEnabled } from './rules.ts'

// Custom rule files, in the order their rules run: the user's, then the project's
export const USER_FILE = 'bash-guardrails.json' // in the Claude config dir (~/.claude)
export const PROJECT_FILE = '.claude/bash-guardrails.json' // under the project root

interface Cached {
  mtimeMs: number
  size: number
  compiled: CompiledFile
}
const cache = new Map<string, Cached>()

const join = (dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}/${file}`

// One rule file, compiled again only when it changed. Problems are logged once per change.
async function loadFile($: any, path: string): Promise<CompiledRule[]> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file') {
    cache.delete(path)
    return []
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.compiled.rules
  let compiled: CompiledFile
  try {
    const text = await $.fs.read(path)
    // Custom rules build on the built-in defs, and may not reuse a built-in id
    compiled = compileText(text, path, { env: builtin.env, reservedIds: builtinIds })
  } catch (err) {
    compiled = { rules: [], problems: [{ source: path, message: `cannot read: ${(err as Error)?.message ?? err}` }], env: builtin.env }
  }
  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, compiled })
  for (const p of compiled.problems)
    $.ui.log(`bash-guardrails: ${p.source}: ${p.id === undefined ? '' : `rule ${p.id}: `}${p.message} (skipped)`)
  return compiled.rules
}

// The custom rules from both files. A file that can't be found contributes nothing.
async function customRules($: any): Promise<CompiledRule[]> {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || join((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '', '.claude')
  const userPath = join(configDir, USER_FILE)
  const projectPath = join(await $.session.root(), PROJECT_FILE)
  const user = await loadFile($, userPath)
  // Opened from the config dir's parent, the project file is the user file
  return projectPath === userPath ? user : [...user, ...(await loadFile($, projectPath))]
}

export function register(on: any, options?: Record<string, unknown>) {
  // Report problems in the rule files when the session starts, not at the first Bash call
  on('session.start', async ($: any, e: any, next: any) => {
    await customRules($).catch(() => [])
    return next(e)
  })

  on('tool.call', { tool: ['Monitor', 'Bash'] }, async ($: any, e: any, next: any) => {
    const custom = await customRules($)
    const { tool, ...input } = e
    const reason = await decide(
      [...builtin.rules, ...custom],
      tool,
      input,
      ruleEnabled(options),
      (question, opts) => $.ui.ask(question, opts),
      // Name the rule only: the command is in the verbose transcript (Ctrl+O)
      (rule) => {
        try { $.ui.toast(`Rule '${rule.id}' denied a command`) } catch {}
      },
    )
    return reason ? { deny: reason } : next(e)
  }).catch(async ($: any, e: any, next: any) => {
    // Without this a failed hook is skipped and the call runs unguarded
    if (next.called) return next(e)
    return { deny: `bash-guardrails failed (${next.error.message}); refusing the call rather than running it unchecked.` }
  })
}

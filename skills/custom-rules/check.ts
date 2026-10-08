// Checks a custom rule file the way the plugin loads it, and shows what its
// rules decide for sample commands. Run with Node 22.18+ or Bun:
//
//   node check.ts <rule-file> ['<command>' | '{"tool": "Monitor", "command": ...}'] ...
//
// Nothing is executed: each command is only parsed and run through the rules.
// Exits 1 when the file has problems (those rules would be skipped).
import { readFileSync } from 'node:fs'
import { compileText, decide, type CompiledRule } from '../../hooks/engine.ts'
import { builtin, builtinIds } from '../../hooks/rules.ts'

const [path, ...samples] = process.argv.slice(2)
if (!path) {
  console.error('usage: check.ts <rule-file> [command | tool-input JSON] ...')
  process.exit(2)
}

let text: string
try {
  text = readFileSync(path, 'utf8')
} catch (e) {
  console.error(`${path}: cannot read: ${(e as Error).message}`)
  process.exit(1)
}
const { rules, problems } = compileText(text, path, { env: builtin.env, reservedIds: builtinIds })
console.log(`${path}: ${rules.length} rule(s) loaded${rules.length ? ` (${rules.map((r) => r.id).join(', ')})` : ''}`)
for (const p of problems) console.log(`  PROBLEM ${p.id === undefined ? '' : `rule ${p.id}: `}${p.message} (skipped)`)
if (!problems.length) console.log('  no problems')

// Every rule that would act on the call, not just the first, so overlaps show up.
// An ask is answered with its first option, which allows it by default.
async function verdicts(r: CompiledRule, tool: string, input: Record<string, unknown>): Promise<string[]> {
  const asked: string[] = []
  const reason = await decide([r], tool, input, (x) => x.enabled, async (question, opts) => {
    asked.push(`ask   ${r.id}: ${question.replace(/\n/g, '\n        ')}`)
    return opts.options[0]!
  })
  return [...asked, ...(reason === null ? [] : [`${asked.length ? 'then deny' : 'deny'}  ${r.id}: ${reason}`])]
}

for (const s of samples) {
  let tool = 'Bash'
  let input: Record<string, unknown> = { command: s }
  if (s.trimStart().startsWith('{')) {
    try {
      ;({ tool = 'Bash', ...input } = JSON.parse(s))
    } catch (e) {
      console.log(`\n${s}\n  not valid JSON: ${(e as Error).message}`)
      continue
    }
  }
  console.log(`\n${tool === 'Bash' ? '$' : `${tool}:`} ${typeof input.command === 'string' ? input.command : JSON.stringify(input)}`)
  const lines = (await Promise.all(rules.map((r) => verdicts(r, tool, input)))).flat()
  const off = rules.filter((r) => !r.enabled).map((r) => r.id)
  for (const l of lines.length ? lines : ['allow (no rule matches)']) console.log(`  ${l}`)
  if (off.length) console.log(`  (not run, enabled: false: ${off.join(', ')})`)
}
process.exit(problems.length ? 1 : 0)

// v0.2 feasibility prototype (see README.md): the v0.1 rules written in Jexl, diffed against firstDenial.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { analyze } from '../../hooks/shell.ts'
import { firstDenial, rules as builtin, ruleKey, run0Invocations } from '../../hooks/rules.ts'

const require = createRequire(import.meta.url)
const { Jexl } = require('jexl')
const jexl = new Jexl()

// ---- generic stdlib (no rule-specific knowledge) ----
const arr = (v: any) => (Array.isArray(v) ? v : [])
jexl.addTransform('len', (v: any) => (v == null ? 0 : v.length))
jexl.addTransform('any', (v: any) => arr(v).length > 0)
jexl.addTransform('type', (v: any) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v))
jexl.addTransform('flatten', (v: any) => arr(v).flat())
jexl.addTransform('pluck', (v: any, k: string) => arr(v).map((x) => x?.[k]))
jexl.addTransform('unique', (v: any) => [...new Set(arr(v))])
jexl.addTransform('join', (v: any, s: string) => arr(v).join(s))
jexl.addTransform('indent', (v: any, p: string) => arr(v).map((x) => p + x))
jexl.addTransform('test', (v: any, re: string) => typeof v === 'string' && new RegExp(re).test(v))
jexl.addTransform('some', (v: any, re: string) => arr(v).some((x) => new RegExp(re).test(x)))
jexl.addTransform('takeWhile', (v: any, re: string) => {
  const r = new RegExp(re), out = []
  for (const x of arr(v)) { if (!r.test(x)) break; out.push(x) }
  return out
})
const shq = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)
jexl.addTransform('shjoin', (v: any) => arr(v).map((argv: string[]) => argv.map(shq).join(' ')))

// getopt-ish argv parser driven entirely by a spec
interface Spec {
  short?: string // getopt optstring ("D:" takes a value); with shortTakesValue, listed letters take a value, others are flags
  shortTakesValue?: boolean
  long?: Record<string, string> // --long -> canonical name
  words?: Record<string, number | string[]> // single-dash words: arity, or terminator tokens
  wordPatterns?: Record<string, number>
  posix?: boolean // stop at first operand
}
function parseArgs(args: string[], spec: Spec) {
  const opts: string[] = [], operands: string[] = []
  const takesVal = (ch: string) =>
    spec.shortTakesValue ? spec.short!.includes(ch) : (spec.short ?? '').includes(ch + ':')
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--' && !spec.words) { operands.push(...args.slice(i + 1)); break }
    if (spec.words && a.startsWith('-') && a.length > 1) {
      let ar = spec.words[a]
      if (ar === undefined) for (const [re, n] of Object.entries(spec.wordPatterns ?? {})) if (new RegExp(re).test(a)) ar = n
      opts.push(a)
      if (Array.isArray(ar)) { while (i + 1 < args.length && !ar.includes(args[i]!)) i++ }
      else i += ar ?? 0
      continue
    }
    if (a.startsWith('--') && spec.long) { const n = a.slice(2).split('=')[0]!; opts.push(spec.long[n] ?? n); continue }
    if (/^-[^-]/.test(a) && !spec.words) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j]!
        opts.push(ch)
        if (takesVal(ch)) { if (j === a.length - 1 && !spec.shortTakesValue) i++; break }
      }
      continue
    }
    operands.push(a)
    if (spec.posix) { operands.push(...args.slice(i + 1)); break }
  }
  return { opts, operands }
}
jexl.addTransform('opts', (v: any, spec: Spec) => parseArgs(arr(v), spec).opts)
jexl.addTransform('operands', (v: any, spec: Spec) => parseArgs(arr(v), spec).operands)

// ---- engine ----
const file = JSON.parse(readFileSync(new URL('./rules-jexl.json', import.meta.url), 'utf8'))
const compiled = file.rules.map((r: any) => ({
  ...r,
  when: jexl.compile(r.when),
  let: Object.fromEntries(Object.entries(r.let ?? {}).map(([k, v]) => [k, jexl.compile(v as string)])),
}))
const tmpl = (s: string, ctx: any) => s.replace(/\{\{(.*?)\}\}/gs, (_, e) => String(jexl.evalSync(e, ctx)))

function context(tool: string, input: any) {
  const a = typeof input.command === 'string' ? analyze(input.command) : { commands: [], errors: [], untilClauses: [] }
  const cmds = a.commands.map((c) => ({
    ...c,
    chain: [...c.wrappers.map((w, i) => ({ name: w, argv: c.wrapped[i] })), { name: c.name, argv: [c.name, ...c.args] }],
  }))
  return { tool, input, cmds, errors: a.errors, untilConds: a.untilClauses.map((u) => u.map((c) => ({ name: c.name, args: c.args }))), defs: file.defs }
}

export function dslDenial(tool: string, input: any, options: any): string | null {
  const ctx: any = context(tool, input)
  for (const r of compiled) {
    if (!r.tools.includes(tool) || r.ask) continue
    // keep v0.1's enabling: monitor-no-command fires only if some shell rule is on (approximation, see notes)
    if (r.id === 'monitor-no-command') { if (!builtin.some((b) => b.tool === 'Bash' && options?.[ruleKey(b.id)] === true)) continue }
    else if (options?.[ruleKey(r.id)] !== true) continue
    if (tool === 'Monitor' && r.id !== 'monitor-disabled' && r.id !== 'monitor-no-command' && typeof input.command !== 'string') continue
    for (const [k, e] of Object.entries(r.let)) ctx[k] = (e as any).evalSync(ctx)
    if (r.when.evalSync(ctx)) return tmpl(r.deny, ctx)
  }
  return null
}
export function dslRun0(command: string) {
  const r = compiled.find((x: any) => x.id === 'run0-confirm')
  return r.let.items.evalSync(context('Bash', { command }))
}

// ---- diff against v0.1 over every command string in the test file ----
const src = readFileSync(new URL('../../tests/rules.test.ts', import.meta.url), 'utf8')
const strs = new Set<string>()
for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
  try { strs.add(m[1] === '`' ? m[2]! : JSON.parse('"' + m[2]!.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"')) } catch {}
}
const extra = ['pgrep -u -f foo', 'find . -D tree / ', 'env A=1 sudo run0 ls', 'x=$(pgrep -f a)', 'cat <(sudo id)']
const ALL = Object.fromEntries(builtin.map((r) => [ruleKey(r.id), true]))
const configs = [ALL, { ...ALL, monitor_disabled: false }, { sudo: true }, { find_xdev: true }, {}]
let n = 0, bad = 0
for (const s of [...strs, ...extra]) for (const tool of ['Bash', 'Monitor']) for (const o of configs) {
  for (const input of [{ command: s }, {}, { ws: {} }]) {
    n++
    const want = firstDenial(tool, input as any, o), got = dslDenial(tool, input, o)
    if (want !== got) { bad++; if (bad < 15) console.log('MISMATCH', tool, JSON.stringify(input), JSON.stringify(o).slice(0, 40), '\n  v0.1:', want, '\n  dsl :', got) }
  }
}
for (const s of [...strs, ...extra]) {
  n++
  const want = JSON.stringify(run0Invocations(s)), got = JSON.stringify(dslRun0(s))
  if (want !== got) { bad++; console.log('RUN0 MISMATCH', JSON.stringify(s), want, got) }
}
console.log(`${n} comparisons over ${strs.size + extra.length} command strings, ${bad} mismatches`)

// timing
const t0 = performance.now()
for (let i = 0; i < 2000; i++) dslDenial('Bash', { command: 'cd /x && env A=1 timeout 5 find . -xdev -name y | xargs pgrep -af foo' }, ALL)
const t1 = performance.now()
for (let i = 0; i < 2000; i++) firstDenial('Bash', { command: 'cd /x && env A=1 timeout 5 find . -xdev -name y | xargs pgrep -af foo' }, ALL)
console.log(`per call: dsl ${((t1 - t0) / 2000).toFixed(3)}ms, v0.1 ${((performance.now() - t1) / 2000).toFixed(3)}ms`)

// footguns
const ctx = context('Bash', { command: 'ls; find /' })
console.log('cmds.name ->', jexl.evalSync('cmds.name', ctx), '| cmds.length ->', jexl.evalSync('cmds.length', ctx), '| empty filter truthy ->', jexl.evalSync("cmds[.name == 'nope'] ? 'yes' : 'no'", ctx))

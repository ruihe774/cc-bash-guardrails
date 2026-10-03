// v0.2 feasibility prototype (see README.md): the v0.1 rules written in CEL (@marcbachmann/cel-js), diffed against firstDenial.
import { readFileSync } from 'node:fs'
import { Environment } from '@marcbachmann/cel-js'
import { analyze } from '../../hooks/shell.ts'
import { firstDenial, rules as builtin, ruleKey, run0Invocations } from '../../hooks/rules.ts'

const file = JSON.parse(readFileSync(new URL('./rules-cel.json', import.meta.url), 'utf8'))

// ---- generic argv parser, same as the Jexl prototype ----
interface Spec {
  short?: string; shortTakesValue?: boolean; long?: Record<string, string>
  words?: Record<string, number | string[]>; wordPatterns?: Record<string, number>; posix?: boolean
}
const plain = (v: any): any => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : Array.isArray(v) ? v.map(plain) : typeof v === 'bigint' ? Number(v) : v)
function parseArgs(args: string[], spec: Spec) {
  const opts: string[] = [], operands: string[] = []
  const takesVal = (ch: string) => (spec.shortTakesValue ? spec.short!.includes(ch) : (spec.short ?? '').includes(ch + ':'))
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--' && !spec.words) { operands.push(...args.slice(i + 1)); break }
    if (spec.words && a.startsWith('-') && a.length > 1) {
      let ar = spec.words[a]
      if (ar === undefined) for (const [re, n] of Object.entries(spec.wordPatterns ?? {})) if (new RegExp(re).test(a)) ar = n
      opts.push(a)
      if (Array.isArray(ar)) { while (i + 1 < args.length && !ar.includes(args[i]!)) i++ } else i += ar ?? 0
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
const shq = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

// ---- environment: typed context + generic functions ----
const base = new Environment({ homogeneousAggregateLiterals: false })
  .registerType('Link', { fields: { name: 'string', argv: 'list<string>' } })
  .registerType('Cmd', { fields: { name: 'string', args: 'list<string>', captured: 'bool', wrappers: 'list<string>', chain: 'list<Link>' } })
  .registerVariable('tool', 'string')
  .registerVariable('input', 'map<string, dyn>')
  .registerVariable('cmds', 'list<Cmd>')
  .registerVariable('errors', 'list<string>')
  .registerVariable('untilConds', 'list<list<Cmd>>')
  .registerFunction('list<string>.opts(map<string, dyn>): list<string>', (a: string[], s: any) => parseArgs(a, plain(s)).opts)
  .registerFunction('list<string>.operands(map<string, dyn>): list<string>', (a: string[], s: any) => parseArgs(a, plain(s)).operands)
  .registerFunction('list<string>.takeWhile(string): list<string>', (a: string[], re: string) => {
    const r = new RegExp(re), out: string[] = []
    for (const x of a) { if (!r.test(x)) break; out.push(x) }
    return out
  })
  .registerFunction('shquote(list<string>): string', (argv: string[]) => argv.map(shq).join(' '))
  .registerFunction('list<list<dyn>>.flatten(): list<dyn>', (l: any[][]) => l.flat())
  .registerFunction('list<dyn>.distinct(): list<dyn>', (l: any[]) => [...new Set(l)])
for (const [k, v] of Object.entries(file.defs)) base.registerConstant(k, Array.isArray(v) ? 'list<string>' : 'map<string, dyn>', v)

// Each rule gets its own child env so its `let` names are declared (and type checked) for it alone
const compiled = file.rules.map((r: any) => {
  const env = base.clone()
  for (const k of Object.keys(r.let ?? {})) env.registerVariable(k, 'list<string>')
  if (r.ask) env.registerVariable('answer', 'string')
  const chk = (src: string, want?: string) => {
    const res = env.check(src)
    if (!res.valid) throw new Error(`rule ${r.id}: ${res.error.message}\n  in: ${src}`)
    if (want && !String(res.type).startsWith(want)) throw new Error(`rule ${r.id}: expected ${want}, got ${res.type}`)
    return env.parse(src)
  }
  const tmpl = (s: string) => {
    const parts = s.split(/\{\{(.*?)\}\}/s)
    const fns = parts.map((p, i) => (i % 2 ? chk(p) : null))
    return (ctx: any) => parts.map((p, i) => (i % 2 ? String(fns[i]!(ctx)) : p)).join('')
  }
  return {
    ...r,
    when: chk(r.when, 'bool'),
    let: Object.fromEntries(Object.entries(r.let ?? {}).map(([k, v]) => [k, chk(v as string, 'list')])),
    deny: r.deny && tmpl(r.deny),
  }
})

function context(tool: string, input: any) {
  const a = typeof input.command === 'string' ? analyze(input.command) : { commands: [], errors: [], untilClauses: [] }
  const cmd = (c: any) => ({
    name: c.name, args: c.args, captured: c.captured, wrappers: c.wrappers,
    chain: [...c.wrappers.map((w: string, i: number) => ({ name: w, argv: c.wrapped[i] })), { name: c.name, argv: [c.name, ...c.args] }],
  })
  return { tool, input, cmds: a.commands.map(cmd), errors: a.errors, untilConds: a.untilClauses.map((u) => u.map(cmd)) }
}

export function celDenial(tool: string, input: any, options: any): string | null {
  const ctx: any = context(tool, input)
  for (const r of compiled) {
    if (!r.tools.includes(tool) || r.ask) continue
    if (r.id === 'monitor-no-command') { if (!builtin.some((b) => b.tool === 'Bash' && options?.[ruleKey(b.id)] === true)) continue }
    else if (options?.[ruleKey(r.id)] !== true) continue
    if (tool === 'Monitor' && r.id !== 'monitor-disabled' && r.id !== 'monitor-no-command' && typeof input.command !== 'string') continue
    for (const [k, e] of Object.entries(r.let)) ctx[k] = (e as any)(ctx)
    if (r.when(ctx)) return r.deny(ctx)
  }
  return null
}
const run0 = compiled.find((x: any) => x.id === 'run0-confirm')
export const celRun0 = (command: string) => run0.let.items(context('Bash', { command }))

// ---- diff against v0.1 ----
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
    const want = firstDenial(tool, input as any, o)
    let got: string | null
    try { got = celDenial(tool, input, o) } catch (e) { got = 'THROW ' + (e as Error).message }
    if (want !== got) { bad++; if (bad < 10) console.log('MISMATCH', tool, JSON.stringify(input), '\n  v0.1:', want, '\n  cel :', got) }
  }
}
for (const s of [...strs, ...extra]) {
  n++
  const want = JSON.stringify(run0Invocations(s)), got = JSON.stringify(celRun0(s))
  if (want !== got) { bad++; console.log('RUN0 MISMATCH', JSON.stringify(s), want, got) }
}
console.log(`${n} comparisons over ${strs.size + extra.length} command strings, ${bad} mismatches`)

const CMD = 'cd /x && env A=1 timeout 5 find . -xdev -name y | xargs pgrep -af foo'
const t0 = performance.now()
for (let i = 0; i < 2000; i++) celDenial('Bash', { command: CMD }, ALL)
const t1 = performance.now()
for (let i = 0; i < 2000; i++) firstDenial('Bash', { command: CMD }, ALL)
console.log(`per call: cel ${((t1 - t0) / 2000).toFixed(3)}ms, v0.1 ${((performance.now() - t1) / 2000).toFixed(3)}ms`)

// The Jexl footguns, under CEL's load-time type check
for (const e of ["cmds.name == 'find'", 'cmds.length > 0', "cmds.filter(c, c.name == 'nope') ? 1 : 2", 'cmds[0].name.constructor', "cmds.exists(c, c.nmae == 'find')", "cmds.exists(c, c.args.matches('x'))", "'f' in cmds"]) {
  const r = base.check(e)
  console.log(r.valid ? `ACCEPTED  ${e}` : `rejected  ${e}  -> ${r.error.message.split('\n')[0]}`)
}

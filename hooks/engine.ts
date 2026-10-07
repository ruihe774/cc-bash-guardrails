// The rule engine: compiles rule files (CEL expressions, type-checked when they
// load) and runs them against a tool call. Pure and free of the mods API, so it
// can be unit tested; register.ts does the I/O.
import { Environment } from './vendor/cel/cel.js'
import { parseArgs, shellQuote, toSpec } from './argv.ts'
import { analyze, type Redirection, type SimpleCommand } from './shell.ts'

// ---- The rule-file format ----

export interface AskDef {
  question: string // a template
  header?: string // a short chip beside the question, 12 characters at most
  options?: string[] // 2-4 labels; default Allow, Deny
  allowIf?: string // CEL bool over `answer`; default: answer is the first option
  declined?: string // a template that can use `answer`
  dismissed?: string // a template
}

export interface RuleDef {
  id: string
  tools?: string[] // default: both
  enabled?: boolean // custom rules only; built-ins are toggled by userConfig
  let?: Record<string, string> // named CEL values, in order, shared by `when` and the messages
  when: string // CEL, must type-check to bool
  deny?: string // a template
  ask?: AskDef
}

export interface RuleFile {
  defs?: Record<string, unknown>
  rules: RuleDef[]
}

export const TOOLS = ['Bash', 'Monitor'] as const

// ---- Compiled form ----

type Fn = (ctx: Record<string, unknown>) => unknown
type Template = (ctx: Record<string, unknown>) => string

export interface CompiledRule {
  id: string
  source: string // 'built-in' or the file it came from
  isBuiltin: boolean
  enabled: boolean
  tools: ReadonlySet<string>
  lets: readonly (readonly [string, Fn])[]
  when: Fn
  deny?: Template
  ask?: {
    question: Template
    header?: string
    options: string[]
    allowIf?: Fn
    declined: Template
    dismissed: Template
  }
}

export interface Problem {
  source: string
  id?: string
  message: string
}

export interface CompiledFile {
  rules: CompiledRule[]
  problems: Problem[]
  env: Environment // with this file's defs, for files that build on it
}

// ---- What a rule sees of a call ----

// Classes, not plain objects: cel-js checks a registered type's values by constructor
export class Link {
  constructor(
    readonly name: string,
    readonly argv: string[],
  ) {}
}
export class Redir {
  constructor(
    readonly op: string,
    readonly fd: bigint,
    readonly target: string,
    readonly body: string,
    readonly quoted: boolean,
  ) {}
}
export class Cmd {
  constructor(
    readonly name: string,
    readonly args: string[],
    readonly captured: boolean,
    readonly wrappers: string[],
    readonly chain: Link[], // each wrapper's invocation, then the command itself
    readonly redirects: Redir[],
    readonly stdout: string,
  ) {}
}

const toRedir = (r: Redirection) => new Redir(r.op, BigInt(r.fd), r.target, r.body, r.quoted)

// Each SimpleCommand becomes one Cmd, so a command reads the same in `cmds` and `pipelines`
const cmdOf = (memo: Map<SimpleCommand, Cmd>) => (c: SimpleCommand): Cmd => {
  let cmd = memo.get(c)
  if (!cmd) {
    const chain = [...c.wrappers.map((w, i) => new Link(w, c.wrapped[i]!)), new Link(c.name, [c.name, ...c.args])]
    memo.set(c, (cmd = new Cmd(c.name, c.args, c.captured, c.wrappers, chain, c.redirects.map(toRedir), c.stdout)))
  }
  return cmd
}

// ---- The environment every rule sees ----

export const baseEnv = new Environment({ homogeneousAggregateLiterals: false })
  .registerType('Link', { ctor: Link, fields: { name: 'string', argv: 'list<string>' } })
  .registerType('Redir', { ctor: Redir, fields: { op: 'string', fd: 'int', target: 'string', body: 'string', quoted: 'bool' } })
  .registerType('Cmd', {
    ctor: Cmd,
    fields: {
      name: 'string',
      args: 'list<string>',
      captured: 'bool',
      wrappers: 'list<string>',
      chain: 'list<Link>',
      redirects: 'list<Redir>',
      stdout: 'string',
    },
  })
  .registerVariable('tool', 'string')
  .registerVariable('input', 'map<string, dyn>')
  .registerVariable('cmds', 'list<Cmd>')
  .registerVariable('errors', 'list<string>')
  .registerVariable('untilConds', 'list<list<Cmd>>')
  .registerVariable('pipelines', 'list<list<Cmd>>')
  .registerFunction('list<string>.opts(map<string, dyn>): list<string>', (a: string[], s: unknown) => parseArgs(a, toSpec(s)).opts)
  .registerFunction('list<string>.operands(map<string, dyn>): list<string>', (a: string[], s: unknown) => parseArgs(a, toSpec(s)).operands)
  .registerFunction('list<string>.optValues(map<string, dyn>, string): list<string>', (a: string[], s: unknown, name: string) =>
    parseArgs(a, toSpec(s)).values.filter(([n]) => n === name).map(([, v]) => v),
  )
  .registerFunction('list<A>.take(int): list<A>', (l: unknown[], n: bigint) => l.slice(0, Math.max(0, Number(n))))
  .registerFunction('list<A>.drop(int): list<A>', (l: unknown[], n: bigint) => l.slice(Math.max(0, Number(n))))
  .registerFunction(
    'list<string>.takeWhile(string): list<string>',
    (a: string[], re: string) => {
      const r = new RegExp(re)
      const out: string[] = []
      for (const x of a) {
        if (!r.test(x)) break
        out.push(x)
      }
      return out
    },
  )
  .registerFunction('shquote(list<string>): string', (argv: string[]) => argv.map(shellQuote).join(' '))
  .registerFunction('list<list<dyn>>.flatten(): list<dyn>', (l: unknown[][]) => l.flat())
  .registerFunction('list<dyn>.distinct(): list<dyn>', (l: unknown[]) => [...new Set(l)])

/** The variables a rule's expressions run against. `input` is the tool input
 *  without `tool`; with no command string there are no commands to see. */
export function context(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const a = typeof input.command === 'string' ? analyze(input.command) : { commands: [], errors: [], untilClauses: [], pipelines: [] }
  const toCmd = cmdOf(new Map())
  return {
    tool,
    input,
    cmds: a.commands.map(toCmd),
    errors: a.errors,
    untilConds: a.untilClauses.map((u) => u.map(toCmd)),
    pipelines: a.pipelines.map((p) => p.map(toCmd)),
  }
}

// ---- Compiling ----

const RULE_KEYS = new Set(['id', 'tools', 'enabled', 'let', 'when', 'deny', 'ask'])
const ASK_KEYS = new Set(['question', 'header', 'options', 'allowIf', 'declined', 'dismissed'])
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!

// JSON numbers that are whole become CEL ints (bigint); the rest stays as it is
function celValue(v: unknown): unknown {
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v
  if (Array.isArray(v)) return v.map(celValue)
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, celValue(x)]))
  return v
}

function celType(v: unknown): string {
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double'
  if (isStringList(v)) return 'list<string>'
  if (Array.isArray(v)) return 'list<dyn>'
  if (isRecord(v)) return 'map<string, dyn>'
  throw new Error('must be a string, number, bool, list or map')
}

class RuleError extends Error {}

function compileRule(raw: unknown, env: Environment, source: string, isBuiltin: boolean): CompiledRule {
  if (!isRecord(raw)) throw new RuleError('a rule must be an object')
  const r = raw as Partial<RuleDef> & Record<string, unknown>
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) throw new RuleError(`unknown key "${k}"`)
  if (r.tools !== undefined && !(isStringList(r.tools) && r.tools.length && r.tools.every((t) => (TOOLS as readonly string[]).includes(t))))
    throw new RuleError(`tools must be a non-empty list of ${TOOLS.join(', ')}`)
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw new RuleError('enabled must be true or false')
  if (typeof r.when !== 'string') throw new RuleError('when must be a CEL expression string')
  if ((r.deny === undefined) === (r.ask === undefined)) throw new RuleError('a rule needs exactly one action: deny or ask')

  // Each rule gets its own child env, so its `let` names are declared for it alone
  const ruleEnv = env.clone()
  const check = (where: string, e: Environment, src: unknown, want?: string): { fn: Fn; type: string } => {
    if (typeof src !== 'string') throw new RuleError(`${where} must be a CEL expression string`)
    const res = e.check(src)
    if (!res.valid) throw new RuleError(`${where}: ${firstLine(res.error)}`)
    const type = String(res.type)
    if (want && type !== want) throw new RuleError(`${where} must be ${want}, but is ${type}`)
    return { fn: e.parse(src) as unknown as Fn, type }
  }
  const template = (where: string, e: Environment, src: unknown): Template => {
    if (typeof src !== 'string') throw new RuleError(`${where} must be a string`)
    const parts = src.split(/\{\{(.*?)\}\}/s)
    const fns = parts.map((p, i) => (i % 2 ? check(`${where} {{${p}}}`, e, p).fn : null))
    return (ctx) => parts.map((p, i) => (i % 2 ? display(fns[i]!(ctx)) : p)).join('')
  }

  const lets: (readonly [string, Fn])[] = []
  if (r.let !== undefined) {
    if (!isRecord(r.let)) throw new RuleError('let must map names to CEL expressions')
    for (const [name, src] of Object.entries(r.let)) {
      if (!IDENT.test(name) || ruleEnv.hasVariable(name)) throw new RuleError(`let: "${name}" is not a free name`)
      const { fn, type } = check(`let ${name}`, ruleEnv, src)
      ruleEnv.registerVariable(name, type)
      lets.push([name, fn])
    }
  }

  const rule: CompiledRule = {
    id: r.id!,
    source,
    isBuiltin,
    enabled: r.enabled ?? true,
    tools: new Set(r.tools ?? TOOLS),
    lets,
    when: check('when', ruleEnv, r.when, 'bool').fn,
  }
  if (r.deny !== undefined) rule.deny = template('deny', ruleEnv, r.deny)
  else {
    const a = r.ask as unknown
    if (!isRecord(a)) throw new RuleError('ask must be an object')
    for (const k of Object.keys(a)) if (!ASK_KEYS.has(k)) throw new RuleError(`ask: unknown key "${k}"`)
    const options = a.options ?? ['Allow', 'Deny']
    if (!isStringList(options) || options.length < 2 || options.length > 4 || options.some((o) => !o))
      throw new RuleError('ask.options must be 2-4 non-empty labels')
    if (a.header !== undefined && (typeof a.header !== 'string' || a.header.length > 12))
      throw new RuleError('ask.header must be a string of at most 12 characters')
    const answerEnv = ruleEnv.clone().registerVariable('answer', 'string')
    const id = rule.id
    rule.ask = {
      question: template('ask.question', ruleEnv, a.question),
      options,
      allowIf: a.allowIf === undefined ? undefined : check('ask.allowIf', answerEnv, a.allowIf, 'bool').fn,
      declined: template(
        'ask.declined',
        answerEnv,
        a.declined ?? `The user did not approve this call (bash-guardrails rule ${id}): {{ answer }}. Do not retry without asking.`,
      ),
      dismissed: template(
        'ask.dismissed',
        ruleEnv,
        a.dismissed ?? `Not approved (bash-guardrails rule ${id}): the confirmation was dismissed or no one could be asked.`,
      ),
    }
    if (typeof a.header === 'string') rule.ask.header = a.header
  }
  return rule
}

/** Compiles one rule file on top of `env` (the base, or a file whose defs it
 *  may use). A rule or def that fails to compile is left out and reported. */
export function compileFile(file: unknown, source: string, opts: { env?: Environment; isBuiltin?: boolean; reservedIds?: Iterable<string> } = {}): CompiledFile {
  const problems: Problem[] = []
  const rules: CompiledRule[] = []
  const env = (opts.env ?? baseEnv).clone()
  if (!isRecord(file) || !Array.isArray(file.rules)) {
    problems.push({ source, message: 'a rule file must be an object with a "rules" list' })
    return { rules, problems, env }
  }
  for (const k of Object.keys(file)) if (k !== 'defs' && k !== 'rules') problems.push({ source, message: `unknown top-level key "${k}"` })
  if (file.defs !== undefined && !isRecord(file.defs)) problems.push({ source, message: '"defs" must be an object' })
  else
    for (const [name, value] of Object.entries(file.defs ?? {})) {
      try {
        if (!IDENT.test(name) || env.hasVariable(name)) throw new Error('is not a free name')
        env.registerConstant(name, celType(value), celValue(value))
      } catch (e) {
        problems.push({ source, message: `def ${name}: ${firstLine(e)}` })
      }
    }
  const seen = new Set(opts.reservedIds ?? [])
  for (const raw of file.rules) {
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined
    try {
      if (id === undefined || !RULE_ID.test(id)) throw new RuleError('a rule needs an "id" of letters, digits, - and _')
      if (seen.has(id)) throw new RuleError('duplicate id')
      seen.add(id)
      rules.push(compileRule(raw, env, source, opts.isBuiltin ?? false))
    } catch (e) {
      problems.push({ source, id, message: firstLine(e) })
    }
  }
  return { rules, problems, env }
}

/** Parses and compiles the text of a rule file. */
export function compileText(text: string, source: string, opts: Parameters<typeof compileFile>[2] = {}): CompiledFile {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch (e) {
    return { rules: [], problems: [{ source, message: `not valid JSON: ${firstLine(e)}` }], env: (opts.env ?? baseEnv).clone() }
  }
  return compileFile(file, source, opts)
}

// ---- Running ----

function display(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Map) v = Object.fromEntries(v)
  if (v && typeof v === 'object') return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))
  return String(v)
}

export type Ask = (question: string, options: { options: string[]; header?: string }) => Promise<string>

/** Runs `rules` against one call and resolves to the deny reason, or null to
 *  let it run. Every deny rule runs before any ask, so the user is never asked
 *  about a call that is denied anyway; an ask the user allows moves on to the
 *  next. A rule that fails while it runs denies the call. `onDeny` is told which
 *  rule denied it. */
export async function decide(
  rules: readonly CompiledRule[],
  tool: string,
  input: Record<string, unknown>,
  isEnabled: (r: CompiledRule) => boolean,
  ask: Ask,
  onDeny?: (rule: CompiledRule) => void,
): Promise<string | null> {
  const active = rules.filter((r) => r.tools.has(tool) && isEnabled(r))
  if (!active.length) return null
  const ctx = context(tool, input)
  const scope = (r: CompiledRule) => {
    const vars = { ...ctx }
    for (const [name, f] of r.lets) vars[name] = f(vars)
    return vars
  }
  const denied = (r: CompiledRule, reason: string) => {
    onDeny?.(r)
    return reason
  }
  const failed = (r: CompiledRule, e: unknown) =>
    denied(r, `bash-guardrails rule ${r.id} (${r.source}) failed (${firstLine(e)}); refusing the call rather than running it unchecked.`)

  for (const r of active) {
    if (!r.deny) continue
    try {
      const vars = scope(r)
      if (r.when(vars) === true) return denied(r, r.deny(vars))
    } catch (e) {
      return failed(r, e)
    }
  }
  for (const r of active) {
    const a = r.ask
    if (!a) continue
    let vars: Record<string, unknown>
    let question: string
    try {
      vars = scope(r)
      if (r.when(vars) !== true) continue
      question = a.question(vars)
    } catch (e) {
      return failed(r, e)
    }
    let answer: string
    try {
      answer = await ask(question, a.header === undefined ? { options: a.options } : { options: a.options, header: a.header })
    } catch {
      try {
        return denied(r, a.dismissed(vars))
      } catch (e) {
        return failed(r, e)
      }
    }
    try {
      const withAnswer = { ...vars, answer }
      const allowed = a.allowIf ? a.allowIf(withAnswer) === true : answer === a.options[0]
      if (!allowed) return denied(r, a.declined(withAnswer))
    } catch (e) {
      return failed(r, e)
    }
  }
  return null
}

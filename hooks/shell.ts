// Bash command analysis on top of a real parser (vendored unbash), so rules see
// commands, not substrings: quoting, pipelines, subshells, $(...) and `...` are
// all handled by the parser.
import { parse } from './vendor/unbash/parser.js'

export interface SimpleCommand {
  name: string // basename of the program, wrappers (sudo, env, ...) removed
  prog: string // the program as written, path included (`/bin/ls`)
  args: string[] // its arguments, quotes removed
  wrappers: string[] // wrappers removed from in front of it (and of a shell running it), outermost first
  wrapped: string[][] // per wrapper, parallel to `wrappers`: that wrapper's whole invocation, options and wrapped command included
  captured: boolean // its stdout is consumed: left of a pipe, or inside $(...), `...` or <(...)
  redirects: Redirection[] // its own, then those of the compound commands and shells (`bash -c`) around it, innermost first
  stdout: string // where those redirects send its stdout: a file, `&N` for another descriptor, or '' if they don't
}

export interface Redirection {
  op: string // > >> >| < <> <& >& &> &>> << <<- <<<
  fd: number // the descriptor written before the operator, -1 if none, -2 for a {var} one
  target: string // the file, descriptor or here-string word; a heredoc's delimiter
  body: string // what a heredoc or here-string feeds to stdin; '' for the others
  quoted: boolean // a heredoc whose delimiter is quoted, so its body is not expanded
}

// Wrappers that run another command given as their first non-option argument.
// argOpts: short options that consume a following argument (`sudo -u root`).
// positionals: leading positionals owned by the wrapper (`timeout 5 cmd`).
const WRAPPERS: Record<string, { argOpts?: string; positionals?: number }> = {
  sudo: { argOpts: 'ugCDhprtUR' },
  doas: { argOpts: 'uC' },
  run0: { argOpts: 'ugD' },
  env: { argOpts: 'uCS' },
  command: {},
  builtin: {},
  exec: { argOpts: 'a' },
  nohup: {},
  time: { argOpts: 'fo' },
  nice: { argOpts: 'n' },
  ionice: { argOpts: 'cnp' },
  setsid: {},
  stdbuf: { argOpts: 'ioe' },
  timeout: { argOpts: 'ks', positionals: 1 },
  xargs: { argOpts: 'aEeIiLnPsd' },
}

// Shells whose `-c` argument is itself a script
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

const MAX_DEPTH = 8

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

const argText = (a: any): string => (a.type === 'Assignment' ? a.text : a.value)

function redirection(r: any): Redirection {
  const fd = typeof r.descriptor?.value === 'number' ? r.descriptor.value : r.descriptor ? -2 : -1
  if (r.type === 'HereDoc')
    return { op: r.operator, fd, target: r.delimiter?.value ?? '', body: r.body?.text ?? '', quoted: !!r.delimiter?.quoted }
  const target = r.target?.value ?? ''
  return { op: r.operator, fd, target, body: r.type === 'HereString' ? target + '\n' : '', quoted: false }
}

// Where one command's (or compound's) own redirects send stdout: the last that touches it wins
function stdoutOf(redirects: readonly Redirection[]): string {
  let out = ''
  for (const r of redirects) {
    if (r.op === '&>' || r.op === '&>>') out = r.target
    else if (r.fd !== -1 && r.fd !== 1) continue
    else if (r.op === '>' || r.op === '>>' || r.op === '>|') out = r.target
    // >&2 duplicates a descriptor; >&file is &>file
    else if (r.op === '>&') out = /^(\d+|-)$/.test(r.target) ? `&${r.target}` : r.target
  }
  return out
}

function unwrap(words: string[]): { words: string[]; wrappers: string[]; wrapped: string[][] } {
  const wrappers: string[] = []
  const wrapped: string[][] = []
  for (let guard = 0; words.length && guard < 16; guard++) {
    const prog = basename(words[0]!)
    const w = WRAPPERS[prog]
    if (!w) break
    wrappers.push(prog)
    wrapped.push(words)
    let i = 1
    let skip = w.positionals ?? 0
    for (; i < words.length; i++) {
      const t = words[i]!
      if (t === '--') {
        i++
        break
      }
      if (t.startsWith('-') && t.length > 1) {
        if (!t.startsWith('--') && t.length === 2 && w.argOpts?.includes(t[1]!)) i++
        continue
      }
      if (prog === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue
      if (skip > 0) {
        skip--
        continue
      }
      break
    }
    words = words.slice(i)
  }
  return { words, wrappers, wrapped }
}

// Every child of a node. The parser's lazy fields (parts, elements, index,
// expression, ...) are not own properties, but its toJSON() lists them all.
function children(node: any): any[] {
  return Object.values(typeof node.toJSON === 'function' ? node.toJSON() : node)
}

type Visit = (n: any, captured: boolean, outer: readonly Redirection[][]) => void

// `outer`: the redirects of each compound command around the node, innermost first
function walk(node: any, visit: Visit, captured = false, outer: readonly Redirection[][] = [], seen = new Set<any>()): void {
  if (!node || typeof node !== 'object' || seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, captured, outer, seen)
    return
  }
  if (typeof node.type === 'string') visit(node, captured, outer)
  if (node.type === 'Pipeline') {
    // Every stage but the last feeds the next one, so its stdout is captured
    const last = node.commands.length - 1
    node.commands.forEach((c: any, i: number) => walk(c, visit, captured || i < last, outer, seen))
    return
  }
  // A substitution's output goes to the command around it, not to that command's redirects
  const expansion = node.type === 'CommandExpansion' || node.type === 'ProcessSubstitution'
  // $(...), `...` and <(...) hand the output to the surrounding command
  const inner = captured || node.type === 'CommandExpansion' || (node.type === 'ProcessSubstitution' && node.operator === '<')
  const redirs = expansion ? [] : node.type === 'Redirected' ? [node.redirects.map(redirection), ...outer] : outer
  for (const v of children(node)) walk(v, visit, inner, redirs, seen)
}

export interface Analysis {
  commands: SimpleCommand[]
  errors: string[] // parse errors, including those in nested scripts; empty if well-formed
  untilClauses: SimpleCommand[][] // per `until` / `while !` loop, the commands of its condition
  pipelines: SimpleCommand[][] // per pipeline, its stages in order; a stage that is not a simple command has name ''
}

/** Every simple command in `source`, including those nested in subshells,
 *  substitutions, control structures and `sh -c '...'` / `eval` strings, plus
 *  any parse errors. A non-empty `errors` means `commands` may be incomplete. */
export function analyze(source: string, depth = 0): Analysis {
  const out: Analysis = { commands: [], errors: [], untilClauses: [], pipelines: [] }
  if (depth > MAX_DEPTH) {
    out.errors.push('nesting too deep')
    return out
  }
  let ast: any
  try {
    ast = parse(source)
  } catch (err) {
    out.errors.push(String((err as Error)?.message ?? err))
    return out
  }
  // A nested script's commands inherit the shell's wrappers (`sudo sh -c ...`), capture and redirects
  const nested = (script: string, shell: SimpleCommand) => {
    const sub = analyze(script, depth + 1)
    const lift = new Map<SimpleCommand, SimpleCommand>()
    for (const c of sub.commands) {
      const redirects = [...c.redirects, ...shell.redirects]
      lift.set(c, {
        ...c,
        wrappers: [...shell.wrappers, ...c.wrappers],
        wrapped: [...shell.wrapped, ...c.wrapped],
        captured: c.captured || shell.captured,
        redirects,
        stdout: c.stdout || shell.stdout,
      })
    }
    const lifted = (c: SimpleCommand) => lift.get(c) ?? c
    out.commands.push(...sub.commands.map(lifted))
    out.errors.push(...sub.errors)
    out.untilClauses.push(...sub.untilClauses.map((u) => u.map(lifted)))
    out.pipelines.push(...sub.pipelines.map((p) => p.map(lifted)))
  }
  const byNode = new Map<any, SimpleCommand>()
  const pipelines: any[] = []
  try {
    walk(ast, (n, captured, outer) => {
      if (n.type === 'Pipeline') pipelines.push({ node: n, captured })
      for (const e of n.errors ?? []) out.errors.push(`${e.message} at ${e.pos}`)
      if (n.type === 'While') {
        const clause = source.slice(n.clause.pos, n.clause.end)
        // `while ! cond` waits for cond to succeed, exactly like `until cond`
        if (n.kind === 'until' || clause.trimStart().startsWith('!')) {
          const sub = analyze(clause, depth + 1)
          out.untilClauses.push(sub.commands)
          out.errors.push(...sub.errors)
        }
      }
      if (n.type !== 'Command' || !n.name) return
      let { words, wrappers, wrapped } = unwrap([n.name.value, ...n.args.map(argText)])
      // A wrapper with nothing to run (`sudo -v`) is itself the command
      if (!words.length) {
        const last = wrappers.pop()
        const call = wrapped.pop()
        if (!last || !call) return
        words = call
      }
      const prog = words[0]!
      const name = basename(prog)
      const args = words.slice(1)
      const own: Redirection[] = n.redirects.map(redirection)
      const stdout = [own, ...outer].map(stdoutOf).find((s) => s) ?? ''
      const cmd: SimpleCommand = { name, prog, args, wrappers, wrapped, captured, redirects: [...own, ...outer.flat()], stdout }
      out.commands.push(cmd)
      byNode.set(n, cmd)

      // Re-parse script strings handed to another shell
      if (SHELLS.has(name)) {
        const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
        const script = args[c + 1]
        if (c >= 0 && script !== undefined) nested(script, cmd)
      } else if (name === 'eval') {
        nested(args.join(' '), cmd)
      }
    })
    for (const { node, captured } of pipelines)
      out.pipelines.push(
        node.commands.map(
          (c: any, i: number): SimpleCommand =>
            byNode.get(c) ?? { name: '', prog: '', args: [], wrappers: [], wrapped: [], captured: captured || i < node.commands.length - 1, redirects: [], stdout: '' },
        ),
      )
  } catch (err) {
    // A walk that dies midway has not seen every command
    out.errors.push(`analysis failed: ${(err as Error)?.message ?? err}`)
  }
  return out
}

export const simpleCommands = (source: string): SimpleCommand[] => analyze(source).commands

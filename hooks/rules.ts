// Pure detect/filter logic, kept free of the mods API so it can be unit tested.
import { analyze, simpleCommands } from './shell.ts'

export interface Rule {
  id: string
  tool: string
  // Returns the deny reason when the call should be blocked, otherwise null
  check: (e: { command?: string }) => string | null
}

// find's leading options are -H -L -P, -D <debugopts> and -O<level>; the
// starting points follow, up to the first token of the expression.
function findStartPoints(args: string[]): string[] {
  let i = 0
  for (; i < args.length; i++) {
    if (args[i] === '-D') i++
    else if (!/^-[HLPO]/.test(args[i])) break
  }
  if (args[i] === '--') i++
  const paths: string[] = []
  for (; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('-') || a === '(' || a === '!') break
    paths.push(a)
  }
  return paths
}

// `/*` expands to every top-level entry, which scans the whole filesystem too
const isFilesystemRoot = (p: string) => /^\/+(\.\/?)*\*?$/.test(p)

// pgrep options that take a value, so in `-uf` the f is a user name, not -f
const PGREP_ARG_OPTS = 'dFgGJOPrstTuU'

function pgrepFlags(args: string[]): { full: boolean; listFull: boolean } {
  let full = false
  let listFull = false
  for (const a of args) {
    if (a === '--') break
    if (a === '--full') full = true
    else if (a === '--list-full') listFull = true
    else if (/^-[^-]/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 'f') full = true
        else if (ch === 'a') listFull = true
        else if (PGREP_ARG_OPTS.includes(ch)) break
      }
    }
  }
  return { full, listFull }
}

export const rules: Rule[] = [
  // Runs first: if the command can't be parsed, the rules below can't be trusted to see all of it
  {
    id: 'malformed-bash',
    tool: 'Bash',
    check: ({ command = '' }) => {
      const { errors } = analyze(command)
      return errors.length
        ? `Malformed bash command (${errors[0]}). Fix the syntax and retry.`
        : null
    },
  },
  {
    id: 'monitor-disabled',
    tool: 'Monitor',
    check: () =>
      'Monitor is disabled. Use Bash with a long timeout (up to 24h) to spawn a blocking waiter that exits on the next event.',
  },
  {
    id: 'find-root',
    tool: 'Bash',
    check: ({ command = '' }) =>
      simpleCommands(command).some((c) => c.name === 'find' && findStartPoints(c.args).some(isFilesystemRoot))
        ? 'find rooted at / is disabled. Scan a specific directory instead.'
        : null,
  },
  {
    id: 'pgrep-f',
    tool: 'Bash',
    check: ({ command = '' }) =>
      simpleCommands(command).some((c) => {
        if (c.name !== 'pgrep') return false
        const { full, listFull } = pgrepFlags(c.args)
        return full && !listFull
      })
        ? 'pgrep -f can match helper processes spawned by the harness (e.g. its bash -c wrapper). Use pgrep -af and confirm each match cmdline instead.'
        : null,
  },
]

export function firstDenial(tool: string, e: { command?: string }): string | null {
  for (const r of rules) {
    if (r.tool !== tool) continue
    const reason = r.check(e)
    if (reason) return reason
  }
  return null
}

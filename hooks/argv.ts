// A spec-driven argument parser, the one stateful scan the CEL rules can't express
// themselves. The domain knowledge (which options take a value) lives in the
// rule file's defs; this only knows the common syntaxes.

export interface ArgSpec {
  // getopt-style short options. Without shortTakesValue, a letter followed by
  // `:` takes a value, from the rest of the argument or else the next one
  short?: string
  // Every letter in `short` takes a value, and only from the rest of the same
  // argument, never the next one (pgrep's `-u -f` keeps -f an option)
  shortTakesValue?: boolean
  // --name and --name=value; maps a long name to the name reported for it (`full` -> `f`)
  long?: Record<string, string>
  // find-style single-dash words. A number is how many arguments follow; a list
  // of strings ends the word at the first argument that equals one (`-exec ... ;`)
  words?: Record<string, number | string[]>
  // Like `words`, keyed by a regex the whole word must match
  wordPatterns?: Record<string, number>
  // Stop at the first operand: everything after it is an operand too
  posix?: boolean
}

export interface ParsedArgs {
  opts: string[]
  operands: string[]
}

const SPEC_KEYS = new Set(['short', 'shortTakesValue', 'long', 'words', 'wordPatterns', 'posix'])

// CEL hands over maps (possibly as Map) and ints as bigint; turn them into plain JS
function plain(v: unknown): unknown {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]))
  if (Array.isArray(v)) return v.map(plain)
  if (typeof v === 'bigint') return Number(v)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  return v
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Checks a spec's shape, so a typo in a rule file fails loudly instead of parsing wrong. */
export function toSpec(raw: unknown): ArgSpec {
  const s = plain(raw)
  if (!isRecord(s)) throw new Error('argument spec must be a map')
  for (const k of Object.keys(s)) if (!SPEC_KEYS.has(k)) throw new Error(`argument spec: unknown key "${k}"`)
  if (s.short !== undefined && typeof s.short !== 'string') throw new Error('argument spec: short must be a string')
  for (const k of ['shortTakesValue', 'posix'])
    if (s[k] !== undefined && typeof s[k] !== 'boolean') throw new Error(`argument spec: ${k} must be a bool`)
  if (s.long !== undefined && !(isRecord(s.long) && Object.values(s.long).every((v) => typeof v === 'string')))
    throw new Error('argument spec: long must map names to strings')
  if (
    s.words !== undefined &&
    !(isRecord(s.words) &&
      Object.values(s.words).every(
        (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (Array.isArray(v) && v.every((x) => typeof x === 'string')),
      ))
  )
    throw new Error('argument spec: words must map words to a count or a list of terminators')
  if (s.wordPatterns !== undefined) {
    if (!(isRecord(s.wordPatterns) && Object.values(s.wordPatterns).every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0)))
      throw new Error('argument spec: wordPatterns must map regexes to a count')
    for (const re of Object.keys(s.wordPatterns)) new RegExp(re)
  }
  return s as ArgSpec
}

export function parseArgs(args: readonly string[], spec: ArgSpec): ParsedArgs {
  const opts: string[] = []
  const operands: string[] = []
  const short = spec.short ?? ''
  const takesValue = (ch: string) => (spec.shortTakesValue ? short.includes(ch) : short.includes(ch + ':'))
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--' && !spec.words) {
      operands.push(...args.slice(i + 1))
      break
    }
    if (spec.words && a.startsWith('-') && a.length > 1) {
      let arity = spec.words[a]
      if (arity === undefined)
        for (const [re, n] of Object.entries(spec.wordPatterns ?? {})) if (new RegExp(re).test(a)) arity = n
      opts.push(a)
      if (Array.isArray(arity)) {
        // The embedded command runs up to a terminator
        while (i + 1 < args.length && !arity.includes(args[i]!)) i++
      } else i += arity ?? 0
      continue
    }
    if (a.startsWith('--') && a.length > 2 && spec.long) {
      const name = a.slice(2).split('=')[0]!
      opts.push(spec.long[name] ?? name)
      continue
    }
    if (/^-[^-]/.test(a) && !spec.words) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j]!
        opts.push(ch)
        if (takesValue(ch)) {
          if (j === a.length - 1 && !spec.shortTakesValue) i++
          break
        }
      }
      continue
    }
    operands.push(a)
    if (spec.posix) {
      operands.push(...args.slice(i + 1))
      break
    }
  }
  return { opts, operands }
}

// Quote a word the way a shell would need it, so a displayed command is unambiguous
export const shellQuote = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

import { expect, test } from 'claude-code/testing'
import { parseArgs, toSpec } from '../hooks/argv.ts'
import { compileFile, compileText, decide, type Ask, type CompiledRule, type RuleFile } from '../hooks/engine.ts'
import { builtin, builtinIds, ruleEnabled } from '../hooks/rules.ts'

// Compiles a custom file the way register.ts does
const custom = (file: unknown) => compileFile(file, 'test.json', { env: builtin.env, reservedIds: builtinIds })
const all = () => true
const noAsk = async (): Promise<string> => {
  throw new Error('unexpected question')
}
const run = (rules: CompiledRule[], command: string, ask: Ask = noAsk, tool = 'Bash') => decide(rules, tool, { command }, all, ask)
const problems = (file: unknown) => custom(file).problems.map((p) => `${p.id ?? '-'}: ${p.message}`)

test('a custom deny rule with defs, let and a template', async () => {
  const file: RuleFile = {
    defs: { BANNED: ['curl', 'wget'], LIMIT: 2 },
    rules: [
      {
        id: 'no-fetch',
        let: { hits: 'cmds.filter(c, c.name in BANNED).map(c, c.name)' },
        when: 'size(hits) > 0',
        deny: 'No {{ hits[0] }} ({{ size(hits) }} of {{ LIMIT }}): use the WebFetch tool.',
      },
    ],
  }
  const { rules, problems } = custom(file)
  expect(problems).toEqual([])
  expect(await run(rules, 'ls | curl -s x; wget y')).toBe('No curl (2 of 2): use the WebFetch tool.')
  expect(await run(rules, 'echo curl')).toBeNull()
})

test('custom rules can use the built-in defs and argument parser', async () => {
  const { rules, problems } = custom({
    rules: [{ id: 'until-any', when: 'untilConds.exists(cond, cond.exists(c, c.name in GREPS || c.name == "ag"))', deny: 'no' }],
  })
  expect(problems).toEqual([])
  expect(await run(rules, 'until ag x f; do sleep 1; done')).toBe('no')
  const rm = custom({
    defs: { RM: { short: 'rfiI', long: { recursive: 'r', force: 'f' } } },
    rules: [{ id: 'rm-rf-root', when: "cmds.exists(c, c.name == 'rm' && 'r' in c.args.opts(RM) && '/' in c.args.operands(RM))", deny: 'no' }],
  })
  expect(rm.problems).toEqual([])
  for (const c of ['rm -rf /', 'rm -r -- /', 'sudo rm --recursive --force /']) expect(await run(rm.rules, c)).toBe('no')
  for (const c of ['rm -rf ./x', 'rm /', 'rm -f -- -r /x']) expect(await run(rm.rules, c)).toBeNull()
})

test('rules see the tool and the raw input', async () => {
  const { rules } = custom({
    rules: [
      {
        id: 'bg-sleep',
        tools: ['Bash'],
        when: "tool == 'Bash' && has(input.run_in_background) && input.run_in_background == true && cmds.exists(c, c.name == 'sleep')",
        deny: 'no background sleeps',
      },
    ],
  })
  expect(await decide(rules, 'Bash', { command: 'sleep 5', run_in_background: true }, all, noAsk)).toBe('no background sleeps')
  expect(await decide(rules, 'Bash', { command: 'sleep 5' }, all, noAsk)).toBeNull()
  // Registered types can be indexed, not just iterated
  const idx = custom({ rules: [{ id: 'idx', when: "size(untilConds) > 0 && untilConds[0][0].chain[0].argv[0] == 'sudo'", deny: 'x' }] })
  expect(await run(idx.rules, 'until sudo grep -q x f; do sleep 1; done')).toBe('x')
  // tools limits where it runs
  expect(await decide(rules, 'Monitor', { command: 'sleep 5', run_in_background: true }, all, noAsk)).toBeNull()
})

test('mistakes are caught when a rule loads, and only that rule is skipped', () => {
  const file = {
    rules: [
      { id: 'list-as-cmd', when: "cmds.name == 'find'", deny: 'x' },
      { id: 'typo', when: "cmds.exists(c, c.nmae == 'find')", deny: 'x' },
      { id: 'not-bool', when: "cmds.filter(c, c.name == 'x')", deny: 'x' },
      { id: 'bad-template', when: 'true', deny: 'x {{ nope }}' },
      { id: 'both', when: 'true', deny: 'x', ask: { question: 'q?' } },
      { id: 'neither', when: 'true' },
      { id: 'extra-key', when: 'true', deny: 'x', deny_: 'y' },
      { id: 'bad-tool', tools: ['Read'], when: 'true', deny: 'x' },
      { id: 'sudo', when: 'true', deny: 'x' },
      { id: 'ok', when: 'true', deny: 'fine' },
      { id: 'ok', when: 'true', deny: 'again' },
      { id: 'shadow', let: { cmds: '[]' }, when: 'true', deny: 'x' },
      { id: 'few-options', when: 'true', ask: { question: 'q?', options: ['Only'] } },
      { id: 'long-header', when: 'true', ask: { question: 'q?', header: 'much too long a header' } },
      { id: 'answer-outside', when: 'true', ask: { question: 'q {{ answer }}?' } },
      { when: 'true', deny: 'x' },
    ],
  }
  const { rules } = custom(file)
  expect(rules.map((r) => r.id)).toEqual(['ok'])
  const found = problems(file)
  expect(found.length).toBe(15)
  for (const [i, frag] of [
    [0, 'list-as-cmd: when: '],
    [1, 'No such key: nmae'],
    [2, 'when must be bool'],
    [3, 'deny {{ nope }}'],
    [4, 'exactly one action'],
    [5, 'exactly one action'],
    [6, 'unknown key "deny_"'],
    [7, 'tools must be'],
    [8, 'sudo: duplicate id'],
    [9, 'ok: duplicate id'],
    [10, 'not a free name'],
    [11, '2-4 non-empty labels'],
    [12, 'at most 12 characters'],
    [13, 'ask.question'],
    [14, '-: a rule needs an "id"'],
  ] as const)
    expect(found[i]).toContain(frag)
})

test('broken defs and files are reported', () => {
  expect(problems({ defs: { 'bad name': 1, cmds: [], NULL: null, OK: 'x' }, rules: [] })).toEqual([
    '-: def bad name: is not a free name',
    '-: def cmds: is not a free name',
    '-: def NULL: must be a string, number, bool, list or map',
  ])
  // A built-in def can't be redefined
  expect(problems({ defs: { GREPS: ['ag'] }, rules: [] })).toEqual(['-: def GREPS: is not a free name'])
  expect(problems({ rule: [] })).toEqual(['-: a rule file must be an object with a "rules" list'])
  expect(problems({ rules: [], extra: 1 })).toEqual(['-: unknown top-level key "extra"'])
  expect(compileText('{ "rules": [', 'x.json').problems[0]!.message).toContain('not valid JSON')
  expect(compileText('{ "rules": [] }', 'x.json').problems).toEqual([])
})

test('a disabled custom rule does not run', async () => {
  const { rules } = custom({ rules: [{ id: 'off', enabled: false, when: 'true', deny: 'x' }] })
  expect(await decide(rules, 'Bash', { command: 'ls' }, ruleEnabled({}), noAsk)).toBeNull()
  expect(await decide(rules, 'Bash', { command: 'ls' }, all, noAsk)).toBe('x')
})

test('a rule that fails while it runs denies the call', async () => {
  const { rules, problems } = custom({
    rules: [{ id: 'bad-spec', when: "cmds.exists(c, 'x' in c.args.opts({'shrot': 'x'}))", deny: 'x' }],
  })
  expect(problems).toEqual([])
  const out = await run(rules, 'ls -x')
  expect(out).toContain('bash-guardrails rule bad-spec (test.json) failed')
  expect(out).toContain('unknown key "shrot"')
  // No command, nothing to scan: the rule doesn't fail
  expect(await run(rules, '')).toBeNull()
})

test('custom asks: defaults, header, allowIf and templates', async () => {
  const { rules, problems } = custom({
    rules: [
      {
        id: 'confirm-push',
        let: { pushes: "cmds.filter(c, c.name == 'git' && size(c.args) > 0 && c.args[0] == 'push').map(c, shquote(c.chain[size(c.chain) - 1].argv))" },
        when: 'size(pushes) > 0',
        ask: { question: 'Run {{ pushes.join(", ") }}?', header: 'git push' },
      },
      {
        id: 'confirm-rm',
        when: "cmds.exists(c, c.name == 'rm')",
        ask: {
          question: 'rm?',
          options: ['No', 'Yes, once'],
          allowIf: "answer.startsWith('Yes')",
          declined: 'rm refused ({{ answer }})',
          dismissed: 'rm unconfirmed',
        },
      },
    ],
  })
  expect(problems).toEqual([])
  const seen: unknown[] = []
  const say = (a: string) => async (q: string, o: unknown) => (seen.push([q, o]), a)
  expect(await run(rules, 'git push origin "my branch"', say('Allow'))).toBeNull()
  expect(seen[0]).toEqual(["Run git push origin 'my branch'?", { options: ['Allow', 'Deny'], header: 'git push' }])
  expect(await run(rules, 'git push', say('Deny'))).toBe(
    'The user did not approve this call (bash-guardrails rule confirm-push): Deny. Do not retry without asking.',
  )
  expect(await run(rules, 'git push', noAsk)).toContain('dismissed')
  expect(await run(rules, 'rm x', say('Yes, once'))).toBeNull()
  expect(await run(rules, 'rm x', say('No'))).toBe('rm refused (No)')
  expect(await run(rules, 'rm x', noAsk)).toBe('rm unconfirmed')
  // Two asks in one call: each is asked in turn, and the first refusal decides
  seen.length = 0
  expect(await run(rules, 'git push; rm x', say('Allow'))).toBe('rm refused (Allow)')
  expect(seen.length).toBe(2)
})

test('every deny rule, built-in or custom, runs before any ask', async () => {
  const late = custom({ rules: [{ id: 'no-ls', when: "cmds.exists(c, c.name == 'ls')", deny: 'no ls' }] })
  const rules = [...builtin.rules, ...late.rules]
  const opts = (r: CompiledRule) => (r.isBuiltin ? r.id === 'run0-confirm' : true)
  expect(await decide(rules, 'Bash', { command: 'run0 id; ls' }, opts, noAsk)).toBe('no ls')
})

test('templates show non-string values', async () => {
  const { rules } = custom({ rules: [{ id: 't', when: 'true', deny: '{{ 1 + 2 }} {{ [1, "a"] }} {{ {"k": true} }} {{ 1.5 }}' }] })
  expect(await run(rules, 'ls')).toBe('3 [1,"a"] {"k":true} 1.5')
})

test('the argument parser', () => {
  const p = (args: string[], spec: unknown) => parseArgs(args, toSpec(spec))
  expect(p(['-u', 'root', '-f', 'x'], { short: 'u:f' })).toEqual({ opts: ['u', 'f'], operands: ['x'], values: [['u', 'root']] })
  expect(p(['-uroot', 'x', '-f'], { short: 'u:f' })).toEqual({ opts: ['u', 'f'], operands: ['x'], values: [['u', 'root']] })
  expect(p(['x', '-f'], { short: 'f', posix: true })).toEqual({ opts: [], operands: ['x', '-f'], values: [] })
  expect(p(['--', '-f'], { short: 'f' })).toEqual({ opts: [], operands: ['-f'], values: [] })
  expect(p(['--full=1', '--other'], { long: { full: 'f' } })).toEqual({ opts: ['f', 'other'], operands: [], values: [['f', '1']] })
  // A long option whose name ends in `:` takes the next argument when it has no =value
  expect(p(['--expression', 's/a/b/', 'f', '--file=x'], { long: { expression: 'e:', file: 'f:' } })).toEqual({
    opts: ['e', 'f'],
    operands: ['f'],
    values: [['e', 's/a/b/'], ['f', 'x']],
  })
  // `::`: an optional value, only from the same argument
  expect(p(['-i.bak', '-i', 'f'], { short: 'i::' })).toEqual({ opts: ['i', 'i'], operands: ['f'], values: [['i', '.bak']] })
  expect(p(['-ni', '-e', 'p'], { short: 'ni::e:' })).toEqual({ opts: ['n', 'i', 'e'], operands: [], values: [['e', 'p']] })
  // shortTakesValue: the value only ever comes from the same argument
  expect(p(['-u', '-f'], { short: 'u', shortTakesValue: true })).toEqual({ opts: ['u', 'f'], operands: [], values: [] })
  expect(p(['-uf'], { short: 'u', shortTakesValue: true })).toEqual({ opts: ['u'], operands: [], values: [['u', 'f']] })
  // find-style words, with an arity, a pattern or terminators
  const find = { words: { '-name': 1, '-exec': [';', '+'] }, wordPatterns: { '^-newer..$': 1 } }
  expect(p(['.', '-name', '-xdev', '-neweram', '-x', '-exec', 'a', '-xdev', ';', '-print'], find)).toEqual({
    opts: ['-name', '-neweram', '-exec', '-print'],
    operands: ['.'],
    values: [],
  })
  expect(() => toSpec({ words: { '-x': 'one' } })).toThrow('words must map')
  expect(() => toSpec({ wordPatterns: { '(': 1 } })).toThrow()
  expect(() => toSpec(['x'])).toThrow('must be a map')
})

test('rules see redirects, where stdout goes, and pipelines', async () => {
  const { rules, problems } = custom({
    rules: [
      { id: 'redirs', when: "cmds.exists(c, c.name == 'r')", deny: "{{ cmds.filter(c, c.name == 'r').map(c, c.redirects.map(r, [r.op, r.fd, r.target, r.body, r.quoted])) }}" },
      { id: 'stdout', when: "cmds.exists(c, c.name == 'o')", deny: "{{ cmds.filter(c, c.name == 'o').map(c, c.stdout) }}" },
      { id: 'pipes', when: 'size(pipelines) > 0', deny: '{{ pipelines.map(p, p.map(c, c.name)) }}' },
      { id: 'take-drop', when: "cmds.exists(c, c.name == 't')", deny: "{{ cmds[0].args.take(2) }} {{ cmds[0].args.drop(2) }} {{ cmds[0].args.drop(9) }}" },
      { id: 'values', when: "cmds.exists(c, c.name == 'v')", deny: "{{ cmds[0].args.optValues({'short': 'e:x'}, 'e') }}" },
    ],
  })
  expect(problems).toEqual([])
  expect(await run(rules, "r <<'EOF' 2>/dev/null\nhi $x\nEOF")).toBe('[[["<<",-1,"EOF","hi $x\\n",true],[">",2,"/dev/null","",false]]]')
  expect(await run(rules, 'r <<< "a b"')).toBe('[[["<<<",-1,"a b","a b\\n",false]]]')
  // An enclosing compound's redirects come after the command's own
  expect(await run(rules, '{ r < in; } > out')).toBe('[[["<",-1,"in","",false],[">",-1,"out","",false]]]')
  // The last redirect of stdout wins; then the innermost enclosing one; then the shell's around bash -c
  for (const [c, out] of [
    ['o', '[""]'],
    ['o > a >> b', '["b"]'],
    ['o 2> a', '[""]'],
    ['o &> a', '["a"]'],
    ['o >&2', '["&2"]'],
    ['o 1> a 2>&1', '["a"]'],
    ['{ o; } > a', '["a"]'],
    ['{ { o; } > a; } > b', '["a"]'],
    ['{ o > c; } > a', '["c"]'],
    ['for i in 1; do o; done > a', '["a"]'],
    ['bash -c "o" > a', '["a"]'],
    ['{ echo $(o); } > a', '[""]'],
  ])
    expect(await run(rules, c)).toBe(out)
  expect(await run(rules, 'a | b; c | { d; } | e |& f')).toBe('[["a","b"],["c","","e","f"]]')
  expect(await run(rules, 'bash -c "a | b"')).toBe('[["a","b"]]')
  expect(await run(rules, 't 1 2 3')).toBe('["1","2"] ["3"] []')
  expect(await run(rules, 'v -x -e a -eb c')).toBe('["a","b"]')
})

test('onDeny names the rule that denied the call', async () => {
  const rules = compileText(JSON.stringify({ rules: [{ id: 'no-ls', when: "cmds.exists(c, c.name == 'ls')", deny: 'no ls' }] }), 'test').rules
  const denied: string[] = []
  expect(await decide(rules, 'Bash', { command: 'ls' }, all, noAsk, (r) => void denied.push(r.id))).toBe('no ls')
  expect(await decide(rules, 'Bash', { command: 'pwd' }, all, noAsk, (r) => void denied.push(r.id))).toBeNull()
  expect(denied).toEqual(['no-ls'])
})

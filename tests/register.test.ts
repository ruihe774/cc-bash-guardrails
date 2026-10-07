import { expect, mock, test } from 'claude-code/testing'
import { register } from '../hooks/register.ts'

// ---- Through the test kit: the mod as Claude Code loads it, with the manifest's defaults ----

// Stubs the files the mod may read, keyed by absolute path, plus the dirs it reads them from
function stubFiles(on: any, files: Map<string, { text: string; mtimeMs: number }>, logs: string[] = []) {
  mock.env(on, { HOME: '/home/u' })
  on('session.root', () => ({ value: '/proj' }))
  on('fs.stat', (_$: any, e: any) => {
    const f = files.get(e.path)
    return f ? { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_$: any, e: any) => {
    const f = files.get(e.path)
    return f ? { value: f.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('ui.log', (_$: any, e: any) => (logs.push(e.text), { value: undefined }))
  on('tool.call', () => ({ result: 'ran' }))
  on('session.start', () => ({ cwd: '/proj' }))
}

const USER = '/home/u/.claude/bash-guardrails.json'
const PROJECT = '/proj/.claude/bash-guardrails.json'
const rule = (id: string, name: string) => ({ id, when: `cmds.exists(c, c.name == '${name}')`, deny: `${id} says no` })
const file = (rules: unknown[], mtimeMs = 1) => ({ text: JSON.stringify({ rules }), mtimeMs })
// Monitor's required fields, besides the command or ws source the rules look at
const MONITOR = { tool: 'Monitor', description: 'watch', timeout_ms: 1000 } as const

test('the default rules apply with no rule files', async ($, on) => {
  stubFiles(on, new Map())
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'find / -xdev' }))).toContain('find rooted at /')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'echo "x' }))).toContain('Malformed bash')
  // Off by default
  expect((await $.tool.call({ tool: 'Bash', command: 'sudo ls' })).result).toBe('ran')
  expect(JSON.stringify(await $.tool.call(MONITOR))).toContain('no command string')
  expect((await $.tool.call({ ...MONITOR, command: 'ls' })).result).toBe('ran')
  // Other tools are never touched
  expect((await $.tool.call({ tool: 'Read', file_path: '/' })).result).toBe('ran')
})

test('user and project rule files add rules', async ($, on) => {
  const files = new Map([
    [USER, file([rule('no-curl', 'curl')])],
    [PROJECT, file([rule('no-wget', 'wget')])],
  ])
  stubFiles(on, files)
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'curl x' }))).toContain('no-curl says no')
  expect(JSON.stringify(await $.tool.call({ ...MONITOR, command: 'wget x' }))).toContain('no-wget says no')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).result).toBe('ran')
})

test('CLAUDE_CONFIG_DIR moves the user file', async ($, on) => {
  mock.env(on, { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg/' })
  on('session.root', () => ({ value: '/proj' }))
  on('fs.stat', (_$: any, e: any) =>
    e.path === '/cfg/bash-guardrails.json' ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' },
  )
  on('fs.read', () => ({ value: JSON.stringify({ rules: [rule('no-ls', 'ls')] }) }))
  on('tool.call', () => ({ result: 'ran' }))
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('no-ls says no')
})

test('a rule file is compiled again when it changes, and its problems are logged once', async ($, on) => {
  const logs: string[] = []
  const files = new Map([[USER, file([rule('no-curl', 'curl'), { id: 'broken', when: 'cmds.length > 0', deny: 'x' }])]])
  stubFiles(on, files, logs)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/proj' })
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain(`${USER}: rule broken:`)
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'curl x' }))).toContain('no-curl says no')
  expect(logs.length).toBe(1)

  files.set(USER, file([rule('no-ls', 'ls')], 2))
  expect((await $.tool.call({ tool: 'Bash', command: 'curl x' })).result).toBe('ran')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('no-ls says no')

  files.set(USER, { text: '{ not json', mtimeMs: 3 })
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).result).toBe('ran')
  expect(logs[1]).toContain('not valid JSON')

  files.delete(USER)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).result).toBe('ran')
})

test('a project file can neither reuse a built-in id nor turn a built-in off', async ($, on) => {
  const logs: string[] = []
  const files = new Map([[PROJECT, file([{ id: 'find-root', enabled: false, when: 'false', deny: 'x' }])]])
  stubFiles(on, files, logs)
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'find / -xdev' }))).toContain('find rooted at /')
  expect(logs[0]).toContain('rule find-root: duplicate id')
})

test('a custom ask goes through the AskUserQuestion dialog', async ($, on) => {
  const ask = { id: 'confirm-rm', when: "cmds.exists(c, c.name == 'rm')", ask: { question: 'Run rm?', header: 'rm' } }
  mock.env(on, { HOME: '/home/u' })
  on('session.root', () => ({ value: '/proj' }))
  on('fs.stat', (_$: any, e: any) => (e.path === USER ? { value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', () => ({ value: JSON.stringify({ rules: [ask] }) }))
  let asked: any
  let reply = 'Allow'
  on('tool.call', (_$: any, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ran' }
    asked = e.questions[0]
    return { result: { answers: { [e.questions[0].question]: reply } } }
  })
  expect((await $.tool.call({ tool: 'Bash', command: 'rm x' })).result).toBe('ran')
  expect(asked.question).toBe('Run rm?')
  expect(asked.header).toBe('rm')
  reply = 'Deny'
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'rm x' }))).toContain('did not approve')
})

test('the hook fails closed when it cannot run', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  on('session.root', () => ({ deny: 'no root for you' }))
  on('tool.call', () => ({ result: 'ran' }))
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'ls' }))).toContain('bash-guardrails failed')
})

// ---- Calling register directly, so the test controls the options the mod receives ----

// A stand-in for the mods API with no rule files, answering the run0 question with `answer`
function fakeApi(answer: string | Error) {
  const asked: string[] = []
  const $ = {
    env: { get: async () => undefined },
    session: { root: async () => '/proj' },
    fs: { stat: async () => Promise.reject(new Error('ENOENT')), read: async () => '' },
    ui: {
      log: () => {},
      ask: async (q: string) => {
        asked.push(q)
        if (answer instanceof Error) throw answer
        return answer
      },
    },
  }
  return { $, asked }
}

function registerMod(options: Record<string, unknown>) {
  const h: { hook?: any; onError?: any } = {}
  const chain: any = { catch: (fn: unknown) => ((h.onError = fn), chain) }
  register((ev: string, _filter: unknown, hook: unknown) => {
    if (ev === 'tool.call') h.hook = hook
    return chain
  }, options)
  return h
}

const next = async (e: any) => ({ result: 'ran', e })

test('run0 asks the user with the wrapped command before it runs when enabled', async () => {
  const { hook } = registerMod({ run0_confirm: true })
  const ok = fakeApi('Allow')
  expect((await hook(ok.$, { tool: 'Bash', command: 'run0 -u root systemctl restart foo' }, next)).result).toBe('ran')
  expect(ok.asked[0]).toContain('run0 -u root systemctl restart foo')

  const no = fakeApi('Deny')
  expect(JSON.stringify(await hook(no.$, { tool: 'Bash', command: 'run0 id' }, next))).toContain('declined run0')

  const free = fakeApi('only if you use -D /tmp')
  expect(JSON.stringify(await hook(free.$, { tool: 'Bash', command: 'run0 id' }, next))).toContain('only if you use -D /tmp')

  const dismissed = fakeApi(new Error('dismissed'))
  expect(JSON.stringify(await hook(dismissed.$, { tool: 'Bash', command: 'run0 id' }, next))).toContain('not approved')

  const monitor = fakeApi('Deny')
  await hook(monitor.$, { tool: 'Monitor', command: 'run0 id' }, next)
  expect(monitor.asked[0]).toContain('Full Monitor command')

  const none = fakeApi('Allow')
  expect((await hook(none.$, { tool: 'Bash', command: 'ls' }, next)).result).toBe('ran')
  expect(none.asked).toEqual([])
})

test('run0 is not confirmed when its option is off', async () => {
  const { hook } = registerMod({})
  const off = fakeApi('Deny')
  expect((await hook(off.$, { tool: 'Bash', command: 'run0 id' }, next)).result).toBe('ran')
  expect(off.asked).toEqual([])
})

test('the call reaches next unchanged', async () => {
  const { hook } = registerMod({ find_root: true })
  const e = Object.freeze({ tool: 'Bash', command: 'ls', run_in_background: true })
  expect((await hook(fakeApi('Allow').$, e, next)).e).toBe(e)
})

test('the error handler fails closed, unless the hook had already passed the call on', async () => {
  const { onError } = registerMod({})
  const failed = { called: false, error: { message: 'boom' } }
  const unchecked = Object.assign(async () => ({ result: 'ran' }), failed)
  expect(JSON.stringify(await onError({}, { tool: 'Bash', command: 'ls' }, unchecked))).toContain('boom')
  const passed = Object.assign(async () => ({ result: 'ran' }), { ...failed, called: true })
  expect((await onError({}, { tool: 'Bash', command: 'ls' }, passed)).result).toBe('ran')
})

test('a denial shows a toast naming the rule, without the command', async () => {
  const toasts: string[] = []
  const $ = { fs: { stat: async () => undefined }, env: { get: async () => '' }, session: { root: async () => '/proj' }, ui: { toast: (t: string) => void toasts.push(t), log() {} } }
  let hook: any
  register((name: string, ...rest: any[]) => {
    if (name === 'tool.call') hook = rest[rest.length - 1]
    return { catch() {} }
  }, { sudo: true })
  const out = await hook($, { tool: 'Bash', command: 'sudo cat /etc/secret-token' }, async () => ({ result: 'ran' }))
  expect(JSON.stringify(out)).toContain('sudo')
  expect(toasts).toEqual(["Rule 'sudo' denied a command"])
})

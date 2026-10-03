import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/register.ts'
import { firstDenial, firstDenialBy, ruleKey, rules, run0Invocations } from '../hooks/rules.ts'

// Every rule on, so each rule can be tested regardless of its default
const ALL = Object.fromEntries(rules.map((r) => [ruleKey(r.id), true]))
const deny = (command: string) => firstDenial('Bash', { command }, ALL)

test('Monitor is denied', () => {
  expect(firstDenial('Monitor', {}, ALL)).toContain('Monitor is disabled')
  expect(firstDenial('Monitor', {}, ALL)).toContain('run_in_background')
})

test('find rooted at / is denied, scoped find is not', () => {
  for (const c of ['find / -name x', 'ls; find / -name x', 'sudo find -L / -type f', 'echo $(find /)'])
    expect(deny(c)).toContain('find rooted at /')
  for (const c of ['find /tmp -xdev -name x', 'find . -xdev -name x', 'echo find /'])
    expect(deny(c)).toBe(null)
})

test('find without -xdev is denied', () => {
  for (const c of [
    'find /tmp -name x',
    'find . -name x',
    'find',
    'ls; find /tmp -type f',
    'echo $(find /tmp)',
    'sudo find /tmp -name x',
    'find . -name -xdev',
    'find . -exec grep -xdev {} \\;',
  ])
    expect(deny(c)).toContain('-xdev')
  for (const c of [
    'find /tmp -xdev -name x',
    'find -xdev /tmp',
    'find /tmp -mount -type f',
    'find /a /b -name x -xdev',
    'find -L /tmp -xdev -type f',
    'echo $(find /tmp -xdev)',
    'find . -xdev -exec ls {} +',
  ])
    expect(deny(c)).toBe(null)
})

test('until grep loops are denied', () => {
  for (const c of [
    'until grep -q DONE app.log; do sleep 5; done',
    'until grep -q DONE app.log\ndo sleep 5\ndone',
    'ls; until grep -q "a b" f; do sleep 1; done; echo ok',
    'until sudo grep -q x f; do sleep 1; done',
    'until [ -f x ] && grep -q DONE f; do sleep 1; done',
    'until tail -n1 f | grep -q DONE; do sleep 1; done',
    'bash -c "until grep -q DONE f; do sleep 1; done"',
    'until rg -q DONE f; do sleep 1; done',
    'while ! grep -q DONE app.log; do sleep 5; done',
    'while ! grep -q DONE app.log\ndo sleep 5\ndone',
    'while ! tail -n1 f | grep -q DONE; do sleep 1; done',
    'bash -c "while ! grep -q DONE f; do sleep 1; done"',
  ])
    expect(deny(c)).toContain('until grep')
  for (const c of [
    'tail -f --pid=123 app.log | grep -m1 DONE',
    'until kill -0 123 2>/dev/null; do sleep 1; done',
    'until [ -f done ]; do sleep 1; done',
    'while kill -0 123; do grep -q x f; sleep 1; done',
    'until [ -f done ]; do grep -q x f; sleep 1; done',
    'echo until grep',
    'while grep -q x f; do sleep 1; done',
    'while ! kill -0 123 2>/dev/null; do sleep 1; done',
    'while ! [ -f done ]; do grep -q x f; sleep 1; done',
  ])
    expect(deny(c)).toBe(null)
})

test('pgrep -f denied unless -a present', () => {
  for (const c of ['pgrep -f foo', 'pgrep -fl foo']) expect(deny(c)).toContain('pgrep -f')
  for (const c of ['pgrep -af foo', 'pgrep foo', 'pgrep -x foo']) expect(deny(c)).toBe(null)
})

test('pkill -f is denied, -a does not help', () => {
  for (const c of ['pkill -f foo', 'pkill -9 -f foo', 'pkill -fa foo', 'sudo pkill -f foo']) expect(deny(c)).toContain('pkill -f')
  for (const c of ['pkill foo', 'pkill -9 foo', 'pkill -u f foo', 'echo pkill -f']) expect(deny(c)).toBe(null)
})

test('pgrep output must not be captured', () => {
  for (const c of [
    'pgrep foo | wc -l',
    'pgrep -a foo |& head',
    'echo $(pgrep foo)',
    'echo `pgrep foo`',
    'n=$(pgrep foo)',
    'echo "$(pgrep foo)"',
    'cat <(pgrep foo)',
    '{ pgrep foo; } | wc -l',
    'sh -c "pgrep foo" | wc -l',
    'echo $(pgrep foo | wc -l)',
    'kill $(sudo pgrep foo)',
  ])
    expect(deny(c)).toContain('capture pgrep')
  for (const c of [
    'pgrep foo',
    'pgrep foo; echo done',
    'pgrep foo && echo yes',
    'ls | xargs pgrep foo',
    'echo hi | pgrep foo',
    'pgrep foo > out.txt',
    'echo "pgrep foo | wc"',
    'echo $(date); pgrep foo',
    'echo foo > >(pgrep bar)',
  ])
    expect(deny(c)).toBe(null)
})

test('rules follow shell structure, not text', () => {
  for (const c of [
    'cd /x && find / -name y',
    'FOO=$(find / -name y)',
    'echo "$(find /)"',
    'bash -c "find / -type f"',
    'env X=1 sudo -u root find / -name a',
    'if true; then find // -x; fi',
    'ls | xargs pgrep -f foo',
    'echo `pgrep --full foo`',
    'pgrep -uroot -f foo',
    '/usr/bin/find / -name a',
    'find -H / -name a',
  ])
    expect(deny(c)).not.toBe(null)
  for (const c of [
    'echo "find / -name x"',
    "grep 'pgrep -f' file",
    'find ./a -xdev -path / -prune',
    'find /tmp -xdev -name /',
    'pgrep --list-full --full foo',
    'echo pgrep -f',
    'pgrep -u f foo',
  ])
    expect(deny(c)).toBe(null)
})

test('sudo is denied in favour of run0', () => {
  for (const c of [
    'sudo ls',
    'sudo -v',
    'sudo -u root ls',
    '/usr/bin/sudo ls',
    'ls && sudo ls',
    'echo $(sudo cat /etc/shadow)',
    'env X=1 sudo ls',
    'bash -c "sudo ls"',
    'ls | xargs sudo rm',
  ])
    expect(deny(c)).toContain('run0')
  for (const c of ['run0 ls', 'run0 -u root ls', 'echo sudo', 'grep sudo /etc/group', 'ls sudo'])
    expect(deny(c)).toBe(null)
})

test('run0 is a wrapper: the command it runs is checked', () => {
  for (const c of ['run0 find /tmp -name x', 'run0 -u root find / -xdev', 'run0 -D /tmp --nice=5 pgrep -f foo'])
    expect(deny(c)).not.toBe(null)
  expect(deny('run0 -u root find /tmp -xdev -name x')).toBe(null)
})

test('malformed bash is denied, well-formed multi-line scripts are not', () => {
  for (const c of ['echo "abc', 'echo $(ls', 'if true; then ls', 'ls | ', 'bash -c "echo \'x"', 'echo ok; find /tmp -xdev "'])
    expect(deny(c)).toContain('Malformed bash')
  for (const c of ['cat <<EOF\nhi\nEOF\n', 'for i in 1 2; do echo $i; done', '[[ -f x ]] && echo $((1+2))', ''])
    expect(deny(c)).toBe(null)
})

test('substitutions in every syntax position are seen', () => {
  for (const c of [
    'arr=( $(find /) )',
    'declare -a x=($(find /))',
    'a[$(find /)]=1',
    '(( $(find /) ))',
  ])
    expect(deny(c)).toContain('find rooted at /')
})

test('find -- and /* count as rooted at /', () => {
  for (const c of ['find -- / -name x', 'find /* -name x', 'find -L -- // x']) expect(deny(c)).toContain('find rooted at /')
  for (const c of ['find -- /tmp -xdev -name x', 'find /tmp/* -xdev -name x']) expect(deny(c)).toBe(null)
})

test('run0Invocations reports the exact wrapped command', () => {
  expect(run0Invocations('run0 ls')).toEqual(['run0 ls'])
  expect(run0Invocations('run0 -u root systemctl restart "my unit"')).toEqual(["run0 -u root systemctl restart 'my unit'"])
  expect(run0Invocations('echo hi; env X=1 run0 -D /tmp ls | wc -l')).toEqual(['run0 -D /tmp ls'])
  expect(run0Invocations('bash -c "run0 id"')).toEqual(['run0 id'])
  expect(run0Invocations('run0 -v')).toEqual(['run0 -v'])
  expect(run0Invocations('ls; echo run0')).toEqual([])
})

// Runs the registered tool.call handler directly, so the test controls the options the mod receives
async function callBash(command: string, options: Record<string, unknown>, answer: string) {
  let handler: any
  const chain: any = { catch: () => chain }
  register((_ev: string, _filter: unknown, h: unknown) => ((handler = h), chain), options)
  let asked = ''
  const $ = { ui: { ask: async (q: string) => ((asked = q), answer) } }
  const next = async (e: any) => ({ result: 'ran', e })
  const out = await handler($, { tool: 'Bash', command }, next)
  return { out, asked }
}

test('run0 asks the user with the wrapped command before it runs when enabled', async () => {
  const on = { run0_confirm: true }
  const ok = await callBash('run0 -u root systemctl restart foo', on, 'Allow')
  expect(ok.asked).toContain('run0 -u root systemctl restart foo')
  expect(ok.out.result).toBe('ran')

  const no = await callBash('run0 id', on, 'Deny')
  expect(JSON.stringify(no.out)).toContain('declined run0')

  expect((await callBash('ls', on, 'Allow')).asked).toBe('')
  // Off by default: no prompt
  const off = await callBash('run0 id', {}, 'Allow')
  expect(off.asked).toBe('')
  expect(off.out.result).toBe('ran')
})

// Registers the mod and returns both the hook and its .catch handler
function registerMod(options: Record<string, unknown>) {
  const h: { hook?: any; onError?: any } = {}
  const chain: any = { catch: (fn: unknown) => ((h.onError = fn), chain) }
  register((_ev: string, _filter: unknown, hook: unknown) => ((h.hook = hook), chain), options)
  return h
}

test('Monitor is denied through the registered hook', async () => {
  const { hook } = registerMod({ monitor_disabled: true })
  const next = async (e: any) => ({ result: 'ran', e })
  expect(JSON.stringify(await hook({}, { tool: 'Monitor' }, next))).toContain('Monitor is disabled')
  expect((await hook({}, { tool: 'Bash', command: 'ls' }, next)).result).toBe('ran')
})

test('a dismissed run0 prompt denies the call', async () => {
  const { hook } = registerMod({ run0_confirm: true })
  const $ = { ui: { ask: async () => { throw new Error('dismissed') } } }
  const next = async () => ({ result: 'ran' })
  expect(JSON.stringify(await hook($, { tool: 'Bash', command: 'run0 id' }, next))).toContain('not approved')
})

test('a free-text answer to the run0 prompt is a denial that quotes it', async () => {
  const on = { run0_confirm: true }
  const out = await callBash('run0 id', on, 'only if you use -D /tmp')
  expect(out.out.result).toBeUndefined()
  expect(JSON.stringify(out.out)).toContain('only if you use -D /tmp')
})

test('the error handler fails closed, unless the hook had already passed the call on', async () => {
  const { onError } = registerMod({})
  const failed = { called: false, error: { message: 'boom' } }
  const unchecked = Object.assign(async () => ({ result: 'ran' }), failed)
  expect(JSON.stringify(await onError({}, { tool: 'Bash', command: 'ls' }, unchecked))).toContain('boom')
  const passed = Object.assign(async () => ({ result: 'ran' }), { ...failed, called: true })
  expect((await onError({}, { tool: 'Bash', command: 'ls' }, passed)).result).toBe('ran')
})

test('Monitor commands go through the Bash rules even when Monitor itself is allowed', () => {
  const on = { ...ALL, monitor_disabled: false }
  for (const command of ['find / -xdev', 'sudo ls', 'pkill -f foo', 'until grep x log; do sleep 1; done', 'echo "unterminated'])
    expect(firstDenial('Monitor', { command }, on)).not.toBeNull()
  expect(firstDenial('Monitor', { command: 'tail -f --pid=1 log' }, on)).toBeNull()
  // The command field is missing: refuse rather than check an empty string
  expect(firstDenial('Monitor', {}, on)).toContain('no command string')
  // A ws source runs no shell
  expect(firstDenial('Monitor', { ws: { url: 'wss://example.com/stream' } }, on)).toBeNull()
  expect(firstDenial('Monitor', { ws: { url: 'wss://example.com/stream' } }, ALL)).toContain('Monitor is disabled')
  expect(firstDenial('Monitor', {}, { monitor_disabled: false })).toBeNull()
})

test('run0 is confirmed for Monitor too', async () => {
  const { hook } = registerMod({ run0_confirm: true })
  let asked = ''
  const $ = { ui: { ask: async (q: string) => ((asked = q), 'Deny') } }
  const out = await hook($, { tool: 'Monitor', command: 'run0 id' }, async () => ({ result: 'ran' }))
  expect(asked).toContain('Full Monitor command')
  expect(JSON.stringify(out)).toContain('declined run0')
})

test('a rule is skipped when its option is false', () => {
  expect(firstDenial('Monitor', { command: 'ls' }, { ...ALL, monitor_disabled: false })).toBeNull()
  expect(firstDenial('Monitor', {}, { ...ALL, find_root: false })).toContain('Monitor is disabled')
  expect(firstDenial('Bash', { command: 'sudo ls' }, { sudo: false })).toBeNull()
  expect(firstDenial('Bash', { command: 'sudo ls' }, { sudo: true })).toContain('sudo is disabled')
})

test('a rule is off when its option is missing', () => {
  expect(firstDenial('Monitor', {})).toBeNull()
  expect(firstDenial('Bash', { command: 'sudo ls' })).toBeNull()
})

test('a denial shows a toast naming the rule, without the command', async () => {
  const { hook } = registerMod({ sudo: true, monitor_disabled: true })
  const toasts: string[] = []
  const $ = { ui: { toast: (text: string) => void toasts.push(text) } }
  const next = async () => ({ result: 'ran' })
  const secret = 'sudo cat /etc/secret-token'
  expect(JSON.stringify(await hook($, { tool: 'Bash', command: secret }, next))).toContain('sudo is disabled')
  expect(toasts).toEqual(["Rule 'sudo' denied a command"])
  expect(toasts[0]).not.toContain('secret-token')
  await hook($, { tool: 'Monitor', command: 'ls' }, next)
  expect(toasts[1]).toBe("Rule 'monitor-disabled' denied a command")
})

test('no toast when the call is allowed', async () => {
  const { hook } = registerMod({ sudo: true })
  const toasts: string[] = []
  const $ = { ui: { toast: (text: string) => void toasts.push(text) } }
  expect((await hook($, { tool: 'Bash', command: 'ls' }, async () => ({ result: 'ran' }))).result).toBe('ran')
  expect(toasts).toEqual([])
})

test('a failing toast does not turn a denial into an allow', async () => {
  const { hook } = registerMod({ sudo: true })
  const $ = { ui: { toast: () => { throw new Error('no ui') } } }
  const out = await hook($, { tool: 'Bash', command: 'sudo ls' }, async () => ({ result: 'ran' }))
  expect(out.result).toBeUndefined()
  expect(JSON.stringify(out)).toContain('sudo is disabled')
})

test('firstDenialBy reports the rule id with the reason', () => {
  expect(firstDenialBy('Bash', { command: 'sudo ls' }, ALL)?.rule).toBe('sudo')
  expect(firstDenialBy('Monitor', {}, { find_root: true, monitor_disabled: false })?.rule).toBe('monitor-no-command')
  expect(firstDenialBy('Bash', { command: 'ls' }, ALL)).toBeNull()
})

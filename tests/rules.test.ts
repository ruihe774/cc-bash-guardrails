import { expect, test } from 'claude-code/testing'
import { firstDenial, run0Invocations } from '../hooks/rules.ts'

const deny = (command: string) => firstDenial('Bash', { command })

test('Monitor is denied', () => {
  expect(firstDenial('Monitor', {})).toContain('Monitor is disabled')
  expect(firstDenial('Monitor', {})).toContain('persistent-monitor')
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
  ])
    expect(deny(c)).toContain('until grep')
  for (const c of [
    'tail -f --pid=123 app.log | grep -m1 DONE',
    'until kill -0 123 2>/dev/null; do sleep 1; done',
    'until [ -f done ]; do sleep 1; done',
    'while kill -0 123; do grep -q x f; sleep 1; done',
    'until [ -f done ]; do grep -q x f; sleep 1; done',
    'echo until grep',
  ])
    expect(deny(c)).toBe(null)
})

test('pgrep -f denied unless -a present', () => {
  for (const c of ['pgrep -f foo', 'pgrep -fl foo']) expect(deny(c)).toContain('pgrep -f')
  for (const c of ['pgrep -af foo', 'pgrep foo', 'pgrep -x foo']) expect(deny(c)).toBe(null)
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

test('run0 asks the user with the wrapped command before it runs', async ($, on) => {
  let asked = ''
  let answer = 'Allow'
  on('tool.call', ($, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      asked = e.questions[0].question
      return { result: { answers: { [e.questions[0].question]: answer } } }
    }
    return { result: 'ran' }
  })

  const ok = await $.tool.call({ tool: 'Bash', command: 'run0 -u root systemctl restart foo' })
  expect(asked).toContain('run0 -u root systemctl restart foo')
  expect(ok.result).toBe('ran')

  answer = 'Deny'
  const no = await $.tool.call({ tool: 'Bash', command: 'run0 id' })
  expect(JSON.stringify(no)).toContain('declined run0')

  asked = ''
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(asked).toBe('')
})

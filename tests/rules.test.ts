import { expect, test } from 'claude-code/testing'
import { firstDenial } from '../hooks/rules.ts'

const deny = (command: string) => firstDenial('Bash', { command })

test('Monitor is denied', () => {
  expect(firstDenial('Monitor', {})).toContain('Monitor is disabled')
})

test('find rooted at / is denied, scoped find is not', () => {
  for (const c of ['find / -name x', 'ls; find / -name x', 'sudo find -L / -type f', 'echo $(find /)'])
    expect(deny(c)).toContain('find rooted at /')
  for (const c of ['find /tmp -name x', 'find . -name x', 'echo find /'])
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
    'find ./a -path / -prune',
    'find /tmp -name /',
    'pgrep --list-full --full foo',
    'echo pgrep -f',
    'pgrep -u f foo',
  ])
    expect(deny(c)).toBe(null)
})

test('malformed bash is denied, well-formed multi-line scripts are not', () => {
  for (const c of ['echo "abc', 'echo $(ls', 'if true; then ls', 'ls | ', 'bash -c "echo \'x"', 'echo ok; find /tmp "'])
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
  for (const c of ['find -- /tmp -name x', 'find /tmp/* -name x']) expect(deny(c)).toBe(null)
})

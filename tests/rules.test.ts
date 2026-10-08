import { expect, test } from 'claude-code/testing'
import { decide } from '../hooks/engine.ts'
import { builtin, builtinIds, ruleEnabled, ruleKey } from '../hooks/rules.ts'

// Every rule on, so each rule can be tested regardless of its default
const ALL = Object.fromEntries(builtinIds.map((id) => [ruleKey(id), true]))
const noAsk = async (): Promise<string> => {
  throw new Error('unexpected question')
}
// The deny rules only: the run0 confirmation has its own tests
const denyRules = builtin.rules.filter((r) => !r.ask)
const firstDenial = (tool: string, input: Record<string, unknown>, options?: Record<string, unknown>) =>
  decide(denyRules, tool, input, ruleEnabled(options), noAsk)
const deny = (command: string) => firstDenial('Bash', { command }, ALL)

test('Monitor is denied', async () => {
  expect(await firstDenial('Monitor', {}, ALL)).toContain('Monitor is disabled')
  expect(await firstDenial('Monitor', {}, ALL)).toContain('run_in_background')
})

test('find rooted at / is denied, scoped find is not', async () => {
  for (const c of ['find / -name x', 'ls; find / -name x', 'sudo find -L / -type f', 'echo $(find /)'])
    expect(await deny(c)).toContain('find rooted at /')
  for (const c of ['find /tmp -xdev -name x', 'find . -xdev -name x', 'echo find /'])
    expect(await deny(c)).toBe(null)
})

test('find without -xdev is denied', async () => {
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
    expect(await deny(c)).toContain('-xdev')
  for (const c of [
    'find /tmp -xdev -name x',
    'find -xdev /tmp',
    'find /tmp -mount -type f',
    'find /a /b -name x -xdev',
    'find -L /tmp -xdev -type f',
    'echo $(find /tmp -xdev)',
    'find . -xdev -exec ls {} +',
    // BSD/macOS spelling, alone or among the leading flags
    'find -x . -name x',
    'find -Lx /tmp -type f',
    'find -E -x . -regex x',
    // Informational: nothing is searched
    'find --version',
    'find --help',
    'find -version',
  ])
    expect(await deny(c)).toBe(null)
  // Neither -x inside a longer primary nor --help as a value counts
  for (const c of ['find -xtype l', 'find . -name --help', 'find . -name -x']) expect(await deny(c)).toContain('-xdev')
})

test('until grep loops are denied', async () => {
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
    expect(await deny(c)).toContain('until grep')
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
    expect(await deny(c)).toBe(null)
})

test('pgrep -f denied unless -a present', async () => {
  for (const c of ['pgrep -f foo', 'pgrep -fl foo']) expect(await deny(c)).toContain('pgrep -f')
  for (const c of ['pgrep -af foo', 'pgrep foo', 'pgrep -x foo']) expect(await deny(c)).toBe(null)
})

test('pkill -f is denied, -a does not help', async () => {
  for (const c of ['pkill -f foo', 'pkill -9 -f foo', 'pkill -fa foo', 'sudo pkill -f foo']) expect(await deny(c)).toContain('pkill -f')
  for (const c of ['pkill foo', 'pkill -9 foo', 'pkill -u f foo', 'echo pkill -f']) expect(await deny(c)).toBe(null)
})

test('pgrep output must not be captured', async () => {
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
    expect(await deny(c)).toContain('capture pgrep')
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
    expect(await deny(c)).toBe(null)
})

test('rules follow shell structure, not text', async () => {
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
    expect(await deny(c)).not.toBe(null)
  for (const c of [
    'echo "find / -name x"',
    "grep 'pgrep -f' file",
    'find ./a -xdev -path / -prune',
    'find /tmp -xdev -name /',
    'pgrep --list-full --full foo',
    'echo pgrep -f',
    'pgrep -u f foo',
  ])
    expect(await deny(c)).toBe(null)
})

test('sudo is denied in favour of run0', async () => {
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
    expect(await deny(c)).toContain('run0')
  for (const c of ['run0 ls', 'run0 -u root ls', 'echo sudo', 'grep sudo /etc/group', 'ls sudo'])
    expect(await deny(c)).toBe(null)
})

test('run0 is a wrapper: the command it runs is checked', async () => {
  for (const c of ['run0 find /tmp -name x', 'run0 -u root find / -xdev', 'run0 -D /tmp --nice=5 pgrep -f foo'])
    expect(await deny(c)).not.toBe(null)
  expect(await deny('run0 -u root find /tmp -xdev -name x')).toBe(null)
})

test('malformed bash is denied, well-formed multi-line scripts are not', async () => {
  for (const c of ['echo "abc', 'echo $(ls', 'if true; then ls', 'ls | ', 'bash -c "echo \'x"', 'echo ok; find /tmp -xdev "'])
    expect(await deny(c)).toContain('Malformed bash')
  for (const c of ['cat <<EOF\nhi\nEOF\n', 'for i in 1 2; do echo $i; done', '[[ -f x ]] && echo $((1+2))', ''])
    expect(await deny(c)).toBe(null)
})

test('substitutions in every syntax position are seen', async () => {
  for (const c of [
    'arr=( $(find /) )',
    'declare -a x=($(find /))',
    'a[$(find /)]=1',
    '(( $(find /) ))',
  ])
    expect(await deny(c)).toContain('find rooted at /')
})

test('cat that only shows a file is denied in favour of Read', async () => {
  for (const c of [
    'cat f',
    'cat -n a b',
    'cat --number f',
    'cat < f',
    'ls; cat "my file"',
    'cat f && echo done',
    'cat f 2>/dev/null',
    'bash -c "cat f"',
    'cat f | head -n 5',
    'cat f | head -20',
    'cat -n f | tail --lines=20',
    'cat f | head -n 50 | tail -n 10',
    "cat f | sed -n '3,5p'",
    "cat f | awk 'NR>=3 && NR<=5'",
  ])
    expect(await deny(c)).toContain('Use the Read tool to view a file')
  for (const c of [
    'cat f | grep x',
    'cat f | head | wc -l',
    'cat f > g',
    'cat a b >> g',
    '{ cat f; } > g',
    'bash -c "cat f" > g',
    'x=$(cat f)',
    'diff <(cat a) b',
    'cat -A f',
    'cat -v f | head',
    'cat',
    'cat -',
    'echo hi | cat',
    'cat /proc/cpuinfo',
    'cat /dev/null',
    'cat < /dev/stdin',
    'cat f | head -c 5',
    'cat f | tail -f',
    'cat f | head > g',
    "cat f | sed 's/a/b/'",
    'echo cat f',
  ])
    expect(await deny(c)).toBe(null)
  // Only the Bash tool: Monitor streams commands
  expect(await firstDenial('Monitor', { command: 'cat f' }, { ...ALL, monitor_disabled: false })).toBe(null)
})

test('head, sed and awk picking lines of a file are denied in favour of Read', async () => {
  for (const c of [
    'head f',
    'head -n 5 f',
    'head -5 a b',
    "sed -n '10,20p' f",
    'sed -n 10p f',
    "sed -n '10,$p' f",
    "sed -n '10,+5p;16q' f",
    "sed --quiet -e '5p' f",
    "sed '5q' f",
    "sed '10,20!d' f",
    "awk 'NR>=10 && NR<=20' f",
    "awk 'NR==3{print;exit}' f",
    "awk 'NR==3,NR==7 { print $0 }' f",
    "gawk -F: 'FNR<5' f",
  ])
    expect(await deny(c)).toContain('Use the Read tool with offset and limit')
  for (const c of [
    'tail -n 5 f',
    'head -c 10 f',
    'head',
    'head -n 5 /dev/urandom',
    "sed -n '/x/p' f",
    "sed -n '10,20p'",
    "sed 's/a/b/' f",
    "sed -n -f script f",
    "sed -n '10,20p' f > g",
    "awk '{print $1}' f",
    "awk 'NR>1' n=1",
    "awk -f prog.awk f",
    "x=$(sed -n 5p f)",
    'ls | head -n 5',
    // NUL-separated records, not lines
    'sed -z -n 2p f',
    "sed --null-data '3q' f",
    "cat f | sed -z -n '1,2p'",
  ])
    expect(await deny(c)).toBe(null)
})

test('the file-tool rules leave commands run through sudo, run0 or doas alone', async () => {
  // The sudo rule would deny these first; the point here is the file-tool rules
  const denyAsUser = (command: string) => firstDenial('Bash', { command }, { ...ALL, sudo: false })
  for (const c of [
    'sudo cat /root/x',
    'run0 cat -n /root/x',
    'doas cat /root/x | head -n 5',
    'sudo head -n 5 /var/log/x',
    "run0 sed -n '1,5p' /root/x",
    "sudo awk 'NR==1' /root/x",
    "cat <<'EOF' | sudo tee /etc/x\nhi\nEOF",
    "run0 tee -a /etc/x <<'EOF'\nhi\nEOF",
    "sudo sh -c 'cat > /etc/x <<EOF\nhi\nEOF'",
    "run0 sed -i 's/^#Port 22/Port 2/' /etc/ssh/sshd_config",
    "env X=1 sudo -u root sed -i 's/a/b/' /etc/x",
    `run0 python3 -c "import re;open('f','w').write(re.sub('''a''','b',open('f').read()))"`,
  ])
    expect(await denyAsUser(c)).toBe(null)
  // The elevation must be on the command that touches the file
  for (const [c, rule] of [
    ['sudo true; cat f', 'Use the Read tool to view a file'],
    ['sudo cat f | head -n 5; head -n 5 f', 'Use the Read tool with offset and limit'],
    ["sudo cat <<'EOF' | tee f\nhi\nEOF", 'Use the Write tool'],
    ["bash -c 'sed -i s/a/b/ f'", 'Use the Edit tool'],
  ])
    expect(await denyAsUser(c!)).toContain(rule!)
  // The sudo rule still sees sudo inside a shell it runs
  expect(await deny("sudo sh -c 'cat > /etc/x <<EOF\nhi\nEOF'")).toContain('sudo is disabled')
})

test('a heredoc written to a file is denied in favour of Write', async () => {
  for (const c of [
    'cat <<EOF > f\nhi\nEOF',
    "cat > f <<'EOF'\n$x\nEOF",
    "cat >> f <<-'EOF'\n\thi\n\tEOF",
    'cat - <<EOF >| f\nhi\nEOF',
    'cat <<< "hi" > f',
    'cat <<EOF | tee f\nhi\nEOF',
    'cat <<EOF | tee -a f > /dev/null\nhi\nEOF',
    'tee f <<EOF\nhi\nEOF',
    'tee -a f <<< hi',
    '{ cat <<EOF; } > f\nhi\nEOF',
    'bash -c "cat <<EOF > f\nhi\nEOF"',
  ])
    expect(await deny(c)).toContain('Use the Write tool')
  for (const c of [
    'cat <<EOF\nhi\nEOF',
    'cat <<EOF > f\n$HOME\nEOF',
    'cat <<EOF > f\n$(date)\nEOF',
    'cat <<EOF >&2\nhi\nEOF',
    'cat <<EOF > /dev/stderr\nhi\nEOF',
    'cat <<EOF | python3\nhi\nEOF',
    'cat <<EOF | tee\nhi\nEOF',
    'cat a <<EOF > f\nhi\nEOF',
    'echo hi | tee f',
    'python3 - <<EOF > f\nprint(1)\nEOF',
  ])
    expect(await deny(c)).toBe(null)
})

test('sed -i without g on one file is denied in favour of Edit', async () => {
  for (const c of [
    "sed -i 's/a/b/' f",
    "sed -i 's|a/x|b|2' f",
    "sed -i '3s/a/b/;5s/c/d/' f",
    "sed -i 's/a\\/x/b/' f",
    "sed -i.bak -e 's|a|b|' -e '3d' f",
    "sed --in-place=.orig --expression 's/a/b/' f",
    "sed -E -i 's/(a)/\\1b/' f",
    "sed -i '' 's/a/b/' f",
    "sed -i '10,12d' f",
    "env LC_ALL=C sed -i 's/a/b/' f",
  ])
    expect(await deny(c)).toContain('Use the Edit tool to change a file, not sed -i')
  for (const c of [
    "sed -i 's/a/b/g' f",
    "sed -i 's/a/b/' f g",
    "sed -i 's/a/b/' *.txt x",
    "sed -i -e 's/a/b/' -e 's/c/d/g' f",
    "sed -i '/x/d' f",
    "sed -i '/x/s/a/b/' f",
    "sed -i 'd' f",
    "sed -i -f script f",
    "sed -n -i 's/a/b/p' f",
    "sed 's/a/b/' f",
    "sed -i 'y/abc/xyz/' f",
  ])
    expect(await deny(c)).toBe(null)
})

test('a Python file rewrite with re or .replace() and a multiline string is denied in favour of Edit', async () => {
  const script = "import re\nfrom pathlib import Path\np = Path('f')\np.write_text(re.sub(r'''a\nb''', 'c', p.read_text()))"
  for (const c of [
    `python3 -c "${script}"`,
    `python -c "${script}"`,
    `python3.12 -I -c "${script}"`,
    `python3 - <<'EOF'\n${script}\nEOF`,
    `python3 <<'EOF'\n${script}\nEOF`,
    `python3 -c "import os, re; s = open('f').read(); open('f', 'w').write(s.replace(\\"\\"\\"x\\"\\"\\", 'y'))"`,
    `python3 -c "from re import sub\nwith open('f') as fh: s = fh.read()\ns = sub('''a''', 'b', s)\nwith open('f', 'w') as fh: fh.write(s)"`,
    // .replace() instead of re
    `python3 -c "open('f', 'w').write(open('f').read().replace('''a''', 'b'))"`,
    `python3 - <<'EOF'\nfrom pathlib import Path\np = Path('f')\np.write_text(p.read_text().replace(\"\"\"a\nb\"\"\", \"\"\"c\"\"\"))\nEOF`,
    `python3 <<'EOF'\nwith open('f') as fh:\n    s = fh.read()\ns = s.replace('''old\ntext''', '''new''')\nwith open('f', 'w') as fh:\n    fh.write(s)\nEOF`,
  ])
    expect(await deny(c)).toContain('not a Python script')
  for (const c of [
    // Each condition alone or in groups is not enough (a read-only script has no write)
    `python3 -c "import re; print(open('f').read())"`,
    `python3 -c "import re; print('''x''')"`,
    `python3 -c "print(open('f').read().replace('a', 'b'))"`,
    `python3 -c "print('''a b'''.replace('a', 'b'))"`,
    `python3 -c "print(open('f').read().replaced, '''x''')"`,
    `python3 -c "print(open('f').read().replace('''a''', 'b'))"`,
    `python3 -c "from re import sub\nwith open('f') as fh: s = fh.read()\nprint(sub('''a''', 'b', s))"`,
    `python3 -c "import regex; print(open('f').read(), '''x''')"`,
    `python3 -c "import are; print(open('f').read(), '''x''')"`,
    // The script is a file, a module, or something other than python
    `python3 edit.py - <<'EOF'\n${script}\nEOF`,
    `python3 -m re "'''x''' open("`,
    `node -e "${script}"`,
    `echo "${script}"`,
  ])
    expect(await deny(c)).toBe(null)
})

test('find -- and /* count as rooted at /', async () => {
  for (const c of ['find -- / -name x', 'find /* -name x', 'find -L -- // x']) expect(await deny(c)).toContain('find rooted at /')
  for (const c of ['find -- /tmp -xdev -name x', 'find /tmp/* -xdev -name x']) expect(await deny(c)).toBe(null)
})

test('Monitor commands go through the Bash rules even when Monitor itself is allowed', async () => {
  const on = { ...ALL, monitor_disabled: false }
  for (const command of ['find / -xdev', 'sudo ls', 'pkill -f foo', 'until grep x log; do sleep 1; done', 'echo "unterminated'])
    expect(await firstDenial('Monitor', { command }, on)).not.toBeNull()
  expect(await firstDenial('Monitor', { command: 'tail -f --pid=1 log' }, on)).toBeNull()
  // The command field is missing: refuse rather than check an empty string
  expect(await firstDenial('Monitor', {}, on)).toContain('either a command or a ws source')
  // A ws source runs no shell
  expect(await firstDenial('Monitor', { ws: { url: 'wss://example.com/stream' } }, on)).toBeNull()
  expect(await firstDenial('Monitor', { ws: { url: 'wss://example.com/stream' } }, ALL)).toContain('Monitor is disabled')
  expect(await firstDenial('Monitor', {}, { monitor_disabled: false })).toBeNull()
})

test('a rule is skipped when its option is false', async () => {
  expect(await firstDenial('Monitor', { command: 'ls' }, { ...ALL, monitor_disabled: false })).toBeNull()
  expect(await firstDenial('Monitor', {}, { ...ALL, find_root: false })).toContain('Monitor is disabled')
  expect(await firstDenial('Bash', { command: 'sudo ls' }, { sudo: false })).toBeNull()
  expect(await firstDenial('Bash', { command: 'sudo ls' }, { sudo: true })).toContain('sudo is disabled')
})

test('a rule is off when its option is missing', async () => {
  expect(await firstDenial('Monitor', {})).toBeNull()
  expect(await firstDenial('Bash', { command: 'sudo ls' })).toBeNull()
})

// The question the run0 confirmation asks for `command`, or '' when it asks nothing
async function run0Question(command: string, tool = 'Bash') {
  let asked = ''
  await decide(builtin.rules, tool, { command }, ruleEnabled({ run0_confirm: true }), async (q) => ((asked = q), 'Allow'))
  return asked
}
const run0Lines = async (command: string) => {
  const q = await run0Question(command)
  return q ? q.split('\n\n')[1]!.split('\n') : []
}

test('the run0 question lists the exact wrapped commands', async () => {
  expect(await run0Lines('run0 ls')).toEqual(['  run0 ls'])
  expect(await run0Lines('run0 -u root systemctl restart "my unit"')).toEqual(["  run0 -u root systemctl restart 'my unit'"])
  expect(await run0Lines('echo hi; env X=1 run0 -D /tmp ls | wc -l')).toEqual(['  run0 -D /tmp ls'])
  expect(await run0Lines('bash -c "run0 id"')).toEqual(['  run0 id'])
  expect(await run0Lines('run0 -v')).toEqual(['  run0 -v'])
  expect(await run0Lines('run0 a; run0 a; env run0 b')).toEqual(['  run0 a', '  run0 b'])
  expect(await run0Lines('ls; echo run0')).toEqual([])
  expect(await run0Question('run0 id', 'Monitor')).toContain('Full Monitor command:\nrun0 id')
})

test('run0 answers: Allow runs, Deny and free text decline, a dismissed prompt denies', async () => {
  const on = ruleEnabled({ run0_confirm: true })
  const answer = (a: string) => async () => a
  expect(await decide(builtin.rules, 'Bash', { command: 'run0 id' }, on, answer('Allow'))).toBeNull()
  expect(await decide(builtin.rules, 'Bash', { command: 'run0 id' }, on, answer('Deny'))).toBe(
    'The user declined run0. Do not retry without asking.',
  )
  expect(await decide(builtin.rules, 'Bash', { command: 'run0 id' }, on, answer('only with -D /tmp'))).toBe(
    'The user declined run0: only with -D /tmp. Do not retry without asking.',
  )
  expect(await decide(builtin.rules, 'Bash', { command: 'run0 id' }, on, noAsk)).toContain('not approved')
  // Off by default
  expect(await decide(builtin.rules, 'Bash', { command: 'run0 id' }, ruleEnabled({}), noAsk)).toBeNull()
})

test('a denied call is never asked about', async () => {
  const opts = ruleEnabled({ run0_confirm: true, sudo: true })
  expect(await decide(builtin.rules, 'Bash', { command: 'sudo ls; run0 id' }, opts, noAsk)).toContain('sudo is disabled')
})

test('Monitor without a command has its own toggle', async () => {
  expect(await firstDenial('Monitor', {}, { monitor_no_command: true })).toContain('either a command or a ws source')
  expect(await firstDenial('Monitor', {}, { ...ALL, monitor_no_command: false, monitor_disabled: false })).toBeNull()
  expect(await firstDenial('Monitor', { command: 42 }, { monitor_no_command: true })).toContain('either a command or a ws source')
  expect(await firstDenial('Bash', {}, ALL)).toBeNull()
})

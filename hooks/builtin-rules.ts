// The built-in rules, written in the same rule-file format as custom rules (see
// README.md) and compiled by the same engine. Each is toggled by the userConfig
// option named after its id (find-xdev -> find_xdev). This is a .ts module only
// because a hooks module can import nothing but code files.
import type { RuleFile } from './engine.ts'

export const builtinRules: RuleFile = {
  defs: {
    // find's leading options (-H -L -P, -D <debugopts>, -O<level>); its start points follow
    FIND_LEAD: { short: 'HLPD:O:', posix: true },
    // find's expression: primaries that consume a value, which may itself look like an option
    FIND_EXPR: {
      words: {
        '-D': 1,
        '-name': 1, '-iname': 1, '-path': 1, '-ipath': 1, '-wholename': 1, '-iwholename': 1, '-regex': 1, '-iregex': 1,
        '-lname': 1, '-ilname': 1, '-type': 1, '-xtype': 1, '-user': 1, '-group': 1, '-perm': 1, '-size': 1,
        '-newer': 1, '-anewer': 1, '-cnewer': 1, '-samefile': 1, '-mtime': 1, '-atime': 1, '-ctime': 1, '-mmin': 1,
        '-amin': 1, '-cmin': 1, '-links': 1, '-inum': 1, '-uid': 1, '-gid': 1, '-used': 1, '-fstype': 1, '-printf': 1,
        '-fprintf': 1, '-fprint': 1, '-fprint0': 1, '-fls': 1, '-context': 1, '-maxdepth': 1, '-mindepth': 1, '-newerXY': 1,
        '-exec': [';', '+'], '-execdir': [';', '+'], '-ok': [';', '+'], '-okdir': [';', '+'],
      },
      wordPatterns: { '^-newer[aBcmt][aBcmt]$': 1 },
    },
    // pgrep/pkill options that take a value, so in `-uf` the f is a user name, not -f
    PGREP: { short: 'dFgGJOPrstTuU', shortTakesValue: true, long: { full: 'f', 'list-full': 'a' } },
    GREPS: ['grep', 'egrep', 'fgrep', 'rg'],
  },
  rules: [
    {
      id: 'monitor-disabled',
      tools: ['Monitor'],
      when: 'true',
      deny: 'Monitor is disabled. Use Bash with run_in_background to spawn a blocking waiter that exits on the next event.',
    },
    {
      // A ws source streams a WebSocket and runs no shell, so there is nothing to check.
      // With neither field the shell rules would be checking an empty string: fail closed.
      id: 'monitor-no-command',
      tools: ['Monitor'],
      when: '!(has(input.command) && type(input.command) == string) && !has(input.ws)',
      deny: 'Monitor call has no command string that the Bash guard rules can check; refusing it rather than running it unchecked.',
    },
    {
      // First among the shell rules: if the command can't be parsed, the rules below can't be trusted to see all of it
      id: 'malformed-bash',
      when: 'size(errors) > 0',
      deny: 'Malformed bash command ({{ errors[0] }}). Fix the syntax and retry.',
    },
    {
      // `/*` expands to every top-level entry, which scans the whole filesystem too
      id: 'find-root',
      when: "cmds.exists(c, c.name == 'find' && c.args.operands(FIND_LEAD).takeWhile(r'^(?!-|[(!]$)').exists(p, p.matches(r'^/+(\\./?)*\\*?$')))",
      deny: 'find rooted at / is disabled. Scan a specific directory instead.',
    },
    {
      // -mount is the traditional spelling of -xdev
      id: 'find-xdev',
      when: "cmds.exists(c, c.name == 'find' && !c.args.opts(FIND_EXPR).exists(o, o in ['-xdev', '-mount']))",
      deny: 'find must specify -xdev so it does not cross filesystem boundaries. To search several filesystems, issue a separate find -xdev per filesystem.',
    },
    {
      // pkill has no list-full option, so -a does not help it
      id: 'pgrep-f',
      when: "cmds.exists(c, cel.bind(o, c.args.opts(PGREP), 'f' in o && (c.name == 'pkill' || c.name == 'pgrep' && !('a' in o))))",
      deny: 'pgrep -f and pkill -f can match helper processes spawned by the harness (e.g. its bash -c wrapper), and pkill would kill them. Use pgrep -af, confirm each match cmdline, then kill by PID.',
    },
    {
      id: 'pgrep-captured',
      when: "cmds.exists(c, c.name == 'pgrep' && c.captured)",
      deny: 'Do not capture pgrep output in a pipe or substitution ($(...), `...`, <(...)). Let pgrep print straight to stdout and read the result.',
    },
    {
      id: 'until-grep',
      when: 'untilConds.exists(cond, cond.exists(c, c.name in GREPS))',
      deny: 'An "until grep ..." (or "while ! grep ...") loop never exits if the process writing the log silently dies. Watch the process instead: tail -f --pid=<PID> <log> | grep -m1 <pattern> (tail stops when the process exits, ending the pipeline either way). Run it with run_in_background.',
    },
    {
      id: 'sudo',
      when: "cmds.exists(c, c.chain.exists(l, l.name == 'sudo'))",
      deny: 'sudo is disabled: passwordless sudo is insecure, and a password prompt needs a TTY, which Bash processes spawned by Claude Code do not have. Use run0 instead, which shows the user a graphical auth prompt every time and does not cache authentication.',
    },
    {
      // run0's graphical prompt does not show the wrapped command, so show it here first.
      // Each run0 in a chain (`env X=1 run0 ls`) reports its own tail.
      id: 'run0-confirm',
      let: { items: "cmds.map(c, c.chain.filter(l, l.name == 'run0').map(l, shquote(l.argv))).flatten().distinct()" },
      when: 'size(items) > 0',
      ask: {
        header: 'run0',
        question: "Allow Claude to run with elevated privileges via run0?\n\n{{ items.map(i, '  ' + i).join('\\n') }}\n\nFull {{ tool }} command:\n{{ input.command }}\n\nAllow?",
        options: ['Allow', 'Deny'],
        allowIf: "answer == 'Allow'",
        declined: "The user declined run0{{ answer == 'Deny' ? '' : ': ' + answer }}. Do not retry without asking.",
        dismissed: 'run0 was not approved: the confirmation was dismissed or no one could be asked.',
      },
    },
  ],
}

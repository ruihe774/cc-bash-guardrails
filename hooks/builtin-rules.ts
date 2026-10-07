// The built-in rules, written in the same rule-file format as custom rules (see
// README.md) and compiled by the same engine. Each is toggled by the userConfig
// option named after its id (find-xdev -> find_xdev). This is a .ts module only
// because a hooks module can import nothing but code files.
import type { RuleFile } from './engine.ts'

// CEL fragments shared by the rules that point to the Read, Write and Edit tools.
// Each takes the CEL expression for a Cmd (or for a list of file operands).

// Its output reaches the tool result: not piped, substituted or redirected
const toTerminal = (c: string) => `!${c}.captured && ${c}.stdout == ''`
// Operands that are regular files the file tools can open
const someFiles = (f: string) => `size(${f}) > 0 && ${f}.all(x, x != '-' && !x.matches(SPECIAL_FILE))`
const noFiles = (f: string) => `size(${f}) == 0`
// cat that only shows files (or the one its stdin is redirected from), at most numbering lines
const catShows = (c: string) =>
  `${c}.name == 'cat' && ${c}.args.opts(CAT).all(o, o in ['b', 'n', 's', 'u']) && cel.bind(f, ${c}.args.operands(CAT), size(f) > 0 ? ${someFiles('f')} : ${c}.redirects.exists(r, r.op == '<' && r.fd <= 0 && !r.target.matches(SPECIAL_FILE)))`
// head or tail picking lines (not bytes, not following)
const headPicks = (c: string, names: string, files: (f: string) => string) =>
  `${c}.name in ${names} && ${c}.args.opts(HEAD_TAIL).all(o, o in ['n', 'q', 'v'] || o.matches('^[0-9]$')) && cel.bind(f, ${c}.args.operands(HEAD_TAIL), ${files('f')})`
// sed -n 'X,Yp', sed 'X,Y!d' or sed 'Nq': the script from -e, or else the first operand
const sedPicks = (c: string, files: (f: string) => string) =>
  `${c}.name == 'sed' && cel.bind(o, ${c}.args.opts(SED), !('i' in o) && !('f' in o) && cel.bind(e, ${c}.args.optValues(SED, 'e'), cel.bind(ops, ${c}.args.operands(SED), cel.bind(scripts, size(e) > 0 ? e : ops.take(1), size(scripts) > 0 && scripts.all(s, s.matches('n' in o ? SED_PRINT : SED_KEEP)) && cel.bind(f, size(e) > 0 ? ops : ops.drop(1), ${files('f')})))))`
// awk 'NR>=X && NR<=Y': the program is the first operand; var=value operands are not files
const awkPicks = (c: string, files: (f: string) => string) =>
  `${c}.name in AWKS && cel.bind(o, ${c}.args.opts(AWK), !('f' in o) && !('e' in o) && cel.bind(ops, ${c}.args.operands(AWK), size(ops) > 0 && ops[0].matches(AWK_LINES) && cel.bind(f, ops.drop(1).filter(x, !x.matches('^[A-Za-z_][A-Za-z0-9_]*=')), ${files('f')})))`
// Its stdin is a heredoc or here-string of fixed text (nothing for the shell to expand)
const literalStdin = (c: string) =>
  `${c}.redirects.exists(r, r.op in ['<<', '<<-', '<<<'] && r.fd <= 0 && (r.quoted || !r.body.matches(EXPANSION)))`
const catFromLiteral = (c: string) => `${c}.name == 'cat' && ${c}.args.operands(CAT).all(x, x == '-') && ${literalStdin(c)}`
const teeFiles = (c: string) => `${c}.name == 'tee' && cel.bind(f, ${c}.args.operands(TEE), size(f) > 0 && f.all(x, !x.matches(SPECIAL_FILE)))`
// A Python script, from -c or from a heredoc on stdin, that matches every regex in PY_EDIT
const pyEdits = (s: string) => `PY_EDIT.all(re, ${s}.matches(re))`
const pythonEdits = (c: string) =>
  `${c}.name.matches(PYTHON_NAME) && cel.bind(o, ${c}.args.opts(PYTHON), ${c}.args.optValues(PYTHON, 'c').exists(s, ${pyEdits('s')}) || !('c' in o) && !('m' in o) && cel.bind(ops, ${c}.args.operands(PYTHON), size(ops) == 0 || ops[0] == '-') && ${c}.redirects.exists(r, r.op in ['<<', '<<-', '<<<'] && r.fd <= 0 && ${pyEdits('r.body')}))`

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
    // Files the Read, Write and Edit tools are not for
    SPECIAL_FILE: '^/(dev|proc|sys)/',
    // Text the shell would expand in an unquoted heredoc
    EXPANSION: '[$`]',
    // cat's options; with nothing but -b -n -s -u it only shows the file
    CAT: {
      short: 'AbeEnstTuv',
      long: { 'show-all': 'A', 'number-nonblank': 'b', 'show-ends': 'E', number: 'n', 'squeeze-blank': 's', 'show-tabs': 'T', 'show-nonprinting': 'v' },
    },
    HEAD_TAIL: {
      short: 'c:n:s:fFqvz',
      long: {
        bytes: 'c:', lines: 'n:', 'sleep-interval': 's:', pid: 'pid:', 'max-unchanged-stats': 'max-unchanged-stats:',
        follow: 'f', quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z',
      },
    },
    // GNU sed; -i takes an optional suffix in the same argument (-i.bak)
    SED: {
      short: 'nrEsuzi::e:f:l:',
      long: {
        quiet: 'n', silent: 'n', 'in-place': 'i', expression: 'e:', file: 'f:', 'line-length': 'l:',
        'regexp-extended': 'E', separate: 's', unbuffered: 'u', 'null-data': 'z',
      },
    },
    // A sed -n script that prints a line or a range of lines (X,Y X,$ X,+N), maybe quitting after
    SED_PRINT: String.raw`^\s*(\d+|\$)(\s*,\s*(\d+|\$|\+\d+))?\s*p\s*(;\s*\d+\s*q\s*)?;?\s*$`,
    // A sed script (without -n) that keeps only a range of lines: X,Y!d or Nq
    SED_KEEP: String.raw`^\s*((\d+|\$)(\s*,\s*(\d+|\$|\+\d+))?\s*!\s*d|\d+\s*q)\s*;?\s*$`,
    // A sed script of nothing but s commands without the g flag (on every line, or on a line
    // or range) and deletions of a line or range, separated by ; or newlines
    SED_EDIT: String.raw`^[\s;]*(?:(?:(?:(?:\d+|\$)(?:[ \t]*,[ \t]*(?:\d+|\$))?[ \t]*)?s([^\\\n\sA-Za-z0-9])(?:\\.|(?!\1)[^\\\n])*\1(?:\\.|(?!\1)[^\\\n])*\1[0-9pIiMm]*|(?:\d+|\$)(?:[ \t]*,[ \t]*(?:\d+|\$))?[ \t]*d)[ \t]*(?:[;\n][\s;]*|$))+$`,
    AWKS: ['awk', 'gawk', 'mawk', 'nawk'],
    AWK: { short: 'F:v:f:e:', long: { 'field-separator': 'F:', assign: 'v:', file: 'f:', source: 'e:' }, posix: true },
    // An awk program that prints a line or a range of lines by NR (or FNR), maybe exiting after
    AWK_LINES: String.raw`^\s*F?NR\s*(==|>=|<=|>|<)\s*\d+\s*((&&|,)\s*F?NR\s*(==|>=|<=|>|<)\s*\d+\s*)?(\{\s*(print(\s+\$0)?\s*;?\s*)?(exit\s*;?\s*)?\}\s*)?$`,
    TEE: { short: 'aip', long: { append: 'a', 'ignore-interrupts': 'i' } },
    PYTHON_NAME: String.raw`^python(3(\.\d+)?)?$`,
    // Options stop at the first operand: the script file, or - for stdin
    PYTHON: { short: 'bBdEhiIOPqsSuvVxc:m:W:X:', posix: true },
    // A Python script that edits a file: it imports re or calls .replace(), opens a file
    // (open() or pathlib) and has a multiline (triple-quoted) string literal. It must match all three.
    PY_EDIT: [
      String.raw`(^|[\n;])[ \t]*(import[ \t]+([\w.]+([ \t]+as[ \t]+\w+)?[ \t]*,[ \t]*)*re(?![\w.])|from[ \t]+re[ \t]+import\b)|\.replace\s*\(`,
      String.raw`\bopen\s*\(|\bpathlib\b`,
      `"{3}|'{3}`,
    ],
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
      // cat whose output reaches the tool result, alone or through line pickers (cat f | head)
      id: 'cat-read',
      tools: ['Bash'],
      when: `cmds.exists(c, ${toTerminal('c')} && ${catShows('c')}) || pipelines.exists(p, size(p) >= 2 && ${catShows('p[0]')} && p.all(st, st.stdout == '') && !p[size(p) - 1].captured && p.drop(1).all(st, ${headPicks('st', "['head', 'tail']", noFiles)} || ${sedPicks('st', noFiles)} || ${awkPicks('st', noFiles)}))`,
      deny: 'Use the Read tool to view a file, not cat (alone or piped into head, tail, sed or awk). Read numbers the lines, and its offset and limit select a range of them. cat is still fine when its output feeds another command or a file.',
    },
    {
      // A standalone tail is left alone: Read can't count lines back from the end
      id: 'line-range-read',
      tools: ['Bash'],
      when: `cmds.exists(c, ${toTerminal('c')} && (${headPicks('c', "['head']", someFiles)} || ${sedPicks('c', someFiles)} || ${awkPicks('c', someFiles)}))`,
      deny: "Use the Read tool with offset and limit to view lines of a file, not head, sed -n 'X,Yp' or awk 'NR>=X && NR<=Y'.",
    },
    {
      // cat <<EOF > file, cat <<EOF | tee file, tee file <<EOF. A heredoc the shell expands
      // ($var, $(cmd)) has content only the shell knows, so it is left alone.
      id: 'heredoc-write',
      tools: ['Bash'],
      when: `cmds.exists(c, ${catFromLiteral('c')} && c.stdout != '' && !c.stdout.startsWith('&') && !c.stdout.matches(SPECIAL_FILE) || ${teeFiles('c')} && ${literalStdin('c')}) || pipelines.exists(p, size(p) == 2 && ${catFromLiteral('p[0]')} && ${teeFiles('p[1]')})`,
      deny: 'Use the Write tool to create or overwrite a file (or Edit to add to one), not a heredoc through cat or tee.',
    },
    {
      // A global (g) substitution, or one over several files, is a batch job and stays allowed
      id: 'sed-edit',
      tools: ['Bash'],
      when: "cmds.exists(c, c.name == 'sed' && cel.bind(o, c.args.opts(SED), 'i' in o && !('n' in o) && !('f' in o) && cel.bind(e, c.args.optValues(SED, 'e'), cel.bind(ops, c.args.operands(SED).filter(x, x != ''), cel.bind(scripts, size(e) > 0 ? e : ops.take(1), size(scripts) > 0 && scripts.all(s, s.matches(SED_EDIT)) && size(size(e) > 0 ? ops : ops.drop(1)) == 1)))))",
      deny: 'Use the Edit tool to change a file, not sed -i: Edit shows the exact change and fails if the text is not there. sed -i is still fine for a global (g) substitution or one across several files.',
    },
    {
      id: 'python-edit',
      tools: ['Bash'],
      when: `cmds.exists(c, ${pythonEdits('c')})`,
      deny: 'Use the Edit tool (with replace_all to change every occurrence) to change a file, not a Python script that rewrites it with re or .replace() and a multiline string.',
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

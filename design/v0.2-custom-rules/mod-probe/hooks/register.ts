import { Environment } from './vendor/cel.js'

export const env = new Environment()
  .registerVariable('cmds', 'list<map<string, dyn>>')
  .registerFunction('shquote(list<string>): string', (a: string[]) => a.join(' '))

export function register(on: any) {
  on('tool.call', { tool: 'Bash' }, async ($: any, e: any, next: any) => {
    const hit = env.evaluate("cmds.exists(c, c.name == 'find' && c.args.exists(a, a.matches(r'^/+$')))", { cmds: [{ name: 'find', args: e.command.split(' ').slice(1) }] })
    return hit ? { deny: 'rooted' } : next(e)
  })
}

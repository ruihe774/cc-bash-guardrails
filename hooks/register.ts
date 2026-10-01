import { firstDenial } from './rules.ts'

export function register(on: any) {
  on('tool.call', { tool: ['Monitor', 'Bash'] }, async ($: any, e: any, next: any) => {
    const reason = firstDenial(e.tool, e)
    if (reason) return { deny: reason }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    // Without this a failed hook is skipped and the call runs unguarded
    if (next.called) return next(e)
    return { deny: `guard-rules failed (${next.error.message}); refusing the call rather than running it unchecked.` }
  })
}

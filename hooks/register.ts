import { firstDenialBy, run0Invocations, ruleEnabled } from './rules.ts'

export function register(on: any, options?: Record<string, unknown>) {
  on('tool.call', { tool: ['Monitor', 'Bash'] }, async ($: any, e: any, next: any) => {
    const denial = firstDenialBy(e.tool, e, options)
    if (denial) {
      // Name the rule only: the command is in the verbose transcript (Ctrl+O)
      try { $.ui.toast(`Rule '${denial.rule}' denied a command`) } catch {}
      return { deny: denial.reason }
    }
    // run0's graphical prompt does not show the wrapped command, so show it here first
    const run0 = ruleEnabled(options, 'run0_confirm') ? run0Invocations(typeof e.command === 'string' ? e.command : '') : []
    if (run0.length) {
      const question = `Allow Claude to run with elevated privileges via run0?\n\n${run0.map((c) => `  ${c}`).join('\n')}\n\nFull ${e.tool} command:\n${e.command}\n\nAllow?`
      let answer: string
      try {
        answer = await $.ui.ask(question, { options: ['Allow', 'Deny'], header: 'run0' })
      } catch {
        return { deny: 'run0 was not approved: the confirmation was dismissed or no one could be asked.' }
      }
      if (answer !== 'Allow') return { deny: `The user declined run0${answer === 'Deny' ? '' : `: ${answer}`}. Do not retry without asking.` }
    }
    return next(e)
  }).catch(async ($: any, e: any, next: any) => {
    // Without this a failed hook is skipped and the call runs unguarded
    if (next.called) return next(e)
    return { deny: `bash-guardrails failed (${next.error.message}); refusing the call rather than running it unchecked.` }
  })
}

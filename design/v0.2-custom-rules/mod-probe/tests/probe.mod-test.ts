import { expect, test } from 'claude-code/testing'
import { env } from '../hooks/register.ts'

test('cel-js evaluates inside the mod runtime', () => {
  expect(env.evaluate("[1, 2, 3].exists(x, x > 2) && 'abc'.matches('^a')")).toBe(true)
  expect(env.evaluate("shquote(['a', 'b'])")).toBe('a b')
  expect(env.check('cmds.length').valid).toBe(false)
})

test('a tool.call hook built on cel-js denies', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'find / -x' }))).toContain('rooted')
  expect((await $.tool.call({ tool: 'Bash', command: 'find . -x' })).result).toBe('ran')
})

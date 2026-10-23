import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Every candidate must finish its blocking checks before it can be released.
test('blocking CI runs for pull requests and never cancels an admitted candidate', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
    on: Record<string, unknown>
    concurrency?: unknown
    jobs: Record<string, { concurrency?: unknown }>
  }
  expect(Object.hasOwn(workflow.on, 'pull_request')).toBe(true)
  expect(workflow.concurrency).toBeUndefined()
  for (const job of Object.values(workflow.jobs)) expect(job.concurrency).toBeUndefined()
})

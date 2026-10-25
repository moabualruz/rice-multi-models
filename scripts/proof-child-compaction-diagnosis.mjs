// Records, for one routed child in ordinary native Claude, whether a native compaction attempt fired, was skipped or
// failed: the window source and effective window Claude resolved, each session.compact entry and what answered it,
// and what Claude's failure breaker did. Observation only: the fixture's hooks log, the production hooks decide.
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { waitForNativeProofCapacity } from './native-proof-load.mjs'
import { runChildCase } from './child-compaction-fixture.mjs'

if (!(await waitForNativeProofCapacity())) process.exit(1)
const native = process.env.RICE_CLAUDE_EXECUTABLE || 'claude'
const LONG = [20000, 50000, 70000, 72000, 74000, 75000, 76000, 77000, 78000, 79000]

/** fired: a session.compact answered with the summary and a compact_boundary landed. failed: Claude asked and the answer was a skip or a rejection. skipped: Claude never asked. */
function outcomeOf(result) {
  const entries = result.sessionCompact.filter(row => row.kind === 'compact-entry')
  const answers = result.sessionCompact.filter(row => row.kind === 'compact-result')
  if (result.autoBoundaries > 0 && answers.some(row => row.messages === 1)) return 'fired'
  if (entries.length > 0 && answers.length > 0 && answers.every(row => row.skip !== undefined || row.rejected !== undefined)) return 'failed'
  if (entries.length === 0) return 'skipped'
  return 'unexpected'
}

const scenarios = [
  { scenario: 'launch-data', expected: 'fired', options: {} },
  { scenario: 'late-data', expected: 'skipped', options: { seeded: false } },
  { scenario: 'provider-failure', expected: 'failed', options: { summary: 'error', inputs: LONG } },
  { scenario: 'empty-summary', expected: 'failed', options: { summary: 'empty', inputs: LONG } },
]
const records = []
for (const { scenario, expected, options } of scenarios) {
  const result = await runChildCase({ label: scenario, native, ...options })
  assert.equal(result.timedOut, false, `${scenario}: native fixture deadline`)
  assert.equal(result.code, 0, `${scenario}: claude exits cleanly`)
  const answers = result.sessionCompact.filter(row => row.kind === 'compact-result')
  const record = {
    scenario, outcome: outcomeOf(result),
    window: { source: result.window.source, effective: result.window.effective },
    nativeAttempts: result.nativeAttempts,
    sessionCompact: { entries: result.sessionCompact.filter(row => row.kind === 'compact-entry').map(({ kind, ...row }) => row), answers: answers.map(({ kind, agentId, ...row }) => row) },
    childBoundaries: result.boundaries,
    summaryRequests: result.summaryRequests.length,
    // Claude's failure breaker counts a rejected summarization; the failed mapped summary lets Claude's own summarizer reject on a single message.
    failureBreaker: { trippedLines: result.breaker, failedAttempts: result.sessionCompact.filter(row => row.kind === 'compact-entry').length, rejectedAnswers: answers.filter(row => row.rejected).length },
    anthropicPosts: result.anthropicPosts.length,
  }
  records.push(record)
  console.log(JSON.stringify(record))
  assert.equal(record.outcome, expected, `${scenario}: recorded outcome`)
  assert.equal(record.anthropicPosts, 0, `${scenario}: nothing reaches the Anthropic API`)
  rmSync(result.fixture, { recursive: true, force: true })
}
for (const scenario of ['provider-failure', 'empty-summary']) {
  const failed = records.find(row => row.scenario === scenario)
  assert.equal(failed.failureBreaker.failedAttempts, 3, `${scenario}: Claude stops after three consecutive failed compactions, as it does natively`)
  assert.equal(failed.nativeAttempts, 3, `${scenario}: no attempt after the breaker trips`)
  assert.ok(failed.failureBreaker.trippedLines.some(line => /circuit breaker tripped after 3 consecutive failures/.test(line)), `${scenario}: the breaker trips`)
  assert.equal(failed.summaryRequests, 3, `${scenario}: the provider is asked once per attempt and then left alone`)
}
console.log(JSON.stringify({ childCompactionDiagnosis: true, outcomes: Object.fromEntries(records.map(row => [row.scenario, row.outcome])) }))

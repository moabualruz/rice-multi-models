// Learns Claude Code's own compaction prompt and summary message by running the installed claude once, in a
// throwaway folder, against a loopback stub (helper/native-run.ts): no network, no account, none of the person's
// settings, plugins or sessions. Two real `/compact` runs are recorded, one without instructions and one with a
// known marker, and hooks/native-compaction.ts turns them into a template. The caller caches the result per version.
import { deriveTemplate, INSTRUCTIONS_MARK, SUMMARY_MARK, type CompactionTemplate } from '../hooks/native-compaction.ts'
import { runNative, textOf } from './native-run.ts'

/** Runs the capture; rejects when the installed claude does not behave as expected. */
export async function captureCompaction(outer?: AbortSignal): Promise<CompactionTemplate> {
  const prompts: string[] = []
  const run = await runNative({
    label: 'compaction',
    script: ['capture one', '/compact', 'capture two', `/compact ${INSTRUCTIONS_MARK}`],
    answer: parsed => {
      const last = textOf((parsed.messages as { content?: unknown }[] | undefined)?.at(-1)?.content)
      // The summary request is the one that asks for the two blocks its answer is read by.
      const summary = last.includes('<analysis>') && last.includes('<summary>')
      if (summary) prompts.push(last)
      return { text: summary ? `<analysis>analysis</analysis>\n<summary>\n${SUMMARY_MARK}\n</summary>` : 'ok' }
    },
    signal: outer,
  })
  if (prompts.length !== 2) throw new Error(`the installed claude sent ${prompts.length} summary requests, not 2`)

  // The summary message is the transcript row the engine flags as a compaction summary.
  const summary = run.transcript.filter(row => row.isCompactSummary).map(row => textOf((row.message as { content?: unknown } | undefined)?.content)).find(text => text !== '') ?? ''
  if (!summary) throw new Error('the installed claude wrote no compaction summary row')
  const transcriptPath = /read the full transcript at: (.+)/.exec(summary)?.[1]?.trim() ?? ''
  return deriveTemplate({ version: run.version, plain: prompts[0]!, custom: prompts[1]!, summaryMessage: summary, transcriptPath })
}

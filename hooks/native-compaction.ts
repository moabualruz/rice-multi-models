// Claude Code's own compaction text, learned from the installed claude and rendered here.
//
// The engine's summarizer cannot be routed to another provider, so a routed conversation is compacted by this
// mod. What it sends and what it keeps still comes from the engine: the helper runs the installed claude once
// per version in an isolated folder against a loopback stub (see helper/native-compaction.ts), records the
// summary prompt, the slot its `/compact` instructions take and the summary message it writes, and this module
// turns those captures into a template. Nothing here is a copy of the engine's text.
import type { ApiMessage } from './protocol'

export const TRANSCRIPT_TOKEN = '{{transcript}}'
/** Sent as the summary body and as the `/compact` instructions while capturing; never shown to a model in use. */
export const SUMMARY_MARK = 'RICECAPTURESUMMARYBODY'
export const INSTRUCTIONS_MARK = 'ZZRICECAPTUREINSTRUCTIONSZZ'

/** The summary prompt and summary message of one Claude Code version, with the slots filled in at use. */
export type CompactionTemplate = {
  version: string
  /** The prompt's text before and after the place the person's `/compact` instructions go. */
  promptHead: string
  promptTail: string
  /** What the engine writes around those instructions when there are some. */
  instructionsBefore: string
  instructionsAfter: string
  /** The summary message: its text before the summary body and after it (the transcript path is `TRANSCRIPT_TOKEN`). */
  summaryHead: string
  summaryTail: string
}

/** What the capture observed: the prompt with and without instructions, and the summary message with a known body. */
export type CompactionCapture = {
  version: string
  plain: string
  custom: string
  summaryMessage: string
  transcriptPath: string
}

const TEMPLATE_KEYS = ['version', 'promptHead', 'promptTail', 'instructionsBefore', 'instructionsAfter', 'summaryHead', 'summaryTail'] as const

export function isTemplate(value: unknown): value is CompactionTemplate {
  if (value === null || typeof value !== 'object') return false
  const fields = value as Record<string, unknown>
  return TEMPLATE_KEYS.every(key => typeof fields[key] === 'string') && (fields.promptHead as string).length > 0 && (fields.summaryHead as string).length > 0
}

/** The template a capture implies; throws when the capture does not have the shape the engine is expected to produce. */
export function deriveTemplate(capture: CompactionCapture): CompactionTemplate {
  const { plain, custom } = capture
  const added = custom.length - plain.length
  if (added <= 0) throw new Error('the prompt with instructions is not longer than the prompt without')
  let at = 0
  while (at < plain.length && plain[at] === custom[at]) at++
  // One insertion: the rest of the longer prompt is the rest of the shorter one, and the instructions are inside it.
  if (custom.slice(at + added) !== plain.slice(at)) throw new Error('the instructions are not one insertion into the summary prompt')
  const inserted = custom.slice(at, at + added)
  const mark = inserted.indexOf(INSTRUCTIONS_MARK)
  if (mark < 0) throw new Error('the instructions do not appear in the summary prompt')
  const body = capture.summaryMessage.indexOf(SUMMARY_MARK)
  if (body <= 0) throw new Error('the summary body does not appear in the summary message')
  const tail = capture.summaryMessage.slice(body + SUMMARY_MARK.length)
  return {
    version: capture.version,
    promptHead: plain.slice(0, at),
    promptTail: plain.slice(at),
    instructionsBefore: inserted.slice(0, mark),
    instructionsAfter: inserted.slice(mark + INSTRUCTIONS_MARK.length),
    summaryHead: capture.summaryMessage.slice(0, body),
    summaryTail: capture.transcriptPath ? tail.split(capture.transcriptPath).join(TRANSCRIPT_TOKEN) : tail,
  }
}

/** The summary prompt for the person's `/compact` instructions, if any, as the engine words it. */
export function compactionPrompt(template: CompactionTemplate, instructions?: string): string {
  const text = instructions?.trim()
  return template.promptHead + (text ? template.instructionsBefore + text + template.instructionsAfter : '') + template.promptTail
}

/** The summary the model wrote: the inside of its `<summary>` block, else its reply without the `<analysis>` block. */
export function summaryBody(reply: string): string | undefined {
  const closed = /<summary>([\s\S]*?)<\/summary>/i.exec(reply)
  const text = (closed ? closed[1]! : reply.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').replace(/<\/?summary>/gi, '')).trim()
  return text === '' ? undefined : text
}

/** The summary message of a compaction, as the engine writes it; without a transcript path the line that cites it is left out. */
export function summaryMessage(template: CompactionTemplate, body: string, transcriptPath?: string): string {
  const tail = transcriptPath
    ? template.summaryTail.split(TRANSCRIPT_TOKEN).join(transcriptPath)
    : template.summaryTail.split('\n').filter(line => !line.includes(TRANSCRIPT_TOKEN)).join('\n')
  return template.summaryHead + body + tail
}

type Block = { type: string } & Record<string, unknown>

const blocksOf = (message: ApiMessage): readonly Block[] => typeof message.content === 'string' ? [] : message.content
const sizeOf = (messages: readonly ApiMessage[]) => JSON.stringify(messages).length
const linkedIds = (messages: readonly ApiMessage[], type: 'tool_use' | 'tool_result'): Set<string> => new Set(
  messages.flatMap(message => blocksOf(message).filter(block => block.type === type)
    .map(block => type === 'tool_use' ? block.id : block.tool_use_id)
    .filter((id): id is string => typeof id === 'string')),
)

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil(max * 0.7), tail = Math.floor(max * 0.3)
  return `${text.slice(0, head)}\n[... ${text.length - head - tail} characters omitted ...]\n${text.slice(text.length - tail)}`
}

function clipBlock(block: Block, max: number): Block {
  if (block.type !== 'tool_result') return block
  const content = block.content
  if (typeof content === 'string') return { ...block, content: clip(content, max) }
  if (Array.isArray(content)) return { ...block, content: content.map(inner => inner && typeof inner === 'object' && typeof (inner as Block).text === 'string' ? { ...inner, text: clip((inner as Block).text as string, max) } : inner) }
  return block
}

function exchangeToRemove(messages: readonly ApiMessage[], seed: number): Set<number> {
  const removed = new Set([seed])
  let changed = true
  while (changed) {
    changed = false
    const removedMessages = messages.filter((_, index) => removed.has(index))
    const uses = linkedIds(removedMessages, 'tool_use')
    const results = linkedIds(removedMessages, 'tool_result')
    messages.forEach((message, index) => {
      if (removed.has(index)) return
      const linked = blocksOf(message).some(block => block.type === 'tool_result'
        ? typeof block.tool_use_id === 'string' && uses.has(block.tool_use_id)
        : block.type === 'tool_use' && typeof block.id === 'string' && results.has(block.id))
      if (linked) { removed.add(index); changed = true }
    })
  }
  return removed
}

/**
 * Fit a request-only transcript copy. Tool results are visibly clipped before older messages are excluded.
 * Opaque message fields, including engine handles, are copied without editing. Excluded history is described
 * in `explanation`; callers must retain the original transcript for the compaction result.
 */
export function fitTranscript(messages: readonly ApiMessage[], maxChars: number): { messages: ApiMessage[]; omitted: number; excluded: number[]; clipped: number; fits: boolean; explanation: string } {
  const clippedBlocks = new Set<string>()
  let fitted = messages.map((message, messageIndex) => typeof message.content === 'string' ? message : {
    ...message,
    content: message.content.map((block, blockIndex) => {
      const next = clipBlock(block, 20_000)
      if (block.type === 'tool_result' && JSON.stringify(next) !== JSON.stringify(block)) clippedBlocks.add(`${messageIndex}:${blockIndex}`)
      return next
    }),
  })
  for (const max of [6_000, 1_500]) {
    if (sizeOf(fitted) <= maxChars) break
    fitted = fitted.map((message, messageIndex) => typeof message.content === 'string' ? message : {
      ...message,
      content: message.content.map((block, blockIndex) => {
        const next = clipBlock(block, max)
        if (block.type === 'tool_result' && JSON.stringify(next) !== JSON.stringify(block)) clippedBlocks.add(`${messageIndex}:${blockIndex}`)
        return next
      }),
    })
  }
  let sourceIndexes = messages.map((_, index) => index)
  const excluded: number[] = []
  while (sizeOf(fitted) > maxChars && fitted.length > 2) {
    let removed: Set<number> | undefined
    for (let seed = 1; seed < fitted.length - 1; seed++) {
      const candidate = exchangeToRemove(fitted, seed)
      if (!candidate.has(0) && !candidate.has(fitted.length - 1)) { removed = candidate; break }
    }
    if (!removed) break
    removed.forEach(index => excluded.push(sourceIndexes[index]!))
    fitted = fitted.filter((_, index) => !removed!.has(index))
    sourceIndexes = sourceIndexes.filter((_, index) => !removed!.has(index))
  }
  excluded.sort((left, right) => left - right)
  const omitted = excluded.length
  const calls = linkedIds(fitted, 'tool_use')
  const orphanResults = [...linkedIds(fitted, 'tool_result')].filter(id => !calls.has(id)).length
  const fits = sizeOf(fitted) <= maxChars && orphanResults === 0
  const clipped = clippedBlocks.size
  const details = [
    omitted ? `${omitted} messages excluded from this request copy (source indexes ${excluded.join(', ')})` : '',
    clipped ? `${clipped} tool-result blocks clipped with explicit omission markers` : '',
    orphanResults ? `${orphanResults} unpaired tool-result blocks make this request copy unsafe` : '',
  ].filter(Boolean)
  return { messages: fitted, omitted, excluded, clipped, fits, explanation: details.length ? details.join('; ') : 'no transcript content excluded' }
}

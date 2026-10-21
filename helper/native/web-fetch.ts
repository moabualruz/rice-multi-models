export const WEB_FETCH_BASIC = 'web_fetch_20250910' as const
export const WEB_FETCH_DYNAMIC = 'web_fetch_20260318' as const

export type WebFetchToolType = typeof WEB_FETCH_BASIC | typeof WEB_FETCH_DYNAMIC
export type WebFetchContent = { kind: 'error' } | { kind: 'document'; url: string; text: string }

/** Parse only the current server-tool result shape and retain its actual source URL. */
export function parseWebFetchContent(value: unknown): WebFetchContent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const content = value as Record<string, unknown>
  if (content.type === 'web_fetch_tool_result_error') return { kind: 'error' }
  if (content.type !== 'web_fetch_result' || typeof content.url !== 'string' || content.content === null || typeof content.content !== 'object' || Array.isArray(content.content)) return undefined
  let sourceUrl: URL
  try { sourceUrl = new URL(content.url) } catch { return undefined }
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password) return undefined
  const document = content.content as Record<string, unknown>
  if (document.type !== 'document' || document.source === null || typeof document.source !== 'object' || Array.isArray(document.source)) return undefined
  const source = document.source as Record<string, unknown>
  if (source.type !== 'text' || typeof source.data !== 'string') return undefined
  return { kind: 'document', url: sourceUrl.toString(), text: source.data }
}

/** Dynamic filtering is documented for Claude 4.6+, Claude 5, and Mythos Preview. */
export function webFetchToolType(modelId: string): WebFetchToolType {
  if (/(?:^|-)mythos-preview(?:-|$)/i.test(modelId)
    || /^(?:claude-)?(?:opus|sonnet|haiku|fable)-5(?:-\d+)?(?:-|$)/i.test(modelId)
    || /^(?:claude-)?(?:opus|sonnet|haiku|fable)-4-(?:[6-9]|\d{2,})(?:-|$)/i.test(modelId)) return WEB_FETCH_DYNAMIC
  return WEB_FETCH_BASIC
}

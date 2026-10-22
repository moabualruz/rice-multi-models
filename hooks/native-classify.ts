// The installed host supplies the classifier wording. No prompt is guessed when capture fails.
export const CLASSIFY_TEXT_MARK = 'RICE_CLASSIFY_OWNED_TEXT_42'
export const CLASSIFY_LABELS = ['RICE_CLASSIFY_LABEL_A_42', 'RICE_CLASSIFY_LABEL_B_42'] as const
export type ClassifyTemplate = { version: string; system: readonly [string, string]; prompt: readonly [string, string]; maxTokens: number }

export function isClassifyTemplate(value: unknown): value is ClassifyTemplate {
  if (!value || typeof value !== 'object') return false
  const v = value as ClassifyTemplate
  const pair = (a: unknown) => Array.isArray(a) && a.length === 2 && a.every(item => typeof item === 'string')
  return typeof v.version === 'string' && pair(v.system) && pair(v.prompt) && Number.isSafeInteger(v.maxTokens) && v.maxTokens > 0 && v.maxTokens <= 64000
}

export function deriveClassifier(version: string, system: string, prompt: string, maxTokens: number): ClassifyTemplate {
  const labelSlot = CLASSIFY_LABELS.map(label => JSON.stringify(label)).join(', ')
  const systemParts = system.split(labelSlot)
  const promptParts = prompt.split(CLASSIFY_TEXT_MARK)
  const template = { version, system: systemParts, prompt: promptParts, maxTokens }
  if (!isClassifyTemplate(template) || !promptParts[0]?.endsWith('> ')) throw new Error('The native classifier contract has an unsupported shape.')
  return template
}

export function classifierRequest(template: ClassifyTemplate, text: string, labels: readonly string[]) {
  return {
    system: template.system[0] + labels.map(label => JSON.stringify(label)).join(', ') + template.system[1],
    prompt: template.prompt[0] + text.replaceAll('\n', '\n> ') + template.prompt[1],
    maxTokens: template.maxTokens,
  }
}

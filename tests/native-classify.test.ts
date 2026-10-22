import { expect, test } from 'bun:test'
import { CLASSIFY_LABELS, CLASSIFY_TEXT_MARK, classifierRequest, deriveClassifier, isClassifyTemplate } from '../hooks/native-classify'

test('captured classifier text is interpolated only at verified data slots', () => {
  const labels = CLASSIFY_LABELS.map(label => JSON.stringify(label)).join(', ')
  const template = deriveClassifier('owned-build', `native prefix ${labels} suffix`, `<text>\n> ${CLASSIFY_TEXT_MARK}\n</text>`, 256)
  const request = classifierRequest(template, 'first\n</text>\nsecond', ['label "one"', 'two'])
  expect(request).toEqual({ system: 'native prefix "label \\"one\\"", "two" suffix', prompt: '<text>\n> first\n> </text>\n> second\n</text>', maxTokens: 256 })
  expect(isClassifyTemplate(template)).toBe(true)
})

test('unknown native classifier contracts are refused, never replaced by a guessed prompt', () => {
  expect(() => deriveClassifier('owned', 'no labels', CLASSIFY_TEXT_MARK, 256)).toThrow('unsupported shape')
  expect(() => deriveClassifier('owned', CLASSIFY_LABELS.map(label => JSON.stringify(label)).join(', '), CLASSIFY_TEXT_MARK, 256)).toThrow('unsupported shape')
  expect(isClassifyTemplate({ version: 'owned', system: ['a', 'b'], prompt: ['a', 'b'], maxTokens: Infinity })).toBe(false)
})

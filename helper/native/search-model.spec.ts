import { expect, test } from 'bun:test'
import { assertNativeSearchModel, assertNativeSearchResolverSource, nativeSearchModelBinding, NativeSearchModelError } from './search-model.ts'

test('native search selects only the three qualified 299 platform bindings', () => {
  const expected = [
    ['darwin', 'arm64', '/$bunfs/root/chunk-fk9f23h5.js', '_E'],
    ['linux', 'x64', '/$bunfs/root/chunk-xywp7esx.js', 'yv'],
    ['win32', 'x64', 'B:/~BUN/root/chunk-v7m9g1fp.js', 'Sv'],
  ]
  for (const [platform, architecture, module, name] of expected) {
    const binding = nativeSearchModelBinding('2.1.299', platform, architecture)
    expect(binding.module).toBe(module)
    expect(binding.name).toBe(name)
    expect(() => assertNativeSearchResolverSource(binding, binding.source)).not.toThrow()
    expect(() => assertNativeSearchResolverSource(binding, binding.source + ' ')).toThrow(NativeSearchModelError)
  }
  for (const version of [undefined, '', '2.1.296', '2.1.300']) expect(() => nativeSearchModelBinding(version, 'darwin', 'arm64')).toThrow('unsupported-version')
  for (const [platform, architecture] of [['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'arm64'], ['other', 'x64']]) {
    expect(() => nativeSearchModelBinding('2.1.299', platform, architecture)).toThrow('unsupported-platform')
  }
})

test('resolver implementations cannot be exchanged between supported builds', () => {
  const darwin = nativeSearchModelBinding('2.1.299', 'darwin', 'arm64')
  const linux = nativeSearchModelBinding('2.1.299', 'linux', 'x64')
  expect(() => assertNativeSearchResolverSource(darwin, linux.source)).toThrow('changed-resolver')
})

test('native search validates the returned model without pinning a remembered model', () => {
  for (const value of ['claude-owned-fixture', 'claude-other-123']) expect(() => assertNativeSearchModel(value)).not.toThrow()
  for (const value of [undefined, null, {}, 42, '', 'haiku', 'codex/gpt-fixture', 'provider/claude-owned', 'claude-owned\n', 'claude-owned?key=value', 'claude-' + 'a'.repeat(256)]) {
    expect(() => assertNativeSearchModel(value)).toThrow('invalid-model')
  }
  const error = new NativeSearchModelError('invalid-model')
  expect(error.code).toBe('RICE_NATIVE_SEARCH_MODEL')
  expect(error.message).not.toContain('key=value')
})

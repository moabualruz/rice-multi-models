type NativeSearchPlatform = 'darwin-arm64' | 'linux-x64' | 'win32-x64'
type Binding = Readonly<{ module: string; name: string; source: string }>
type Failure = 'unsupported-version' | 'unsupported-platform' | 'unavailable-resolver' | 'changed-resolver' | 'invalid-model'

export class NativeSearchModelError extends Error {
  readonly code = 'RICE_NATIVE_SEARCH_MODEL'
  constructor(readonly reason: Failure) {
    super(`Native Claude search model is unavailable (${reason}). Run /rice-models setup native with a qualified Claude 2.1.299 executable.`)
    this.name = 'NativeSearchModelError'
  }
}

// Qualified native Haiku-family defaults honor DEFAULT_HAIKU_MODEL without
// following the selected external model or SMALL_FAST_MODEL. Function sources
// were verified through native Bun imports on each official 2.1.299 build; the
// returned model is deliberately absent from this table.
const BINDINGS: Readonly<Record<NativeSearchPlatform, Binding>> = {
  'darwin-arm64': {
    module: '/$bunfs/root/chunk-fk9f23h5.js', name: 'oG',
    source: String.raw`function oG(){let e=a.ANTHROPIC_DEFAULT_HAIKU_MODEL;if(e!==void 0)return yC(e);return Ua("haiku")??kc()}`,
  },
  'linux-x64': {
    module: '/$bunfs/root/chunk-xywp7esx.js', name: 'Kz',
    source: String.raw`function Kz(){let e=a.ANTHROPIC_DEFAULT_HAIKU_MODEL;if(e!==void 0)return mC(e);return La("haiku")??wc()}`,
  },
  'win32-x64': {
    module: 'B:/~BUN/root/chunk-v7m9g1fp.js', name: 'Yz',
    source: String.raw`function Yz(){let e=a.ANTHROPIC_DEFAULT_HAIKU_MODEL;if(e!==void 0)return gR(e);return La("haiku")??kc()}`,
  },
}

export function nativeSearchModelBinding(version: string | undefined, platform: string, architecture: string): Binding {
  if (version !== '2.1.299') throw new NativeSearchModelError('unsupported-version')
  const key = `${platform}-${architecture}`
  if (!Object.hasOwn(BINDINGS, key)) throw new NativeSearchModelError('unsupported-platform')
  return BINDINGS[key as NativeSearchPlatform]
}

export function assertNativeSearchResolverSource(binding: Binding, source: string): void {
  if (source !== binding.source) throw new NativeSearchModelError('changed-resolver')
}

export function assertNativeSearchModel(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 256 || !/^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new NativeSearchModelError('invalid-model')
  }
}

/** Resolve the native family default inside the qualified host, then reject external overrides. */
export async function resolveNativeSearchModel(): Promise<string> {
  const binding = nativeSearchModelBinding(process.env.RICE_MULTI_MODELS_NATIVE_VERSION, process.platform, process.arch)
  let candidate: unknown
  try { candidate = (await import(binding.module) as Record<string, unknown>)[binding.name] }
  catch { throw new NativeSearchModelError('unavailable-resolver') }
  if (typeof candidate !== 'function') throw new NativeSearchModelError('unavailable-resolver')
  assertNativeSearchResolverSource(binding, Function.prototype.toString.call(candidate))
  let model: unknown
  try { model = candidate() }
  catch { throw new NativeSearchModelError('unavailable-resolver') }
  assertNativeSearchModel(model)
  return model
}

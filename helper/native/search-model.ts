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

// Exact function sources were qualified by native Bun imports on each official
// 2.1.299 build. The returned model is deliberately absent from this table.
const BINDINGS: Readonly<Record<NativeSearchPlatform, Binding>> = {
  'darwin-arm64': {
    module: '/$bunfs/root/chunk-fk9f23h5.js', name: '_E',
    source: String.raw`function _E(){let e=a.ANTHROPIC_SMALL_FAST_MODEL;if(e!==void 0)return Dv(yC(e));if(!fpt()){let n=Oe();if((n==="bedrock"||n==="vertex")&&Vh()==null&&!h1e()){let r=Da();if(!r.opus||r.sonnet){let s=vm();if((bC(s)??Xr(s))&&!nG(s,rG()))return s}}return Qe()}return a.ANTHROPIC_DEFAULT_HAIKU_MODEL!==void 0?Dv(oG()):$v(oG())}`,
  },
  'linux-x64': {
    module: '/$bunfs/root/chunk-xywp7esx.js', name: 'yv',
    source: String.raw`function yv(){let e=a.ANTHROPIC_SMALL_FAST_MODEL;if(e!==void 0)return Ov(mC(e));if(!spt()){let n=Oe();if((n==="bedrock"||n==="vertex")&&zh()==null&&!aBe()){let r=Da();if(!r.opus||r.sonnet){let s=Em();if((yC(s)??Xr(s))&&!Gz(s,Vz()))return s}}return Qe()}return a.ANTHROPIC_DEFAULT_HAIKU_MODEL!==void 0?Ov(Kz()):Fv(Kz())}`,
  },
  'win32-x64': {
    module: 'B:/~BUN/root/chunk-v7m9g1fp.js', name: 'Sv',
    source: String.raw`function Sv(){let e=a.ANTHROPIC_SMALL_FAST_MODEL;if(e!==void 0)return Ev(gR(e));if(!apt()){let n=Ie();if((n==="bedrock"||n==="vertex")&&jh()==null&&!aBe()){let r=Da();if(!r.opus||r.sonnet){let s=km();if((_R(s)??Xr(s))&&!qz(s,Kz()))return s}}return Ze()}return a.ANTHROPIC_DEFAULT_HAIKU_MODEL!==void 0?Ev(Yz()):Iv(Yz())}`,
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

/** Resolve only inside the qualified native host, before the fallback request. */
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

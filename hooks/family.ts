// Same-family defaults. A conversation on a routed model keeps its subagents,
// skill aliases and auxiliary work on that model's provider unless the caller
// explicitly chooses another family. Native Claude aliases are tier requests.

export const NATIVE_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type NativeAlias = typeof NATIVE_ALIASES[number]
export type Tier = NativeAlias | 'default'
/** Optional per-family tier models from rice-multi-models.json `tiers`. */
export type TierMap = Readonly<Record<string, Partial<Record<Tier, string>>>>
export const CLAUDE_FAMILY = 'claude'

export type FamilyPorts = {
  isRouted: (model: string) => boolean
  /** The provider id a routed model belongs to (`codex`, a declared provider id). */
  providerOf: (model: string) => string | undefined
  /** A family's default model when no conversation of it is the parent. */
  defaultModel: (family: string) => string | undefined
}

export function isNativeAlias(model: string | undefined): model is NativeAlias {
  return model !== undefined && (NATIVE_ALIASES as readonly string[]).includes(model)
}

/** The tier a native alias or a full Claude id names (`claude-haiku-4-5` is haiku). */
export function tierOf(model: string | undefined): NativeAlias | undefined {
  if (model === undefined) return undefined
  if (isNativeAlias(model)) return model
  const lower = model.toLowerCase()
  return lower.includes('/') ? undefined : NATIVE_ALIASES.find(alias => lower.includes(alias))
}

export function familyOf(model: string | undefined, ports: Pick<FamilyPorts, 'isRouted' | 'providerOf'>): string {
  return model !== undefined && ports.isRouted(model) ? ports.providerOf(model) ?? CLAUDE_FAMILY : CLAUDE_FAMILY
}

/** The routed model a tier request resolves to inside one family. */
export function tierModel(family: string, tier: string | undefined, anchor: string | undefined, tiers: TierMap, ports: FamilyPorts): string | undefined {
  const configured = tiers[family]
  const named = tierOf(tier)
  const chosen = (named ? configured?.[named] : undefined) ?? configured?.default
  if (chosen !== undefined && ports.isRouted(chosen) && familyOf(chosen, ports) === family) return chosen
  if (anchor !== undefined && ports.isRouted(anchor) && familyOf(anchor, ports) === family) return anchor
  const fallback = ports.defaultModel(family)
  return fallback !== undefined && ports.isRouted(fallback) ? fallback : undefined
}

export type SpawnInput = {
  /** The parent's effective model (agent.spawn `parentModel`). */
  parentModel: string
  /** The Agent tool's `model` argument, or a hook's rewrite. */
  requested?: string
  /** The resolved agent type. */
  subagentType: string
  /** The definition's own `model`, when a readable definition names one. */
  definitionModel?: string
  fork: boolean
  /** Family agent types this mod registered, by full type name. */
  familyTypes: ReadonlyMap<string, string>
}
export type SpawnDecision = { model?: string; family: string; explicit: boolean; reason: string }

/** What a spawn runs on. Undefined `model` leaves the native resolution alone. */
export function spawnDecision(input: SpawnInput, tiers: TierMap, ports: FamilyPorts): SpawnDecision {
  const parentFamily = familyOf(input.parentModel, ports)
  if (input.fork) return { family: parentFamily, explicit: false, reason: 'forks inherit their parent model' }
  const chosenFamily = input.familyTypes.get(input.subagentType)
  if (chosenFamily !== undefined) {
    if (chosenFamily === CLAUDE_FAMILY) return { family: CLAUDE_FAMILY, explicit: true, reason: 'the caller chose the Claude family agent type' }
    const model = tierModel(chosenFamily, input.requested, chosenFamily === parentFamily ? input.parentModel : undefined, tiers, ports)
    return model === undefined
      ? { family: chosenFamily, explicit: true, reason: `no ${chosenFamily} model is available` }
      : { model, family: chosenFamily, explicit: true, reason: `the caller chose the ${chosenFamily} family agent type` }
  }
  if (input.requested !== undefined && ports.isRouted(input.requested)) return { model: input.requested, family: familyOf(input.requested, ports), explicit: true, reason: 'an explicit routed model was requested' }
  if (input.definitionModel !== undefined && ports.isRouted(input.definitionModel)) return { family: familyOf(input.definitionModel, ports), explicit: true, reason: 'the agent definition names a routed model' }
  if (parentFamily === CLAUDE_FAMILY) return { family: CLAUDE_FAMILY, explicit: false, reason: 'the parent runs on Claude' }
  const tier = input.requested ?? input.definitionModel
  const model = tierModel(parentFamily, tier === 'inherit' ? undefined : tier, input.parentModel, tiers, ports)
  return model === undefined
    ? { family: parentFamily, explicit: false, reason: `no ${parentFamily} model is available` }
    : { model, family: parentFamily, explicit: false, reason: `subagents default to the parent's ${parentFamily} family` }
}

/**
 * A loop's step model. A native alias inside a routed family (a skill's
 * `model: haiku`, an unspawned fork) resolves within the owner's family unless
 * the loop was explicitly placed on Claude.
 */
export function stepModel(requested: string, owner: string | undefined, explicitClaude: boolean, tiers: TierMap, ports: FamilyPorts): string {
  if (explicitClaude || ports.isRouted(requested) || owner === undefined || !ports.isRouted(owner)) return requested
  const family = familyOf(owner, ports)
  return tierModel(family, requested, owner, tiers, ports) ?? owner
}

/** Parses the optional top-level `tiers` block of rice-multi-models.json. */
export function parseTiers(value: unknown): { tiers: TierMap; errors: string[] } {
  if (value === undefined) return { tiers: {}, errors: [] }
  const errors: string[] = []
  const tiers: Record<string, Partial<Record<Tier, string>>> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { tiers, errors: ['tiers must be an object of family id to { default, haiku, sonnet, opus, fable } model ids'] }
  for (const [family, map] of Object.entries(value)) {
    if (map === null || typeof map !== 'object' || Array.isArray(map)) { errors.push(`tiers.${family} must be an object`); continue }
    const entry: Partial<Record<Tier, string>> = {}
    for (const [tier, model] of Object.entries(map as Record<string, unknown>)) {
      if (tier !== 'default' && !isNativeAlias(tier)) { errors.push(`tiers.${family}.${tier} is not one of default, ${NATIVE_ALIASES.join(', ')}`); continue }
      if (typeof model !== 'string' || !model.includes('/')) { errors.push(`tiers.${family}.${tier} must be a routed model id such as ${family}/<model>`); continue }
      entry[tier as Tier] = model
    }
    tiers[family] = entry
  }
  return { tiers, errors }
}

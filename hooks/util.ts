// JSON helpers the copied claude-styx modules read; from Trosfy/claude-styx hooks/config.ts at 5072384
// (MIT, Copyright (c) 2026 styx contributors; see LICENSES/claude-styx.MIT.txt). Modified by Mo Abualruz: only these.
export type Json = { [key: string]: unknown }
export type JsonSchema = Readonly<Record<string, unknown>>

export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Sets a key and drops the oldest entries past `max`, so per-agent state cannot grow for the life of a long session. */
export function setCapped<K, V>(map: Map<K, V>, key: K, value: V, max = 1000): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
// A map's own entry: a name such as `toString` or `constructor` is never read from the prototype.
export const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined)

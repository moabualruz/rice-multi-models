import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type CheckedAddress = { address: string; family: 4 | 6 }
export type AddressResolver = (hostname: string) => Promise<CheckedAddress[]>

export class DestinationSafetyError extends Error {
  constructor(message: string) { super(message); this.name = 'DestinationSafetyError' }
}

const ipv4Number = (value: string): number => value.split('.').reduce((number, part) => ((number << 8) | Number(part)) >>> 0, 0)
const ipv4Blocked = (value: string): boolean => {
  const ip = ipv4Number(value)
  const inRange = (base: string, bits: number) => (ip >>> (32 - bits)) === (ipv4Number(base) >>> (32 - bits))
  return inRange('0.0.0.0', 8) || inRange('10.0.0.0', 8) || inRange('100.64.0.0', 10) || inRange('127.0.0.0', 8)
    || inRange('169.254.0.0', 16) || inRange('172.16.0.0', 12) || inRange('192.0.0.0', 24) || inRange('192.0.2.0', 24)
    || inRange('192.88.99.0', 24) || inRange('192.168.0.0', 16) || inRange('198.18.0.0', 15) || inRange('198.51.100.0', 24)
    || inRange('203.0.113.0', 24) || inRange('224.0.0.0', 4) || inRange('240.0.0.0', 4)
}

function ipv6Number(value: string): bigint | undefined {
  let source = value.toLowerCase()
  if (source.includes('.')) {
    const split = source.lastIndexOf(':')
    const ipv4 = source.slice(split + 1)
    if (isIP(ipv4) !== 4) return undefined
    const n = ipv4Number(ipv4)
    source = `${source.slice(0, split)}:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = source.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || halves.length === 1 && missing !== 0) return undefined
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (words.length !== 8 || words.some(word => !/^[\da-f]{1,4}$/.test(word))) return undefined
  return words.reduce((number, word) => (number << 16n) | BigInt(`0x${word}`), 0n)
}

export function publicAddress(value: string): boolean {
  const family = isIP(value)
  if (family === 4) return !ipv4Blocked(value)
  if (family !== 6) return false
  const ip = ipv6Number(value)
  if (ip === undefined) return false
  const mapped = ip >> 32n === 0xffffn
  if (mapped) return false
  const inRange = (base: bigint, bits: number) => (ip >> BigInt(128 - bits)) === (base >> BigInt(128 - bits))
  // Only global unicast is eligible; exclude IETF special-purpose, documentation and 6to4 blocks.
  return inRange(0x20000000000000000000000000000000n, 3)
    && !inRange(0x20010000000000000000000000000000n, 23)
    && !inRange(0x20010db8000000000000000000000000n, 32)
    && !inRange(0x20020000000000000000000000000000n, 16)
    && !inRange(0x3fff0000000000000000000000000000n, 20)
}

export function localName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '')
  return ['localhost', 'local', 'internal', 'home', 'lan', 'test', 'invalid', 'example'].some(suffix => name === suffix || name.endsWith(`.${suffix}`))
}

export const resolveAddresses: AddressResolver = async hostname => (await dnsLookup(hostname, { all: true, verbatim: true })).map(row => ({ address: row.address, family: row.family as 4 | 6 }))

export async function resolveAndCheck(url: URL, signal: AbortSignal, resolver: AddressResolver = resolveAddresses): Promise<CheckedAddress> {
  signal.throwIfAborted()
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (localName(hostname)) throw new DestinationSafetyError('WebFetch refuses localhost-style destinations.')
  let records: CheckedAddress[]
  try { records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }] : await resolver(hostname) }
  catch { signal.throwIfAborted(); throw new DestinationSafetyError('WebFetch could not verify the destination address.') }
  signal.throwIfAborted()
  if (!records.length || records.some(record => !record || ![4, 6].includes(record.family) || isIP(record.address) !== record.family || !publicAddress(record.address))) throw new DestinationSafetyError('WebFetch refuses non-public or unresolved destinations.')
  return records[0]!
}

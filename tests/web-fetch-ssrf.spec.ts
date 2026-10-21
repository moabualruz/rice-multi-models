import { expect, test } from 'bun:test'
import type { StepEvent, StepWire } from '../hooks/protocol'
import { createDirectWebFetch } from '../helper/web-fetch'
import type { CheckedAddress } from '../helper/native/destination'

const publicAddress: CheckedAddress = { address: '93.184.216.34', family: 4 }
const privateAddress: CheckedAddress = { address: '10.1.2.3', family: 4 }
const wire: StepWire = { configText: '{}', approved: [], req: { target: 'selected/owned', system: '', tools: [], transcript: [], who: 'main', session: 'ssrf-test' } }
const unsafeIPv4 = [
  ['private', '10.1.2.3', ['10.1.2.3', '167838211', '012.001.002.003', '0x0a010203']],
  ['loopback', '127.0.0.1', ['127.0.0.1', '2130706433', '0177.0.0.1', '0x7f000001']],
  ['link-local', '169.254.10.20', ['169.254.10.20', '2851998228', '0251.0376.0012.0024', '0xa9fe0a14']],
  ['unspecified', '0.0.0.0', ['0.0.0.0', '0', '00', '0x0']],
  ['multicast', '224.0.0.1', ['224.0.0.1', '3758096385', '0340.0.0.1', '0xe0000001']],
] as const

function ports(overrides: Partial<Parameters<typeof createDirectWebFetch>[0]> = {}) {
  return {
    resolve: async (_hostname: string) => [publicAddress],
    request: async (_url: URL, _init: RequestInit, _destination: CheckedAddress) => new Response('<p>SAFE_PAGE_CONTENT</p>', { status: 200, headers: { 'content-type': 'text/html' } }),
    step: async function* (_wire: StepWire, _signal: AbortSignal): AsyncGenerator<StepEvent> {
      yield { type: 'text', text: 'SAFE_SELECTED_EXTRACTION' }
      yield { type: 'stop', reason: 'end_turn' }
    },
    ...overrides,
  }
}

async function expectUnsafe(url: string, resolve = async (_hostname: string) => [publicAddress]) {
  let requests = 0
  const run = createDirectWebFetch(ports({
    resolve,
    request: async () => { requests++; return new Response('unexpected') },
  }))
  await expect(run({ wire, url, prompt: 'Read the page.' }, new AbortController().signal)).rejects.toMatchObject({ phase: 'security' })
  expect(requests).toBe(0)
}

for (const [range, canonical, forms] of unsafeIPv4) {
  for (const form of forms) {
    test(`direct WebFetch rejects ${range} IPv4 URL form ${form}`, async () => {
      expect(new URL(`https://${form}/`).hostname).toBe(canonical)
      await expectUnsafe(`https://${form}/`)
    })
  }
}

for (const [label, address] of [
  ['loopback', '[::1]'],
  ['unique-local', '[fc00::1]'],
  ['link-local', '[fe80::1]'],
  ['IPv4-mapped', '[::ffff:127.0.0.1]'],
] as const) {
  test(`direct WebFetch rejects IPv6 ${label}`, async () => {
    await expectUnsafe(`https://${address}/`)
  })
}

for (const hostname of ['localhost', 'LOCALHOST.', 'api.localhost', 'router.local', 'service.internal', 'laptop.home', 'printer.lan', 'host.test', 'host.invalid', 'host.example']) {
  test(`direct WebFetch rejects localhost-style name ${hostname}`, async () => {
    let resolutions = 0
    await expectUnsafe(`https://${hostname}/`, async () => { resolutions++; return [publicAddress] })
    expect(resolutions).toBe(0)
  })
}

test('direct WebFetch rejects private DNS answers, including mixed public and private records', async () => {
  let resolutions = 0
  await expectUnsafe('https://public-owned.example.net/page', async () => {
    resolutions++
    return [publicAddress, privateAddress]
  })
  expect(resolutions).toBe(1)
})

test('direct WebFetch checks a public DNS answer once and passes the pinned address to its request port', async () => {
  let resolutions = 0
  const destinations: CheckedAddress[] = []
  const run = createDirectWebFetch(ports({
    resolve: async () => {
      resolutions++
      return [resolutions === 1 ? publicAddress : privateAddress]
    },
    request: async (_url, _init, destination) => {
      destinations.push(destination)
      return new Response('PUBLIC_PINNED_PAGE', { headers: { 'content-type': 'text/plain' } })
    },
  }))
  const result = await run({ wire, url: 'https://public-owned.example.net/page', prompt: 'Extract the page.' }, new AbortController().signal)
  expect(result).toMatchObject({ url: 'https://public-owned.example.net/page', result: 'SAFE_SELECTED_EXTRACTION', code: 200 })
  expect(resolutions).toBe(1)
  expect(destinations).toEqual([publicAddress])
})

test('direct WebFetch rechecks and rejects a redirect to a private DNS answer before requesting it', async () => {
  let resolutions = 0, requests = 0
  const run = createDirectWebFetch(ports({
    resolve: async () => ++resolutions === 1 ? [publicAddress] : [privateAddress],
    request: async () => {
      requests++
      return new Response(null, { status: 302, headers: { location: 'https://private-owned.example.net/secret' } })
    },
  }))
  await expect(run({ wire, url: 'https://public-owned.example.net/start', prompt: 'Read the page.' }, new AbortController().signal)).rejects.toMatchObject({ phase: 'security' })
  expect(resolutions).toBe(2)
  expect(requests).toBe(1)
})

test('direct WebFetch stops after the bounded redirect hop cap', async () => {
  let resolutions = 0, requests = 0
  const run = createDirectWebFetch(ports({
    resolve: async () => { resolutions++; return [publicAddress] },
    request: async () => {
      requests++
      return new Response(null, { status: 302, headers: { location: `/hop-${requests}` } })
    },
  }))
  await expect(run({ wire, url: 'https://public-owned.example.net/start', prompt: 'Read the page.' }, new AbortController().signal)).rejects.toThrow('exceeded 10 redirects')
  expect(requests).toBe(11)
  expect(resolutions).toBe(12)
})

test('direct WebFetch fails closed when destination resolution fails', async () => {
  let requests = 0
  const run = createDirectWebFetch(ports({
    resolve: async () => { throw new Error('resolver unavailable') },
    request: async () => { requests++; return new Response('unexpected') },
  }))
  await expect(run({ wire, url: 'https://public-owned.example.net/page', prompt: 'Read the page.' }, new AbortController().signal)).rejects.toMatchObject({ phase: 'security' })
  expect(requests).toBe(0)
})

test('direct WebFetch returns a successful public result with source and selected extraction', async () => {
  const run = createDirectWebFetch(ports())
  const result = await run({ wire, url: 'https://93.184.216.34/page', prompt: 'Extract the page.' }, new AbortController().signal)
  expect(result).toMatchObject({ url: 'https://93.184.216.34/page', result: 'SAFE_SELECTED_EXTRACTION', code: 200, bytes: 24 })
})

test('direct WebFetch cancellation stops before destination lookup and retrieval', async () => {
  const controller = new AbortController(), reason = new Error('cancelled')
  controller.abort(reason)
  let resolutions = 0, requests = 0
  const run = createDirectWebFetch(ports({
    resolve: async () => { resolutions++; return [publicAddress] },
    request: async () => { requests++; return new Response('unexpected') },
  }))
  await expect(run({ wire, url: 'https://93.184.216.34/page', prompt: 'Read the page.' }, controller.signal)).rejects.toBe(reason)
  expect(resolutions).toBe(0)
  expect(requests).toBe(0)
})

test('direct WebFetch cancellation during retrieval does not start extraction', async () => {
  const controller = new AbortController(), reason = new Error('cancelled')
  let requests = 0, extractions = 0
  const run = createDirectWebFetch(ports({
    request: async (_url, _init, _destination) => {
      requests++
      controller.abort(reason)
      throw reason
    },
    step: async function* () { extractions++; yield { type: 'text', text: 'must-not-leak' } },
  }))
  await expect(run({ wire, url: 'https://93.184.216.34/page', prompt: 'Read the page.' }, controller.signal)).rejects.toBe(reason)
  expect(requests).toBe(1)
  expect(extractions).toBe(0)
})

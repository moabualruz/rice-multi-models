import { expect, test } from 'bun:test'
import type { FetchEndpoint } from '../hooks/fetch-config.ts'
import { configuredFetch, fetchFromService, FetchServiceUnavailable } from './fetch-services.ts'

const pageUrl = 'https://docs.example/public'
const endpoint = (name: string, auth?: FetchEndpoint['auth']): FetchEndpoint => ({ name, url: `https://fetch.example/${name}`, priority: 0, ...(auth ? { auth } : {}) })
const response = (url = pageUrl, content = 'Public page text.') => new Response(JSON.stringify({ url, content, contentType: 'text/plain' }), { headers: { 'content-type': 'application/json' } })
const signal = () => new AbortController().signal

test('configured endpoints are tried in priority order and only the selected endpoint credential is sent', async () => {
  const firstKey = ['fixture', 'credential', 'first'].join('-'), secondKey = ['fixture', 'credential', 'second'].join('-')
  const endpoints = [endpoint('first', { env: 'FIRST_FETCH_KEY' }), endpoint('second', { env: 'SECOND_FETCH_KEY' })]
  const observed: { path: string; authorization: string | null; redirect: RequestRedirect | undefined }[] = []
  const attempts: string[] = []
  const result = await configuredFetch(pageUrl, signal(), endpoints, async (url, init) => {
    attempts.push(url.pathname)
    observed.push({ path: url.pathname, authorization: new Headers(init.headers).get('authorization'), redirect: init.redirect })
    return url.pathname === '/first' ? new Response('unavailable', { status: 503 }) : response()
  }, undefined, { FIRST_FETCH_KEY: firstKey, SECOND_FETCH_KEY: secondKey })
  expect(attempts).toEqual(['/first', '/second'])
  expect(observed).toEqual([
    { path: '/first', authorization: `Bearer ${firstKey}`, redirect: 'error' },
    { path: '/second', authorization: `Bearer ${secondKey}`, redirect: 'error' },
  ])
  expect(result).toMatchObject({ url: pageUrl, content: 'Public page text.', status: 200 })
})

test('valid empty text is terminal success and is not treated as a failed service', async () => {
  const result = await configuredFetch(pageUrl, signal(), [endpoint('empty')], async () => response(pageUrl, ''))
  expect(result).toMatchObject({ content: '', status: 200 })
})

test('malformed page data, invalid JSON, redirects and oversized responses advance as unavailable', async () => {
  const observed: string[] = []
  const endpoints = [endpoint('malformed'), endpoint('invalid-json'), endpoint('redirect'), endpoint('large'), endpoint('success')]
  const result = await configuredFetch(pageUrl, signal(), endpoints, async url => {
    observed.push(url.pathname)
    if (url.pathname === '/malformed') return new Response(JSON.stringify({ url: 'https://other.example/page', content: 'bad' }))
    if (url.pathname === '/invalid-json') return new Response('{')
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'https://other.example/page' } })
    if (url.pathname === '/large') return new Response(new Uint8Array(2 * 1024 * 1024 + 1))
    return response()
  })
  expect(observed).toEqual(['/malformed', '/invalid-json', '/redirect', '/large', '/success'])
  expect(result.content).toBe('Public page text.')
})

test('cancellation is terminal and a service failure is explicitly reported when all services fail', async () => {
  const stop = new AbortController()
  stop.abort(new Error('fixture cancellation'))
  await expect(fetchFromService(endpoint('cancel'), pageUrl, stop.signal, async () => { throw new Error('not reached') })).rejects.toThrow('fixture cancellation')
  await expect(configuredFetch(pageUrl, signal(), [endpoint('offline')], async () => new Response('down', { status: 503 }))).rejects.toBeInstanceOf(FetchServiceUnavailable)
})

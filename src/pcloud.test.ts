import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { download, PcloudError, probeDownload, readLoginRedirect, refererInUse, resetRefererChoice, type PcloudLogin } from './pcloud.ts'

const login: PcloudLogin = { token: 'tok', host: 'https://eapi.pcloud.com', region: 'EU', at: 'x' }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } })
const bytes = (s: string) => new Response(new TextEncoder().encode(s), { headers: { 'content-type': 'application/octet-stream' } })

/** Answers by method name; each handler may be a response or a function of the request URL. */
function stub(handlers: Record<string, () => Response>) {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, _init?: RequestInit) => {
    const url = new URL(String(input))
    // Download links look like /dl/42 on the file host; the handler key is the first path segment.
    const method = url.pathname.slice(1).split('/')[0]!
    seen.push(`${method}?${[...url.searchParams].filter(([k]) => k !== 'access_token').map(([k, v]) => `${k}=${v}`).join('&')}`)
    const h = handlers[method]
    if (!h) throw new Error(`unexpected ${method}`)
    return h()
  }))
  return seen
}

beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://bnuebel-dev.github.io', pathname: '/igor/' })
  resetRefererChoice()
})
afterEach(() => vi.unstubAllGlobals())

describe('download', () => {
  const link = () => json({ result: 0, hosts: ['c1.pcloud.com'], path: '/dl/42' })

  it('uses the download link first and sends no Referer', async () => {
    const seen = stub({ getfilelink: link, dl: () => bytes('Hallo Welt') })
    const data = await download(login, 42)
    expect(new TextDecoder().decode(data)).toBe('Hallo Welt')
    expect(seen).toEqual(['getfilelink?fileid=42', 'dl?'])
    const calls = (fetch as unknown as { mock: { calls: [unknown, RequestInit | undefined][] } }).mock.calls
    for (const [, init] of calls) expect(init?.referrerPolicy).toBe('no-referrer')
  })

  it('falls back to file_open / file_read in chunks when the link route is refused, and closes the file', async () => {
    const parts = ['Hallo ', 'Welt']
    const seen = stub({
      getfilelink: () => json({ result: 7010, error: 'Invalid link referer.' }), // every variant is refused
      file_open: () => json({ result: 0, fd: 7 }),
      file_size: () => json({ result: 0, size: 10 }),
      file_read: () => bytes(parts.shift()!),
      file_close: () => json({ result: 0 }),
    })
    const data = await download(login, 42)
    expect(new TextDecoder().decode(data)).toBe('Hallo Welt')
    expect(seen).toContain('file_open?flags=0&fileid=42')
    expect(seen.at(-1)).toBe('file_close?fd=7')
    expect(seen.filter(x => x.startsWith('file_read'))).toHaveLength(2)
  })

  it('stops the fallback read at the first empty chunk when the size is unknown', async () => {
    const parts = ['abc', '']
    stub({
      getfilelink: () => json({ result: 7010, error: 'x' }),
      file_open: () => json({ result: 0, fd: 1 }),
      file_size: () => json({ result: 1000, error: 'nope' }),
      file_read: () => bytes(parts.shift()!),
      file_close: () => json({ result: 0 }),
    })
    expect(new TextDecoder().decode(await download(login, 1))).toBe('abc')
  })

  it('does not try another route for a missing file or an expired login', async () => {
    const a = stub({ getfilelink: () => json({ result: 2009, error: 'File not found.' }) })
    await expect(download(login, 1)).rejects.toMatchObject({ code: 2009 })
    expect(a).toHaveLength(1)
    const b = stub({ getfilelink: () => json({ result: 2000, error: 'Log in required.' }) })
    await expect(download(login, 1)).rejects.toMatchObject({ code: 2000, message: expect.stringContaining('neu bei pCloud anmelden') })
    expect(b).toHaveLength(1)
  })

  it('reports both reasons when both routes fail, and still closes the file after a read error', async () => {
    const seen = stub({
      getfilelink: () => json({ result: 7010, error: 'Invalid link referer.' }),
      file_open: () => json({ result: 0, fd: 3 }),
      file_size: () => json({ result: 0, size: 5 }),
      file_read: () => json({ result: 2003, error: 'Access denied.' }),
      file_close: () => json({ result: 0 }),
    })
    const err = await download(login, 1).catch(e => e)
    expect(err).toBeInstanceOf(PcloudError)
    expect(err.message).toContain('7010')
    expect(err.message).toContain('Ersatzweg')
    expect(err.message).toContain('2003')
    expect(seen.at(-1)).toBe('file_close?fd=3')
  })
})

describe('Referer variants', () => {
  const link = () => json({ result: 0, hosts: ['c1.pcloud.com'], path: '/dl/42' })

  /** A pCloud that accepts only requests sent with the page's full address as Referer. */
  function strictPcloud() {
    const used: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input))
      const ok = init?.referrer === 'https://bnuebel-dev.github.io/igor/' && init?.referrerPolicy === 'unsafe-url'
      used.push(`${url.pathname.slice(1).split('/')[0]}:${init?.referrerPolicy ?? 'default'}`)
      if (url.pathname === '/getfilelink') return ok ? link() : json({ result: 7010, error: 'Invalid link referer.' })
      return bytes('Inhalt')
    }))
    return used
  }

  it('moves on to the next variant when pCloud answers 7010, and remembers the one that worked', async () => {
    const used = strictPcloud()
    expect(new TextDecoder().decode(await download(login, 42))).toBe('Inhalt')
    expect(used).toEqual(['getfilelink:no-referrer', 'getfilelink:unsafe-url', 'dl:unsafe-url'])
    expect(refererInUse()).toBe('volle Adresse')

    used.length = 0
    await download(login, 43) // goes straight to the variant that worked
    expect(used).toEqual(['getfilelink:unsafe-url', 'dl:unsafe-url'])
  })

  it('probeDownload reports every route once, with the reason for each refusal', async () => {
    strictPcloud()
    const lines = await probeDownload(login, 42)
    expect(lines.map(l => l.ok)).toEqual([false, true, false, false]) // the file_read route is not served by this fake
    expect(lines[0]!.line).toContain('Link, ohne Referer')
    expect(lines[0]!.line).toContain('7010')
    expect(lines[1]!.line).toContain('Link, volle Adresse')
  })
})

describe('login redirect', () => {
  it('takes token, host and region from the address', () => {
    const r = readLoginRedirect(new URLSearchParams('access_token=abc&hostname=eapi.pcloud.com&locationid=2'))
    expect(r.login).toMatchObject({ token: 'abc', host: 'https://eapi.pcloud.com', region: 'EU' })
  })

  it('falls back to the location id, and reports an error', () => {
    expect(readLoginRedirect(new URLSearchParams('access_token=abc&locationid=1')).login).toMatchObject({ host: 'https://api.pcloud.com', region: 'US' })
    expect(readLoginRedirect(new URLSearchParams('error=access_denied&error_description=Nein')).error).toBe('access_denied Nein')
    expect(readLoginRedirect(new URLSearchParams('')).login).toBeUndefined()
  })
})

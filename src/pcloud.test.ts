import { afterEach, describe, expect, it, vi } from 'vitest'
import { download, PcloudError, readLoginRedirect, type PcloudLogin } from './pcloud.ts'

const login: PcloudLogin = { token: 'tok', host: 'https://eapi.pcloud.com', region: 'EU', at: 'x' }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8' } })
const bytes = (s: string) => new Response(new TextEncoder().encode(s), { headers: { 'content-type': 'application/octet-stream' } })

/** Answers by method name; each handler may be a response or a function of the request URL. */
function stub(handlers: Record<string, () => Response>) {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
    const url = new URL(String(input))
    const method = url.pathname.slice(1)
    seen.push(`${method}?${[...url.searchParams].filter(([k]) => k !== 'access_token').map(([k, v]) => `${k}=${v}`).join('&')}`)
    const h = handlers[method]
    if (!h) throw new Error(`unexpected ${method}`)
    return h()
  }))
  return seen
}

afterEach(() => vi.unstubAllGlobals())

describe('download', () => {
  it('reads a file in chunks through file_open / file_read and closes it', async () => {
    const parts = ['Hallo ', 'Welt']
    const seen = stub({
      file_open: () => json({ result: 0, fd: 7 }),
      file_size: () => json({ result: 0, size: 10 }),
      file_read: () => bytes(parts.shift()!),
      file_close: () => json({ result: 0 }),
    })
    const data = await download(login, 42)
    expect(new TextDecoder().decode(data)).toBe('Hallo Welt')
    expect(seen[0]).toBe('file_open?flags=0&fileid=42')
    expect(seen.at(-1)).toBe('file_close?fd=7')
    expect(seen.filter(s => s.startsWith('file_read'))).toHaveLength(2)
  })

  it('stops at the first empty read when the size is unknown', async () => {
    const parts = ['abc', '']
    stub({
      file_open: () => json({ result: 0, fd: 1 }),
      file_size: () => json({ result: 1000, error: 'nope' }),
      file_read: () => bytes(parts.shift()!),
      file_close: () => json({ result: 0 }),
    })
    expect(new TextDecoder().decode(await download(login, 1))).toBe('abc')
  })

  it('turns a JSON answer to file_read into the pCloud error and still closes the file', async () => {
    const seen = stub({
      file_open: () => json({ result: 0, fd: 3 }),
      file_size: () => json({ result: 0, size: 5 }),
      file_read: () => json({ result: 2000, error: 'Log in required.' }),
      file_close: () => json({ result: 0 }),
    })
    await expect(download(login, 1)).rejects.toMatchObject({ code: 2000, message: expect.stringContaining('neu bei pCloud anmelden') })
    expect(seen.at(-1)).toBe('file_close?fd=3')
  })

  it('does not try the link route for a missing file', async () => {
    const seen = stub({ file_open: () => json({ result: 2009, error: 'File not found.' }) })
    await expect(download(login, 1)).rejects.toMatchObject({ code: 2009 })
    expect(seen).toHaveLength(1)
  })

  it('falls back to the link route when the API refuses file_open, and reports both reasons if that fails too', async () => {
    stub({
      file_open: () => json({ result: 7010, error: 'Invalid link referer.' }),
      getfilelink: () => json({ result: 7010, error: 'Invalid link referer.' }),
    })
    const err = await download(login, 1).catch(e => e)
    expect(err).toBeInstanceOf(PcloudError)
    expect(err.message).toContain('Ersatzweg')
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

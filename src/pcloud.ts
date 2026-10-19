// pCloud access: OAuth login (token flow, no server needed) and the few API calls IGOR uses.
// The token travels in the address, not in a header: a header makes the browser send a
// preflight request that pCloud does not answer (measured on the glasses' phone).
import type { Kv } from './storage.ts'

type Log = (level: 'info' | 'ok' | 'fail', msg: string) => void

export const PCLOUD_HOSTS = { us: 'https://api.pcloud.com', eu: 'https://eapi.pcloud.com' }

/** Public identifier of the IGOR app at pCloud; not a secret. */
export const DEFAULT_CLIENT_ID = 'zyNLkSuqlgS'

export const LOGIN_KEY = 'igor.pcloud'
export const SYNC_KEY = 'igor.pcloud.sync'

export type PcloudLogin = { token: string; host: string; region: string; at: string }
/** The chosen folder; documents below it are mirrored into the library. */
export type SyncConfig = { folderid: number; name: string; lastSync?: number }

export class PcloudError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message)
    this.name = 'PcloudError'
  }
}

const redirectUri = () => `${location.origin}${location.pathname}`

// ---- Login ------------------------------------------------------------------------------------

/** Leaves the page for pCloud's login; pCloud sends the browser back with the token in the hash. */
export function startPcloudLogin(clientId: string, log: Log): void {
  const id = clientId.trim() || DEFAULT_CLIENT_ID
  log('info', `pCloud: öffne Anmeldung, Rückkehr an ${redirectUri()}`)
  const url = new URL('https://my.pcloud.com/oauth2/authorize')
  url.searchParams.set('client_id', id)
  url.searchParams.set('response_type', 'token')
  url.searchParams.set('redirect_uri', redirectUri())
  location.assign(url.toString())
}

/** Reads the token pCloud put into the address after the login and removes it from the address bar. */
export function readLoginRedirect(params: URLSearchParams): { login?: PcloudLogin; error?: string } {
  const token = params.get('access_token')
  const error = params.get('error')
  if (error) return { error: `${error} ${params.get('error_description') ?? ''}`.trim() }
  if (!token) return {}
  const hostname = params.get('hostname')
  const host = hostname ? `https://${hostname}` : params.get('locationid') === '2' ? PCLOUD_HOSTS.eu : PCLOUD_HOSTS.us
  return { login: { token, host, region: host.includes('eapi') ? 'EU' : 'US', at: new Date().toLocaleString('de-DE') } }
}

/** At startup: finish a login that just returned, or load the saved one. */
export async function restoreLogin(kv: Kv, log: Log): Promise<PcloudLogin | null> {
  const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1))
  const { login, error } = readLoginRedirect(params)
  if (login || error) history.replaceState(null, '', redirectUri())
  if (error) {
    log('fail', `pCloud-Anmeldung: ${error}`)
    return null
  }
  if (login) {
    await kv.set(LOGIN_KEY, JSON.stringify(login))
    log('ok', `pCloud-Anmeldung zurück: Token erhalten, Region ${login.region}`)
    return login
  }
  const saved = await kv.get(LOGIN_KEY)
  if (!saved) return null
  try {
    return JSON.parse(saved) as PcloudLogin
  } catch {
    return null
  }
}

export async function forgetLogin(kv: Kv): Promise<void> {
  await kv.set(LOGIN_KEY, '')
  await kv.set(SYNC_KEY, '')
}

export async function loadSyncConfig(kv: Kv): Promise<SyncConfig | null> {
  const raw = await kv.get(SYNC_KEY)
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as SyncConfig
    return typeof c.folderid === 'number' ? c : null
  } catch {
    return null
  }
}

export const saveSyncConfig = (kv: Kv, c: SyncConfig) => kv.set(SYNC_KEY, JSON.stringify(c))

// ---- API --------------------------------------------------------------------------------------

function describeCode(code: number, text: string): string {
  switch (code) {
    case 1000: case 2000: return 'Anmeldung abgelaufen, bitte neu bei pCloud anmelden'
    case 2005: return 'Ordner existiert nicht mehr'
    case 2009: return 'Datei existiert nicht mehr'
    case 4000: return 'pCloud: zu viele Anfragen, bitte später erneut'
    default: return `pCloud-Fehler ${code}: ${text}`
  }
}

export async function api(login: PcloudLogin, method: string, params: Record<string, string | number> = {}): Promise<any> {
  const url = new URL(`${login.host}/${method}`)
  url.searchParams.set('access_token', login.token)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    throw new PcloudError(`pCloud nicht erreichbar (${(err as Error).message})`, null)
  }
  const body = await res.json().catch(() => null)
  if (!body) throw new PcloudError(`pCloud: unlesbare Antwort (HTTP ${res.status})`, null)
  if (body.result !== 0) throw new PcloudError(describeCode(body.result, body.error ?? ''), body.result)
  return body
}

export type FolderEntry = { id: number; name: string }

/** Sub-folders of one folder, for the folder picker. */
export async function listSubfolders(login: PcloudLogin, folderid: number): Promise<FolderEntry[]> {
  const body = await api(login, 'listfolder', { folderid, nofiles: 1 })
  return (body.metadata?.contents ?? [])
    .filter((c: any) => c.isfolder)
    .map((c: any) => ({ id: c.folderid as number, name: c.name as string }))
    .sort((a: FolderEntry, b: FolderEntry) => a.name.localeCompare(b.name, 'de'))
}

/** The whole tree below a folder in one request. */
export async function listTree(login: PcloudLogin, folderid: number): Promise<any> {
  return (await api(login, 'listfolder', { folderid, recursive: 1 })).metadata
}

/** File content; the download link is short-lived, so it is fetched right before the download. */
export async function download(login: PcloudLogin, fileid: number): Promise<ArrayBuffer> {
  const link = await api(login, 'getfilelink', { fileid })
  const url = `https://${link.hosts[0]}${link.path}`
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    throw new PcloudError(`Download blockiert (${(err as Error).message}); vermutlich fehlt dem Dateiserver die Freigabe für Browser`, null)
  }
  if (!res.ok) throw new PcloudError(`Download: HTTP ${res.status}`, null)
  return res.arrayBuffer()
}

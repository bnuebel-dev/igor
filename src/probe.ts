// Feasibility probes for the document library: what the Even app's WebView allows
// (file picker, storage size, PDF parsing, pCloud API and login). Diagnostics only.
import type { Kv } from './storage.ts'

type Log = (level: 'info' | 'ok' | 'fail', msg: string) => void

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)
const ms = (t: number) => `${Math.round(performance.now() - t)} ms`
const errText = (err: unknown) => (err as Error)?.message ?? String(err)

// ---- A: file picker ---------------------------------------------------------------------------

/** Logs what a file or folder selection delivered and returns the files for the PDF probe. */
export async function describeSelection(files: FileList | null, kind: 'Dateien' | 'Ordner', log: Log): Promise<File[]> {
  const list = [...(files ?? [])]
  if (!list.length) {
    log('fail', `A ${kind}: nichts ausgewählt oder Auswahl nicht unterstützt`)
    return []
  }
  const withPath = list.filter(f => f.webkitRelativePath)
  const total = list.reduce((n, f) => n + f.size, 0)
  log('ok', `A ${kind}: ${list.length} Datei(en), zusammen ${kb(total)}, mit Ordnerpfad: ${withPath.length}`)
  for (const f of list.slice(0, 8)) {
    log('info', `   ${f.webkitRelativePath || f.name} · ${kb(f.size)} · Typ "${f.type || '?'}"`)
  }
  if (list.length > 8) log('info', `   … und ${list.length - 8} weitere`)
  const text = list.find(f => /\.(md|txt|markdown)$/i.test(f.name))
  if (text) {
    try {
      const t = performance.now()
      const content = await text.text()
      log('ok', `A Lesen ${text.name}: ${content.length} Zeichen in ${ms(t)}: "${content.slice(0, 80).replace(/\s+/g, ' ')}"`)
    } catch (err) {
      log('fail', `A Lesen ${text.name}: ${errText(err)}`)
    }
  }
  return list
}

// ---- B: storage -------------------------------------------------------------------------------

const PROBE_KEY = 'igor.probe'
const MARKER_KEY = 'igor.probe.marker'
const SIZES = [100 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]

function payload(bytes: number): string {
  // Varied text so no layer can compress it away; German umlauts like real notes.
  const unit = 'Boss, die Kündigungsfrist beträgt drei Monate zum Monatsende. '
  let s = ''
  while (s.length < bytes) s += unit + (s.length % 997)
  return s.slice(0, bytes)
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('igor-probe', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('kv', mode)
      const req = fn(tx.objectStore('kv'))
      tx.oncomplete = () => resolve(req.result as T)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('abgebrochen'))
    })
  } finally {
    db.close()
  }
}

/** Writes growing test blobs to the Even app storage and to IndexedDB, reads them back, cleans up. */
export async function probeStorage(kv: Kv, log: Log): Promise<void> {
  try {
    const est = await navigator.storage?.estimate?.()
    const persisted = await navigator.storage?.persisted?.()
    log('info', `B Browser-Speicher: belegt ${kb(est?.usage ?? 0)}, verfügbar ${kb(est?.quota ?? 0)}, dauerhaft: ${persisted ? 'ja' : 'nein'}`)
    if (!persisted && navigator.storage?.persist) log('info', `B Dauerhaft anfordern: ${(await navigator.storage.persist()) ? 'gewährt' : 'abgelehnt'}`)
  } catch (err) {
    log('fail', `B Speicherabfrage: ${errText(err)}`)
  }

  for (const [name, put, get, drop] of [
    [
      `Even-Speicher (${kv.backend})`,
      (v: string) => kv.set(PROBE_KEY, v).then(ok => { if (!ok) throw new Error('abgelehnt') }),
      () => kv.get(PROBE_KEY),
      () => kv.set(PROBE_KEY, '').then(() => undefined),
    ],
    [
      'IndexedDB',
      (v: string) => idb<void>('readwrite', s => s.put(v, PROBE_KEY)),
      () => idb<string>('readonly', s => s.get(PROBE_KEY)),
      () => idb<void>('readwrite', s => s.delete(PROBE_KEY)),
    ],
  ] as const) {
    let best = 0
    for (const size of SIZES) {
      const value = payload(size)
      const t = performance.now()
      try {
        await put(value)
        const back = await get()
        if (back !== value) throw new Error(`zurückgelesen ${back?.length ?? 0} statt ${value.length} Zeichen`)
        log('ok', `B ${name}: ${kb(size)} geschrieben und gelesen in ${ms(t)}`)
        best = size
      } catch (err) {
        log('fail', `B ${name}: ${kb(size)} fehlgeschlagen nach ${ms(t)}: ${errText(err)}`)
        break
      }
    }
    await drop().catch(() => undefined)
    log(best ? 'ok' : 'fail', `B ${name}: höchstens getestet ${best ? kb(best) : 'nichts'}`)
  }

  // Survives a restart? The marker is checked on the next start by checkMarkers().
  const stamp = new Date().toLocaleString('de-DE')
  await kv.set(MARKER_KEY, stamp).catch(() => false)
  await idb<void>('readwrite', s => s.put(stamp, MARKER_KEY)).catch(() => undefined)
  log('info', `B Merkzeichen "${stamp}" gesetzt. Bitte IGOR schließen, die Even-App beenden, neu öffnen und ins Protokoll schauen.`)
}

/** At startup: report which storage kept the marker from the last storage probe. */
export async function checkMarkers(kv: Kv, log: Log): Promise<void> {
  const even = await kv.get(MARKER_KEY).catch(() => '')
  const db = await idb<string | undefined>('readonly', s => s.get(MARKER_KEY)).catch(() => undefined)
  if (!even && !db) return
  log('info', `B Nach Neustart: Even-Speicher ${even ? `hat "${even}"` : 'leer'}, IndexedDB ${db ? `hat "${db}"` : 'leer'}`)
}

// ---- C: PDF to text ---------------------------------------------------------------------------

export async function probePdf(file: File, log: Log): Promise<void> {
  const t = performance.now()
  try {
    // Loaded on demand: pdf.js is large and only needed when a PDF arrives.
    const pdfjs = await import('pdfjs-dist')
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    let chars = 0
    let first = ''
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const text = content.items.map(i => ('str' in i ? i.str : '')).join(' ')
      chars += text.trim().length
      if (!first && text.trim()) first = text.trim()
    }
    const scanned = chars < doc.numPages * 20
    log(
      scanned ? 'fail' : 'ok',
      `C PDF ${file.name}: ${doc.numPages} Seiten, ${chars} Zeichen Text in ${ms(t)}${scanned ? ' – kaum Text, vermutlich eingescannt' : ''}: "${first.slice(0, 80)}"`,
    )
    await doc.cleanup()
  } catch (err) {
    log('fail', `C PDF ${file.name}: ${errText(err)} nach ${ms(t)}`)
  }
}

// ---- D: pCloud API ----------------------------------------------------------------------------

export const PCLOUD_HOSTS = { us: 'https://api.pcloud.com', eu: 'https://eapi.pcloud.com' }

export async function probePcloudApi(log: Log): Promise<void> {
  for (const [region, host] of Object.entries(PCLOUD_HOSTS)) {
    const t = performance.now()
    try {
      const res = await fetch(`${host}/getapiserver`)
      const body = await res.json()
      log('ok', `D pCloud ${region.toUpperCase()}: erreichbar in ${ms(t)}, Server ${body.api?.[0] ?? '?'}`)
    } catch (err) {
      log('fail', `D pCloud ${region.toUpperCase()}: ${errText(err)} (Netz oder CORS)`)
    }
    // With a token header the browser sends a preflight first; pCloud must allow it for logged-in calls.
    const t2 = performance.now()
    try {
      const res = await fetch(`${host}/userinfo`, { headers: { Authorization: 'Bearer probe' } })
      const body = await res.json()
      log('ok', `D pCloud ${region.toUpperCase()} mit Anmeldekopf: Antwort in ${ms(t2)} (${body.result} ${body.error ?? ''})`)
    } catch (err) {
      log('fail', `D pCloud ${region.toUpperCase()} mit Anmeldekopf: ${errText(err)}; Token müsste in die Adresse`)
    }
  }
}

// ---- E: pCloud login --------------------------------------------------------------------------

const TOKEN_KEY = 'igor.pcloud'

export type PcloudLogin = { token: string; host: string; region: string; at: string }

const redirectUri = () => `${location.origin}${location.pathname}`

/** Leaves the page for pCloud's login; pCloud sends the browser back with the token in the hash. */
export function startPcloudLogin(clientId: string, log: Log): void {
  if (!clientId.trim()) {
    log('fail', 'E pCloud: zuerst die Client-ID eintragen')
    return
  }
  log('info', `E pCloud: öffne Anmeldung, Rückkehr an ${redirectUri()}`)
  const url = new URL('https://my.pcloud.com/oauth2/authorize')
  url.searchParams.set('client_id', clientId.trim())
  url.searchParams.set('response_type', 'token')
  url.searchParams.set('redirect_uri', redirectUri())
  location.assign(url.toString())
}

/** At startup: pick up a token from the login redirect and remove it from the address bar. */
export async function finishPcloudLogin(kv: Kv, log: Log): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1))
  const token = params.get('access_token')
  const error = params.get('error')
  if (!token && !error) {
    const saved = await kv.get(TOKEN_KEY)
    if (saved) {
      const login = JSON.parse(saved) as PcloudLogin
      log('info', `E pCloud: angemeldet seit ${login.at} (${login.region})`)
    }
    return
  }
  history.replaceState(null, '', redirectUri())
  if (error) {
    log('fail', `E pCloud-Anmeldung: ${error} ${params.get('error_description') ?? ''}`)
    return
  }
  const host = params.get('hostname') ? `https://${params.get('hostname')}` : params.get('locationid') === '2' ? PCLOUD_HOSTS.eu : PCLOUD_HOSTS.us
  const login: PcloudLogin = { token: token!, host, region: host.includes('eapi') ? 'EU' : 'US', at: new Date().toLocaleString('de-DE') }
  await kv.set(TOKEN_KEY, JSON.stringify(login))
  log('ok', `E pCloud-Anmeldung zurück: Token erhalten, Region ${login.region}, Felder: ${[...params.keys()].join(', ')}`)
  await probePcloudFolder(login, log)
}

/** With a token: list the root folder to prove the round trip works. */
async function probePcloudFolder(login: PcloudLogin, log: Log): Promise<void> {
  const t = performance.now()
  try {
    const res = await fetch(`${login.host}/listfolder?folderid=0&access_token=${encodeURIComponent(login.token)}`)
    const body = await res.json()
    if (body.result !== 0) throw new Error(`pCloud-Fehler ${body.result}: ${body.error}`)
    const names = (body.metadata?.contents ?? []).map((c: { name: string; isfolder: boolean }) => (c.isfolder ? `${c.name}/` : c.name))
    log('ok', `E pCloud-Ordner gelesen in ${ms(t)}: ${names.slice(0, 12).join(', ') || '(leer)'}`)
  } catch (err) {
    log('fail', `E pCloud-Ordner lesen: ${errText(err)}`)
  }
}

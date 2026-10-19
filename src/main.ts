import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { measureTextWrap } from '@evenrealities/pretext'
import { Assistant, type Port, type State } from './assistant.ts'
import { startBrowserRecording, recordBrowserPcm, type BrowserRecording } from './browserMic.ts'
import { CHAT_SPECS, resolveChoices, STT_SPECS, type Choice } from './catalog.ts'
import { createGestureFilter, gestureOf, listIndexOf } from './events.ts'
import { Glasses } from './glasses.ts'
import {
  addNote, clearHistory, createTopic, deleteTopic, emptyMemory, MemoryStore, parseMemory, removeNote, renameTopic, selectTopic,
  serializeMemory, setSummary,
} from './memory.ts'
import {
  chat, keyInfo, listModels, listTranscriptionModels, OpenRouterError, searchCount, transcribe, type ChatMessage, type ModelInfo, type Usage,
} from './openrouter.ts'
import { DEFAULT_PERSONA, GREETING, SEARCH_RULES } from './persona.ts'
import { germanNow } from './prompt.ts'
import { readBuffer, readFile } from './ingest.ts'
import { LibraryStore } from './libraryStore.ts'
import { MAX_LIBRARY_CHARS } from './library.ts'
import { checkMarkers, describeSelection, probePcloudApi, probePdf, probeStorage } from './probe.ts'
import {
  DEFAULT_CLIENT_ID, download as pcDownload, probeDownload, refererInUse, forgetLogin, listSubfolders, listTree, loadSyncConfig, restoreLogin, saveSyncConfig, startPcloudLogin,
  type FolderEntry, type PcloudLogin, type SyncConfig,
} from './pcloud.ts'
import { describeReport, flatten, runSync } from './pcloudSync.ts'
import { mountPhone } from './phone.ts'
import { createKv, DEFAULT_SETTINGS, debouncedSave, loadSettings, MEMORY_KEY, saveSettings, type Settings } from './storage.ts'
import { clampUtf8, sanitizeForGlasses } from './text.ts'
import { withTimeout } from './timeout.ts'

const VERSION = '0.5.4'
let assistant: Assistant

const phone = mountPhone({
  action: (name, data) => void onAction(name, data),
  gesture: (g, index) => assistant?.onGesture(g, index),
})
phone.setVersion(VERSION)
phone.log('info', `IGOR ${VERSION} · ${navigator.userAgent}`)
// Fill the model lists right away; waiting for the bridge can take a couple of seconds.
phone.setChatChoices(resolveChoices(CHAT_SPECS, []), DEFAULT_SETTINGS.chatModel)
phone.setSttChoices(resolveChoices(STT_SPECS, []), DEFAULT_SETTINGS.sttModel)

const bridge = await connectBridge()

// The glasses page comes first: nothing else may delay it, and the first call is the only one that counts.
const glasses = bridge ? new Glasses(bridge, msg => phone.log('fail', msg)) : null
const glassesStarted = glasses ? await glasses.start(`IGOR\n\n${GREETING}`) : false
const kv = createKv(bridge)
let settings: Settings = await loadSettings(kv)
phone.writeSettings(settings)

// A model counts as chosen once the user has saved it; until then the first curated entry applies.
const pinned = { chat: settings.chatModel !== '', stt: settings.sttModel !== '' }
let chatChoices: Choice[] = resolveChoices(CHAT_SPECS, [])

function showChat(models: ModelInfo[]): Choice[] {
  chatChoices = resolveChoices(CHAT_SPECS, models)
  phone.setChatChoices(chatChoices, pinned.chat ? settings.chatModel : '')
  if (!pinned.chat) settings.chatModel = phone.readSettings().chatModel
  return chatChoices
}

function showStt(models: ModelInfo[]): Choice[] {
  const choices = resolveChoices(STT_SPECS, models, { fillRest: true })
  phone.setSttChoices(choices, pinned.stt ? settings.sttModel : '')
  if (!pinned.stt) settings.sttModel = phone.readSettings().sttModel
  return choices
}
showChat([])
showStt([])

// ---- Memory -----------------------------------------------------------------------------------

const rawMemory = await kv.get(MEMORY_KEY)
let initialMemory = emptyMemory()
if (rawMemory) {
  const parsed = parseMemory(rawMemory)
  if (parsed) initialMemory = parsed
  else {
    phone.log('fail', 'Gedächtnis war beschädigt und wurde leer gestartet. Der alte Inhalt steht unter Gedächtnis → Sicherung.')
    phone.backupText(rawMemory)
  }
}
const saver = debouncedSave(json => kv.set(MEMORY_KEY, json))
const store = new MemoryStore(initialMemory, saver)
store.subscribe(() => {
  phone.renderMemory(store.memory)
  updateInfo()
})
phone.renderMemory(store.memory)
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saver.flush())
window.addEventListener('pagehide', () => saver.flush())

// ---- Glasses (real, or virtual on the phone page) --------------------------------------------

let virtualRec: BrowserRecording | null = null
let exitRequested = false

const port: Port = {
  showText(text) {
    phone.setPreview({ kind: 'text', text: clampUtf8(sanitizeForGlasses(text)) })
    glasses?.showText(text)
  },
  showList(title, items) {
    phone.setPreview({ kind: 'list', title, items })
    glasses?.showList(title, items)
  },
  async mic(on) {
    if (glasses) return glasses.mic(on)
    try {
      if (on) virtualRec = await startBrowserRecording()
      else if (virtualRec) {
        const rec = virtualRec
        virtualRec = null
        assistant.onPcm(await rec.stop()) // the controller takes the audio right after this call returns
      }
      return true
    } catch (err) {
      phone.log('fail', `Browser-Mikrofon: ${(err as Error).message}`)
      return false
    }
  },
  requestExit() {
    if (glasses) {
      exitRequested = true
      void glasses.requestExit()
    } else phone.log('info', 'Auf der Brille würde jetzt der Beenden-Dialog erscheinen.')
  },
}

// ---- Services ---------------------------------------------------------------------------------

// With the local mock API any sk-or- key is accepted, so tests run without a real key.
const MOCK_KEY = import.meta.env.VITE_OPENROUTER_API ? 'sk-or-mock' : ''
const key = () => settings.apiKey || MOCK_KEY
const persona = () => {
  const base = settings.persona.trim() || DEFAULT_PERSONA
  return settings.webSearch ? `${base}\n\n${SEARCH_RULES}` : base
}
const ms = (n: number) => `${Math.round(n)} ms`
const formatNote = (r: { format: string; fellBack: boolean }) => (r.fellBack ? `${r.format}, pcm abgelehnt` : r.format)

function costText(usage?: Usage): string {
  if (!usage) return ''
  const tokens = `${usage.prompt_tokens ?? '?'}+${usage.completion_tokens ?? '?'} Tokens`
  const searches = searchCount(usage)
  const parts = [tokens, searches ? `${searches} Websuche${searches > 1 ? 'n' : ''}` : '']
  if (typeof usage.cost === 'number') parts.push(`${usage.cost.toFixed(5)} $`)
  return parts.filter(Boolean).join(', ')
}

function describe(err: unknown): string {
  if (err instanceof OpenRouterError) return err.detail ? `${err.message} (${err.detail})` : err.message
  return (err as Error)?.message ?? String(err)
}

// ---- Documents --------------------------------------------------------------------------------

const library = new LibraryStore(kv, (level, msg) => phone.log(level, msg))

function renderLibrary() {
  const docs = library.list()
  const topics = store.memory.topics.map(t => ({ id: t.id, name: t.name }))
  const used = (library.totalChars / 1000).toFixed(library.totalChars < 10_000 ? 1 : 0)
  phone.renderLibrary(
    docs,
    topics,
    docs.length ? `${docs.length} Dokument${docs.length > 1 ? 'e' : ''}, ${library.chunkCount} Abschnitte, ${used}k von ${MAX_LIBRARY_CHARS / 1000}k Zeichen` : '',
  )
}
library.subscribe(renderLibrary)
store.subscribe(renderLibrary)
const libraryReady = library.load().then(renderLibrary, err => phone.log('fail', `Unterlagen laden: ${describe(err)}`))

async function addFiles(files: File[]) {
  for (const file of files) {
    try {
      const t = performance.now()
      const r = await library.add(await readFile(file))
      if (r.ok) phone.log('ok', `Unterlagen: ${r.doc.path} ${r.replaced ? 'ersetzt' : 'hinzugefügt'} (${ms(performance.now() - t)})`)
      else phone.log('fail', `Unterlagen: ${r.reason}`)
    } catch (err) {
      phone.log('fail', `Unterlagen: ${file.name}: ${describe(err)}`)
    }
  }
}

function libraryAction(name: string, d: Record<string, string>): boolean {
  if (!name.startsWith('lib:')) return false
  if (name === 'lib:add') {
    const input = document.getElementById('libFiles') as HTMLInputElement
    input.value = ''
    input.click() // must happen inside the tap, before any await
  } else if (name === 'lib:picked') {
    const files = [...((document.getElementById('libFiles') as HTMLInputElement).files ?? [])]
    void runBusy(() => addFiles(files))
  } else if (name === 'lib:remove') {
    void library.remove(d.id!).then(ok => ok || phone.log('fail', 'Unterlagen: Löschen vom Speicher abgelehnt'))
  } else if (name === 'lib:topic') {
    void library.setTopic(d.id!, d.topic || null)
  } else if (name === 'lib:search') {
    phone.renderSearch(library.search(d.query ?? '', { topicId: store.memory.currentTopicId }))
  }
  return true
}

assistant = new Assistant({
  findPassages: (query, topicId) => library.search(query, { topicId }),
  port,
  store,
  persona,
  hasKey: () => !!key(),
  models: () => chatChoices,
  currentModel: () => settings.chatModel,
  pickModel(id) {
    settings.chatModel = id
    pinned.chat = true
    void saveSettings(kv, settings)
    phone.setChatChoices(chatChoices, id)
    updateInfo()
  },
  async transcribe(pcm, signal) {
    const r = await transcribe(key(), settings.sttModel, pcm, { format: settings.sttFormat, language: settings.language || undefined, signal })
    phone.log('ok', `Spracherkennung ${settings.sttModel} (${formatNote(r)}): ${ms(r.totalMs)}, "${r.text}"`)
    return r.text
  },
  async ask(messages, onText, signal) {
    const r = await chat(key(), settings.chatModel, messages, { onDelta: onText, signal, webSearch: settings.webSearch })
    if (r.searchRefused) phone.log('info', `${settings.chatModel} kann keine Websuche; Antwort ohne Suche.`)
    phone.log(
      r.finishReason === 'length' ? 'fail' : 'ok',
      `Antwort ${settings.chatModel}: erstes Token ${ms(r.firstTokenMs)}, gesamt ${ms(r.totalMs)}, ${costText(r.usage)}, Ende: ${r.finishReason ?? '?'}`,
    )
    return r.text
  },
  async complete(messages) {
    return (await chat(key(), settings.chatModel, messages, { stream: false, maxTokens: 800 })).text
  },
  measure: text => measureTextWrap(text, 560).lineCount,
  log: (level, msg) => phone.log(level, msg),
  onExchange: (q, a) => phone.addExchange(q, a),
  onChange: () => updateInfo(),
})

const STATE_LABEL: Record<State, string> = {
  home: 'bereit', recording: 'hört zu', transcribing: 'erkennt', thinking: 'denkt nach', answer: 'Antwort', proposal: 'Merk-Vorschlag',
  menu: 'Menü', topics: 'Menü', models: 'Menü', notes: 'Notizen',
}

function updateInfo() {
  const model = chatChoices.find(c => c.id === settings.chatModel)?.text ?? settings.chatModel
  phone.setInfo(`Modell: ${model} · Thema: ${assistant.topicName ?? 'keines'} · ${STATE_LABEL[assistant.state]}`)
}

// ---- Startup ----------------------------------------------------------------------------------

if (glasses) {
  const ok = glassesStarted
  phone.setStatus(ok ? 'Brille verbunden' : 'Brille: Seite fehlt', ok ? 'ok' : 'fail')
  const device = await bridge!.getDeviceInfo().catch(() => null)
  if (device) phone.log('info', `Gerät: ${device.model}, Akku ${device.status?.batteryLevel ?? '?'} %`)
} else {
  phone.setStatus('Virtuelle Brille', 'warn')
  phone.setVirtual(true)
}
assistant.start()
updateInfo()
void loadModelLists()
void probeStartup()
void pcloudStartup().catch(err => plog('fail', `pCloud: ${describe(err)}`))

/** The Even app injects its WebView handler; a plain browser never gets it. */
async function connectBridge(): Promise<EvenAppBridge | null> {
  const w = window as unknown as { flutter_inappwebview?: { callHandler?: unknown } }
  for (let i = 0; i < 20 && typeof w.flutter_inappwebview?.callHandler !== 'function'; i++) {
    await new Promise(r => setTimeout(r, 100))
  }
  if (typeof w.flutter_inappwebview?.callHandler !== 'function') return null
  try {
    return await withTimeout(waitForEvenAppBridge(), 5000, 'Bridge')
  } catch (err) {
    phone.log('fail', (err as Error).message)
    return null
  }
}

async function loadModelLists() {
  try {
    const models = await listModels()
    const picks = showChat(models)
    phone.log('info', `Chat-Auswahl: ${picks.map(c => `${c.label}=${c.id}`).join(', ')}`)
    updateInfo()
  } catch (err) {
    phone.log('fail', `Modellliste: ${describe(err)}`)
  }
  try {
    const picks = showStt(await listTranscriptionModels())
    phone.log('info', `Sprach-Auswahl: ${picks.map(c => `${c.label}=${c.id}`).join(', ')}`)
  } catch (err) {
    phone.log('fail', `Liste Spracherkennung: ${describe(err)}`)
  }
}

// ---- Events from the glasses ------------------------------------------------------------------

if (bridge && glasses) {
  const accept = createGestureFilter({ foreground: 600, background: 600, exit: 600, 'scroll-up': 300, 'scroll-down': 300 })
  const off = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm) return assistant.onPcm(pcm)
    const g = gestureOf(event)
    if (!g || !accept(g)) return

    // The exit dialog inverts the lifecycle events: "foreground" when it opens (the host has
    // cleared the page), "background" when the user answers "No".
    if (exitRequested && (g === 'foreground' || g === 'background')) {
      glasses.invalidate()
      if (g === 'background') {
        exitRequested = false
        assistant.refresh()
      }
      return
    }
    if (g === 'foreground') {
      glasses.invalidate()
      assistant.refresh()
    } else if (g === 'background') assistant.onBackground()
    else if (g === 'exit') {
      saver.flush()
      assistant.shutdown()
      off()
    } else assistant.onGesture(g, listIndexOf(event))
  })
}

// ---- Buttons on the phone page ----------------------------------------------------------------

const quick = (question: string): ChatMessage[] => [
  { role: 'system', content: persona() },
  { role: 'user', content: question },
]

function requireKey(): boolean {
  if (key()) return true
  phone.log('fail', 'Kein API-Schlüssel gespeichert')
  return false
}

const tests: Record<'cors' | 'key' | 'chat-plain' | 'chat-stream' | 'search', () => Promise<void>> = {
  async cors() {
    const t = performance.now()
    const models = await listModels()
    phone.log('ok', `1 Verbindung: ${models.length} Modelle in ${ms(performance.now() - t)}, CORS ok`)
  },
  async key() {
    if (!requireKey()) return
    const info = await keyInfo(key())
    phone.log('ok', `2 Schlüssel gültig: ${info.label ?? 'ohne Namen'}, verbraucht ${info.usage ?? '?'} $`)
  },
  async 'chat-plain'() {
    if (!requireKey()) return
    const r = await chat(key(), settings.chatModel, quick('Sagen Sie in einem Satz Hallo.'), { stream: false })
    phone.log(
      r.finishReason === 'length' ? 'fail' : 'ok',
      `3 Chat ${settings.chatModel}: ${ms(r.totalMs)}, ${costText(r.usage)}, Denken ${r.thinkingOff ? 'aus' : 'an'}, Ende: ${r.finishReason ?? '?'}: "${r.text}"`,
    )
  },
  async 'chat-stream'() {
    if (!requireKey()) return
    let deltas = 0
    const r = await chat(key(), settings.chatModel, quick('Zählen Sie von eins bis zehn in Worten.'), { onDelta: () => deltas++ })
    phone.log(
      r.streamed && deltas > 1 ? 'ok' : 'fail',
      `4 Stream: Antwort-Kopf nach ${ms(r.headersMs)}, erstes Token ${ms(r.firstTokenMs)}, gesamt ${ms(r.totalMs)}, ${deltas} Teile in ${r.reads} Lesevorgängen, Denken ${r.thinkingOff ? 'aus' : 'an'}, ${costText(r.usage)}`,
    )
  },
  async search() {
    if (!requireKey()) return
    const messages = [
      { role: 'system' as const, content: `${SEARCH_RULES}\n\nHeute ist ${germanNow()}.` },
      { role: 'user' as const, content: 'Was ist heute die wichtigste Nachricht in Deutschland? Ein Satz.' },
    ]
    const r = await chat(key(), settings.chatModel, messages, { stream: false, webSearch: true })
    const searched = searchCount(r.usage) > 0
    phone.log(
      searched ? 'ok' : 'fail',
      r.searchRefused
        ? `6 Websuche: ${settings.chatModel} kann keine Werkzeuge, bitte ein anderes Modell wählen`
        : `6 Websuche ${settings.chatModel}: ${searched ? 'gesucht' : 'nicht gesucht'}, ${ms(r.totalMs)}, ${costText(r.usage)}: "${sanitizeForGlasses(r.text)}"`,
    )
  },
}

let busy = false
let resetArmed = 0

// ---- Feasibility probes for the document library ---------------------------------------------

const PCLOUD_CLIENT_KEY = 'igor.pcloud.client'
// A function declaration, so the startup code above can use it before this line runs.
function plog(level: 'info' | 'ok' | 'fail', msg: string) {
  phone.log(level, msg)
}

function probeAction(name: string, data: Record<string, string>) {
  // The file dialogs must open inside the click, before any await.
  const pick = { 'probe:files': 'probeFiles', 'probe:folder': 'probeFolder', 'probe:pdf': 'probePdfFile' }[name]
  if (pick) {
    const input = document.getElementById(pick) as HTMLInputElement
    input.value = ''
    input.click()
    return
  }
  if (name === 'probe:picked') {
    const input = document.getElementById(data.id!) as HTMLInputElement
    void (async () => {
      const files = await describeSelection(input.files, data.id === 'probeFolder' ? 'Ordner' : 'Dateien', plog)
      const pdf = files.find(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
      if (pdf) await probePdf(pdf, plog)
      else if (data.id === 'probePdfFile') plog('fail', 'C: keine PDF-Datei ausgewählt')
    })()
    return
  }
  if (name === 'probe:storage') return void runBusy(() => probeStorage(kv, plog))
  if (name === 'probe:pcloud') return void runBusy(() => probePcloudApi(plog))
  if (name === 'probe:login') {
    const client = (document.getElementById('pcloudClient') as HTMLInputElement).value.trim()
    void kv.set(PCLOUD_CLIENT_KEY, client).finally(() => startPcloudLogin(client, plog))
  }
}

async function runBusy(fn: () => Promise<void>) {
  if (busy) return
  busy = true
  phone.setBusy(true)
  try {
    await fn()
  } catch (err) {
    plog('fail', describe(err))
  } finally {
    busy = false
    phone.setBusy(false)
  }
}

// ---- pCloud folder ----------------------------------------------------------------------------

let pcLogin: PcloudLogin | null = null
let pcCfg: SyncConfig | null = null
let pcBusy = false
let pcMessage = ''
/** Folder picker: the path of folders from the root to where the user is; null = picker closed. */
let pcBrowse: { stack: { id: number; name: string }[]; folders: FolderEntry[] } | null = null

function renderPc() {
  const when = pcCfg?.lastSync ? new Date(pcCfg.lastSync).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
  const idle = pcLogin
    ? `Angemeldet (${pcLogin.region}). ${pcCfg ? `Ordner: ${pcCfg.name}${when ? `, zuletzt abgeglichen ${when}` : ''}` : 'Noch kein Ordner gewählt.'}`
    : 'Nicht angemeldet. IGOR liest nur und verändert nichts bei pCloud.'
  phone.renderPcloud({
    loggedIn: !!pcLogin,
    message: pcMessage || idle,
    folder: pcCfg?.name,
    busy: pcBusy,
    browser: pcBrowse
      ? { path: pcBrowse.stack.map(s => s.name).join(' / '), folders: pcBrowse.folders, canUp: pcBrowse.stack.length > 1 }
      : null,
  })
}

async function pcloudStartup() {
  pcLogin = await restoreLogin(kv, plog)
  pcCfg = pcLogin ? await loadSyncConfig(kv) : null
  renderPc()
  if (pcLogin && pcCfg) {
    await libraryReady
    void syncNow()
  }
}

async function syncNow() {
  const login = pcLogin
  const folder = pcCfg
  if (!login || !folder || pcBusy) return
  pcBusy = true
  pcMessage = 'Gleiche ab …'
  renderPc()
  const t = performance.now()
  try {
    const report = await runSync(folder, {
      listTree: id => listTree(login, id),
      download: id => pcDownload(login, id),
      read: readBuffer,
      library,
      progress: m => ((pcMessage = m), renderPc()),
    })
    pcCfg = { ...folder, lastSync: Date.now() }
    await saveSyncConfig(kv, pcCfg)
    pcMessage = ''
    plog(report.failed.length ? 'fail' : 'ok', `pCloud ${folder.name}: ${describeReport(report)} (${ms(performance.now() - t)}, Referer: ${refererInUse()})`)
    for (const f of report.failed.slice(0, 8)) plog('fail', `   ${f}`)
    if (report.failed.length > 8) plog('fail', `   … und ${report.failed.length - 8} weitere`)
    for (const s of report.skipped) plog('info', `   übersprungen: ${s}`)
  } catch (err) {
    pcMessage = `Abgleich fehlgeschlagen: ${describe(err)}`
    plog('fail', `pCloud: ${describe(err)}`)
    if ((err as { code?: number }).code === 1000 || (err as { code?: number }).code === 2000) {
      pcLogin = null
      await forgetLogin(kv)
    }
  } finally {
    pcBusy = false
    renderPc()
  }
}

async function openBrowser(stack: { id: number; name: string }[]) {
  if (!pcLogin) return
  pcBusy = true
  renderPc()
  try {
    pcBrowse = { stack, folders: await listSubfolders(pcLogin, stack[stack.length - 1]!.id) }
  } catch (err) {
    pcBrowse = null
    pcMessage = describe(err)
    plog('fail', `pCloud: ${describe(err)}`)
  } finally {
    pcBusy = false
    renderPc()
  }
}

/** Downloads one file of the chosen folder by every route and logs what each one answered. */
async function testDownload() {
  const login = pcLogin
  const folder = pcCfg
  if (!login || !folder || pcBusy) return
  pcBusy = true
  pcMessage = 'Teste Download …'
  renderPc()
  try {
    const { files } = flatten(await listTree(login, folder.folderid), folder.name)
    const file = files.find(f => f.size < 200_000) ?? files[0]
    if (!file) throw new Error('Keine lesbare Datei im Ordner')
    plog('info', `pCloud-Test mit ${file.path} (${file.size} Bytes), Seite ${location.origin}${location.pathname}`)
    for (const r of await probeDownload(login, file.fileid)) plog(r.ok ? 'ok' : 'fail', `pCloud-Test: ${r.line}`)
  } catch (err) {
    plog('fail', `pCloud-Test: ${describe(err)}`)
  } finally {
    pcBusy = false
    pcMessage = 'Test fertig, Ergebnis im Protokoll (Diagnose).'
    renderPc()
  }
}

function pcloudAction(name: string, d: Record<string, string>): boolean {
  if (!name.startsWith('pc:')) return false
  const client = (document.getElementById('pcloudClient') as HTMLInputElement | null)?.value.trim() || DEFAULT_CLIENT_ID
  switch (name) {
    case 'pc:login': startPcloudLogin(client, plog); break
    case 'pc:logout':
      pcLogin = null
      pcCfg = null
      pcMessage = 'Abgemeldet. Bereits geladene Unterlagen bleiben erhalten.'
      void forgetLogin(kv)
      renderPc()
      break
    case 'pc:pick': void openBrowser([{ id: 0, name: 'pCloud' }]); break
    case 'pc:open': void openBrowser([...(pcBrowse?.stack ?? []), { id: Number(d.fid), name: d.fname! }]); break
    case 'pc:up': void openBrowser((pcBrowse?.stack ?? []).slice(0, -1)); break
    case 'pc:cancel':
      pcBrowse = null
      renderPc()
      break
    case 'pc:choose': {
      const here = pcBrowse?.stack[pcBrowse.stack.length - 1]
      pcBrowse = null
      if (here) {
        pcCfg = { folderid: here.id, name: here.name }
        pcMessage = ''
        void saveSyncConfig(kv, pcCfg).then(syncNow)
      }
      renderPc()
      break
    }
    case 'pc:sync': void syncNow(); break
    case 'pc:test': void testDownload(); break
  }
  return true
}

async function probeStartup() {
  try {
    ;(document.getElementById('pcloudClient') as HTMLInputElement).value = await kv.get(PCLOUD_CLIENT_KEY)
    await checkMarkers(kv, plog)
  } catch (err) {
    plog('fail', `Machbarkeit beim Start: ${describe(err)}`)
  }
}

async function onAction(name: string, data: Record<string, string>) {
  if (name === 'copy') {
    try {
      await navigator.clipboard.writeText(phone.logText())
      phone.log('info', 'Protokoll kopiert')
    } catch {
      phone.log('fail', 'Kopieren nicht erlaubt, bitte Text markieren oder Screenshot machen')
    }
    return
  }
  if (memoryAction(name, data)) return
  if (libraryAction(name, data)) return
  if (pcloudAction(name, data)) return
  if (name === 'ask') {
    const q = data.question?.trim()
    if (!q) return
    if (assistant.askText(q)) phone.clearQuestion()
    else phone.log('fail', 'IGOR ist gerade beschäftigt, bitte kurz warten')
    return
  }
  if (name === 'newChat') return assistant.newChat()
  if (name === 'persona:reset') return phone.resetPersona()
  if (name === 'mic') return voiceTest()
  if (name.startsWith('probe:')) return probeAction(name, data)

  if (busy) return
  busy = true
  phone.setBusy(true)
  try {
    if (name === 'save') await saveFromForm()
    else if (name === 'all') {
      for (const t of ['cors', 'key', 'chat-plain', 'chat-stream'] as const) {
        try {
          await tests[t]()
        } catch (err) {
          phone.log('fail', `${t}: ${describe(err)}`)
        }
      }
    } else if (name in tests) await tests[name as keyof typeof tests]()
  } catch (err) {
    phone.log('fail', `${name}: ${describe(err)}`)
  } finally {
    busy = false
    phone.setBusy(false)
  }
}

async function saveFromForm() {
  const next = phone.readSettings()
  if (!next.chatModel || !next.sttModel) return phone.log('fail', 'Bei „Andere …“ fehlt die Modell-ID')
  settings = next
  pinned.chat = pinned.stt = true
  const ok = await saveSettings(kv, settings)
  phone.log(ok ? 'ok' : 'fail', ok ? `Gespeichert (${kv.backend})` : 'Speichern fehlgeschlagen')
  updateInfo()
}

const BACKUP_FORMAT = 'igor-gedaechtnis'

/** Memory, topic and backup buttons. Returns true when the action was one of them. */
function memoryAction(name: string, d: Record<string, string>): boolean {
  const refuse = (r: { ok: boolean; reason?: string }) => {
    if (!r.ok) phone.log('fail', r.reason ?? 'Das ging nicht')
  }
  switch (name) {
    case 'note:add': {
      const r = store.update(m => addNote(m, d.text, d.topicId || null))
      if (r.ok) phone.clearInputs()
      else refuse(r)
      return true
    }
    case 'note:del':
      store.update(m => removeNote(m, d.id))
      return true
    case 'topic:add': {
      const r = store.update(m => createTopic(m, d.name))
      if (r.ok) phone.clearInputs()
      else refuse(r)
      return true
    }
    case 'topic:rename':
      refuse(store.update(m => renameTopic(m, d.id, d.name)))
      return true
    case 'topic:del':
      store.update(m => deleteTopic(m, d.id))
      void library.dropTopic(d.id)
      return true
    case 'topic:clearHistory':
      store.update(m => clearHistory(m, d.id))
      phone.log('info', 'Verlauf des Themas geleert')
      return true
    case 'topic:summary':
      store.update(m => setSummary(m, d.id, d.summary))
      phone.log('ok', 'Zusammenfassung gespeichert')
      return true
    case 'topic:select':
      assistant.switchTopic(d.id || null)
      return true
    case 'backup:export': {
      const text = JSON.stringify({ format: BACKUP_FORMAT, memory: JSON.parse(serializeMemory(store.memory)) }, null, 1)
      phone.backupText(text)
      void navigator.clipboard?.writeText(text).catch(() => {})
      phone.log('ok', 'Sicherung erzeugt (und in die Zwischenablage kopiert, falls erlaubt)')
      return true
    }
    case 'backup:import': {
      let json = d.backup
      try {
        const outer = JSON.parse(json)
        if (outer?.format === BACKUP_FORMAT) json = JSON.stringify(outer.memory)
      } catch {
        // fall through: parseMemory reports the problem
      }
      const parsed = parseMemory(json)
      if (!parsed) phone.log('fail', 'Die Sicherung ist nicht lesbar')
      else {
        store.replace(parsed)
        phone.log('ok', `Gedächtnis importiert: ${parsed.notes.length} Notizen, ${parsed.topics.length} Themen`)
      }
      return true
    }
    case 'memory:reset':
      if (Date.now() - resetArmed < 5000) {
        resetArmed = 0
        store.replace(selectTopic(emptyMemory(), null))
        phone.log('ok', 'Gedächtnis gelöscht')
      } else {
        resetArmed = Date.now()
        phone.log('info', 'Zum Löschen innerhalb von 5 Sekunden noch einmal tippen')
      }
      return true
  }
  return false
}

const VOICE_TEST_SECONDS = 5

/** Test 5: the same voice loop as a tap on the temple, started and stopped from the phone. */
function voiceTest() {
  if (assistant.state !== 'home') return phone.log('fail', 'IGOR ist gerade beschäftigt')
  phone.log('info', `Bitte jetzt sprechen, Aufnahme läuft ${VOICE_TEST_SECONDS} Sekunden …`)
  assistant.onGesture('tap')
  setTimeout(() => assistant.state === 'recording' && assistant.onGesture('tap'), VOICE_TEST_SECONDS * 1000)
}

// Kept for ad-hoc checks in the browser console.
Object.assign(window, { igor: { assistant, store, recordBrowserPcm } })

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
  chat, keyInfo, listModels, listTranscriptionModels, OpenRouterError, transcribe, type ChatMessage, type ModelInfo, type Usage,
} from './openrouter.ts'
import { DEFAULT_PERSONA } from './persona.ts'
import { mountPhone } from './phone.ts'
import { createKv, DEFAULT_SETTINGS, debouncedSave, loadSettings, MEMORY_KEY, saveSettings, type Settings } from './storage.ts'
import { clampUtf8, sanitizeForGlasses } from './text.ts'
import { withTimeout } from './timeout.ts'

const VERSION = '0.2.0'
let assistant: Assistant

const phone = mountPhone({
  action: (name, data) => void onAction(name, data),
  gesture: (g, index) => assistant?.onGesture(g, index),
})
phone.log('info', `IGOR ${VERSION} · ${navigator.userAgent}`)
// Fill the model lists right away; waiting for the bridge can take a couple of seconds.
phone.setChatChoices(resolveChoices(CHAT_SPECS, []), DEFAULT_SETTINGS.chatModel)
phone.setSttChoices(resolveChoices(STT_SPECS, []), DEFAULT_SETTINGS.sttModel)

const bridge = await connectBridge()
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

const glasses = bridge ? new Glasses(bridge, msg => phone.log('fail', msg)) : null
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
const persona = () => settings.persona.trim() || DEFAULT_PERSONA
const ms = (n: number) => `${Math.round(n)} ms`
const formatNote = (r: { format: string; fellBack: boolean }) => (r.fellBack ? `${r.format}, pcm abgelehnt` : r.format)

function costText(usage?: Usage): string {
  if (!usage) return ''
  const tokens = `${usage.prompt_tokens ?? '?'}+${usage.completion_tokens ?? '?'} Tokens`
  return typeof usage.cost === 'number' ? `${tokens}, ${usage.cost.toFixed(5)} $` : tokens
}

function describe(err: unknown): string {
  if (err instanceof OpenRouterError) return err.detail ? `${err.message} (${err.detail})` : err.message
  return (err as Error)?.message ?? String(err)
}

assistant = new Assistant({
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
    const r = await chat(key(), settings.chatModel, messages, { onDelta: onText, signal })
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
  const ok = await glasses.start('IGOR startet …')
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

const tests: Record<'cors' | 'key' | 'chat-plain' | 'chat-stream', () => Promise<void>> = {
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
}

let busy = false
let resetArmed = 0

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

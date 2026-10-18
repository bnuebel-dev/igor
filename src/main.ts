import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Glasses } from './glasses.ts'
import { createGestureFilter, gestureOf, type Gesture } from './events.ts'
import {
  chat,
  keyInfo,
  listModels,
  listTranscriptionModels,
  OpenRouterError,
  transcribe,
  type ChatMessage,
  type ModelInfo,
  type Usage,
} from './openrouter.ts'
import { CHAT_SPECS, resolveChoices, STT_SPECS, type Choice } from './catalog.ts'
import { recordBrowserPcm } from './browserMic.ts'
import { PcmRecorder } from './pcm.ts'
import { GREETING, PERSONA } from './persona.ts'
import { createStore, DEFAULT_SETTINGS, type Settings } from './storage.ts'
import { withTimeout } from './timeout.ts'
import { mountUi, type Action } from './ui.ts'

const HELP = 'Tippen: sprechen · Doppeltippen: beenden'
const MAX_RECORD_SECONDS = 30

const ui = mountUi(action => void handle(action))
ui.log('info', `IGOR 0.0.1 · ${navigator.userAgent}`)
// Fill the pickers right away; waiting for the bridge can take a couple of seconds.
ui.setChatChoices(resolveChoices(CHAT_SPECS, []), DEFAULT_SETTINGS.chatModel)
ui.setSttChoices(resolveChoices(STT_SPECS, []), DEFAULT_SETTINGS.sttModel)

const bridge = await connectBridge()
const store = createStore(bridge)
let settings: Settings = await store.load()
ui.write(settings)

// A model counts as chosen once the user has saved it; until then the first curated entry applies.
const pinned = { chat: settings.chatModel !== '', stt: settings.sttModel !== '' }

function showChat(models: ModelInfo[]): Choice[] {
  const choices = resolveChoices(CHAT_SPECS, models)
  ui.setChatChoices(choices, pinned.chat ? settings.chatModel : '')
  if (!pinned.chat) settings.chatModel = ui.read().chatModel
  return choices
}

function showStt(models: ModelInfo[]): Choice[] {
  const choices = resolveChoices(STT_SPECS, models, { fillRest: true })
  ui.setSttChoices(choices, pinned.stt ? settings.sttModel : '')
  if (!pinned.stt) settings.sttModel = ui.read().sttModel
  return choices
}

// Until the live catalog arrives (or if it cannot be loaded) show the built-in picks.
showChat([])
showStt([])

const glasses = bridge ? new Glasses(bridge, msg => ui.log('fail', msg)) : null
if (glasses) {
  const ok = await glasses.start(`IGOR\n\n${GREETING}\n\n${HELP}`)
  ui.setStatus(ok ? 'Brille verbunden' : 'Brille: Seite fehlt', ok ? 'ok' : 'fail')
  const device = await bridge!.getDeviceInfo().catch(() => null)
  if (device) ui.log('info', `Gerät: ${device.model}, Akku ${device.status?.batteryLevel ?? '?'} %`)
} else {
  ui.setStatus('Nur Browser, keine Brille', 'warn')
}

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
    ui.log('fail', (err as Error).message)
    return null
  }
}

async function loadModelLists() {
  try {
    const models = await listModels()
    const picks = showChat(models)
    ui.log('info', `Chat-Auswahl: ${picks.map(c => `${c.label}=${c.id}`).join(', ')}`)
    const audio = models.filter(m => m.inputModalities.includes('audio')).length
    ui.log('info', `${models.length} Chat-Modelle geladen, davon ${audio} mit Audio-Eingang`)
  } catch (err) {
    ui.log('fail', `Modellliste: ${describe(err)}`)
  }
  try {
    const stt = await listTranscriptionModels()
    const picks = showStt(stt)
    ui.log('info', `Sprach-Auswahl: ${picks.map(c => `${c.label}=${c.id}`).join(', ')}`)
    ui.log('info', `Spracherkennung: ${stt.length} Modelle gemeldet`)
  } catch (err) {
    ui.log('fail', `Liste Spracherkennung: ${describe(err)}`)
  }
}

function describe(err: unknown): string {
  if (err instanceof OpenRouterError) return err.detail ? `${err.message} (${err.detail})` : err.message
  return (err as Error)?.message ?? String(err)
}

function costText(usage?: Usage): string {
  if (!usage) return ''
  const tokens = `${usage.prompt_tokens ?? '?'}+${usage.completion_tokens ?? '?'} Tokens`
  return typeof usage.cost === 'number' ? `${tokens}, ${usage.cost.toFixed(5)} $` : tokens
}

const ms = (n: number) => `${Math.round(n)} ms`

// With the local mock API any sk-or- key is accepted, so tests run without a real key.
const MOCK_KEY = import.meta.env.VITE_OPENROUTER_API ? 'sk-or-mock' : ''

function needKey(): string | null {
  if (settings.apiKey || MOCK_KEY) return settings.apiKey || MOCK_KEY
  ui.log('fail', 'Kein API-Schlüssel gespeichert')
  return null
}

const tests: Record<'cors' | 'key' | 'chat-plain' | 'chat-stream', () => Promise<void>> = {
  async cors() {
    const t = performance.now()
    const models = await listModels()
    ui.log('ok', `1 Verbindung: ${models.length} Modelle in ${ms(performance.now() - t)}, CORS ok`)
  },
  async key() {
    const key = needKey()
    if (!key) return
    const info = await keyInfo(key)
    ui.log('ok', `2 Schlüssel gültig: ${info.label ?? 'ohne Namen'}, verbraucht ${info.usage ?? '?'} $`)
  },
  async 'chat-plain'() {
    const key = needKey()
    if (!key) return
    const r = await chat(key, settings.chatModel, persona('Sag in einem Satz Hallo.'), { stream: false })
    ui.log('ok', `3 Chat ${settings.chatModel}: ${ms(r.totalMs)}, ${costText(r.usage)}: "${r.text}"`)
  },
  async 'chat-stream'() {
    const key = needKey()
    if (!key) return
    let deltas = 0
    const r = await chat(key, settings.chatModel, persona('Zähle von eins bis zehn in Worten.'), {
      onDelta: () => deltas++,
    })
    ui.log(
      r.streamed && deltas > 1 ? 'ok' : 'fail',
      `4 Stream: erstes Token ${ms(r.firstTokenMs)}, gesamt ${ms(r.totalMs)}, ${deltas} Teile, ${costText(r.usage)}`,
    )
  },
}

function persona(question: string): ChatMessage[] {
  return [
    { role: 'system', content: PERSONA },
    { role: 'user', content: question },
  ]
}

async function testBrowserMic() {
  const key = needKey()
  if (!key) return
  ui.log('info', 'Bitte jetzt sprechen, Aufnahme läuft 4 Sekunden …')
  const pcm = await recordBrowserPcm(4, () => ui.setStatus('Aufnahme läuft …', 'warn'))
  ui.setStatus(glasses ? 'Brille verbunden' : 'Nur Browser, keine Brille', glasses ? 'ok' : 'warn')
  ui.log('info', `Aufnahme: ${(pcm.length / 32000).toFixed(1)} s, ${pcm.length} Bytes (16 kHz, mono)`)
  const stt = await transcribe(key, settings.sttModel, pcm, { format: settings.sttFormat, language: settings.language || undefined })
  ui.log('ok', `5 Spracherkennung ${settings.sttModel} (${settings.sttFormat}): ${ms(stt.totalMs)}, "${stt.text}"`)
}

let busy = false

async function handle(action: Action) {
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(ui.logText())
      ui.log('info', 'Protokoll kopiert')
    } catch {
      ui.log('fail', 'Kopieren nicht erlaubt, bitte Text markieren')
    }
    return
  }
  if (busy) return
  busy = true
  ui.setBusy(true)
  try {
    if (action === 'save') {
      const next = ui.read()
      if (!next.chatModel || !next.sttModel) {
        ui.log('fail', 'Bei „Andere …“ fehlt die Modell-ID')
        return
      }
      settings = next
      pinned.chat = pinned.stt = true
      const ok = await store.save(settings)
      ui.log(ok ? 'ok' : 'fail', ok ? `Gespeichert (${store.backend})` : 'Speichern fehlgeschlagen')
    } else if (action === 'all') {
      for (const name of ['cors', 'key', 'chat-plain', 'chat-stream'] as const) {
        try {
          await tests[name]()
        } catch (err) {
          ui.log('fail', `${name}: ${describe(err)}`)
        }
      }
    } else if (action === 'mic') {
      await testBrowserMic()
    } else if (action === 'ask') {
      const q = ui.question()
      if (q) await answer(q)
    } else {
      await tests[action]()
    }
  } catch (err) {
    ui.log('fail', `${action}: ${describe(err)}`)
  } finally {
    busy = false
    ui.setBusy(false)
  }
}

// ---- Glasses: voice loop ---------------------------------------------------

type Mode = 'idle' | 'recording' | 'stopping' | 'thinking'
let mode: Mode = 'idle'
let recorder = new PcmRecorder(MAX_RECORD_SECONDS)
let recordStarted = 0
let tickTimer: ReturnType<typeof setInterval> | null = null
let exitRequested = false

async function startRecording() {
  if (!glasses || mode !== 'idle') return
  recorder = new PcmRecorder(MAX_RECORD_SECONDS)
  mode = 'recording'
  recordStarted = performance.now()
  glasses.show('Ich höre, Boss…\n\nTippen: senden · Doppeltippen: abbrechen')
  const ok = await glasses.mic(true)
  ui.log(ok ? 'info' : 'fail', ok ? 'Mikrofon an' : 'Mikrofon ließ sich nicht einschalten')
  if (!ok) return resetIdle('Mikrofon streikt, Boss.')
  tickTimer = setInterval(() => {
    if (recorder.full) return void stopRecording()
    glasses.show(`Ich höre, Boss… ${recorder.seconds.toFixed(1)} s\n\nTippen: senden · Doppeltippen: abbrechen`)
  }, 1000)
}

async function stopRecording(cancel = false) {
  if (!glasses || mode !== 'recording') return
  // Leave 'recording' before the first await so a second stop event is ignored.
  mode = 'stopping'
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  await glasses.mic(false)
  const wall = (performance.now() - recordStarted) / 1000
  const pcm = recorder.take()
  ui.log('info', `Aufnahme: ${(pcm.length / 32000).toFixed(1)} s Audio in ${wall.toFixed(1)} s, ${pcm.length} Bytes`)
  if (cancel) return resetIdle('Abgebrochen, Boss.')
  if (pcm.length < 16000) return resetIdle('Nichts gehört, Boss.')
  mode = 'thinking'
  glasses.show('Moment, Boss…')
  const key = needKey()
  if (!key) return resetIdle('Kein Schlüssel hinterlegt, Boss. Bitte am Handy eintragen.')
  try {
    const stt = await transcribe(key, settings.sttModel, pcm, {
      format: settings.sttFormat,
      language: settings.language || undefined,
    })
    ui.log('ok', `5 Spracherkennung ${settings.sttModel} (${settings.sttFormat}): ${ms(stt.totalMs)}, "${stt.text}"`)
    if (!stt.text) return resetIdle('Ich habe nichts verstanden, Boss.')
    mode = 'idle'
    await answer(stt.text)
  } catch (err) {
    ui.log('fail', `5 Spracherkennung: ${describe(err)}`)
    resetIdle(`Fehler, Boss: ${(err as Error).message}`)
  }
}

function resetIdle(text: string) {
  mode = 'idle'
  glasses?.show(`${text}\n\n${HELP}`)
}

async function answer(question: string) {
  const key = needKey()
  if (!key) return
  mode = 'thinking'
  const head = `Du: ${question}\n\n`
  glasses?.show(`${head}Moment, Boss…`)
  try {
    const r = await chat(key, settings.chatModel, persona(question), {
      onDelta: text => glasses?.show(head + text),
    })
    glasses?.show(`${head}${r.text}\n\n${HELP}`)
    ui.log('ok', `Antwort ${settings.chatModel}: erstes Token ${ms(r.firstTokenMs)}, gesamt ${ms(r.totalMs)}, ${costText(r.usage)}`)
    ui.log('info', `IGOR: ${r.text}`)
  } catch (err) {
    ui.log('fail', `Antwort: ${describe(err)}`)
    glasses?.show(`Fehler, Boss: ${(err as Error).message}\n\n${HELP}`)
  } finally {
    mode = 'idle'
  }
}

if (bridge && glasses) {
  const accept = createGestureFilter({ foreground: 600, background: 600, exit: 600, 'scroll-up': 300, 'scroll-down': 300 })
  const off = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm) {
      if (mode === 'recording') recorder.push(pcm)
      return
    }
    const gesture = gestureOf(event)
    if (!gesture || !accept(gesture)) return
    onGesture(gesture)
  })

  function onGesture(g: Gesture) {
    // The exit dialog inverts the lifecycle events: foreground when it opens, background on "No".
    if (exitRequested && (g === 'foreground' || g === 'background')) {
      if (g === 'background') {
        exitRequested = false
        resetIdle(GREETING)
      }
      return
    }
    switch (g) {
      case 'tap':
        if (mode === 'idle') void startRecording()
        else if (mode === 'recording') void stopRecording()
        break
      case 'long-press':
        if (mode === 'idle') void startRecording()
        break
      case 'long-release':
        if (mode === 'recording') void stopRecording()
        break
      case 'double-tap':
        if (mode === 'recording') void stopRecording(true)
        else if (mode === 'idle') {
          exitRequested = true
          void glasses!.requestExit()
        }
        break
      case 'background':
        if (mode === 'recording') void stopRecording(true)
        break
      case 'exit':
        if (tickTimer) clearInterval(tickTimer)
        void glasses!.mic(false)
        off()
        break
      default:
        break
    }
    ui.log('info', `Geste: ${g}`)
  }
}

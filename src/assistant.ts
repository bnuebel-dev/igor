import type { Choice } from './catalog.ts'
import { friendlyError } from './errors.ts'
import type { Gesture } from './events.ts'
import { extractProposal, parseCommand, visibleWhileStreaming } from './marker.ts'
import {
  addNote, appendTurns, clearHistory, createTopic, currentTopic, findTopic, isDuplicateNote, selectTopic, setSummary,
  topicById, type MemoryStore, type Turn,
} from './memory.ts'
import type { ChatMessage } from './openrouter.ts'
import { pageFooter, paginate, type LineCounter } from './pager.ts'
import { PcmRecorder } from './pcm.ts'
import type { Passage } from './library.ts'
import { GREETING } from './persona.ts'
import { buildMessages, summaryMessages } from './prompt.ts'

/** What the controller needs from the glasses. */
export interface Port {
  showText(text: string): void
  showList(title: string, items: string[]): void
  mic(on: boolean): Promise<boolean>
  requestExit(): void
}

export interface Deps {
  port: Port
  store: MemoryStore
  persona(): string
  hasKey(): boolean
  /** The ten favourites shown in the glasses menu. */
  models(): Choice[]
  currentModel(): string
  pickModel(id: string): void
  transcribe(pcm: Uint8Array, signal: AbortSignal): Promise<string>
  /** Streams the answer; resolves with the complete text. */
  ask(messages: ChatMessage[], onText: (soFar: string) => void, signal: AbortSignal): Promise<string>
  /** Passages from the user's documents that match the question; omitted when there is no library. */
  findPassages?(query: string, topicId: string | null): Passage[]
  /** Non-streaming helper call, used for topic summaries. */
  complete(messages: ChatMessage[]): Promise<string>
  measure: LineCounter
  log(level: 'info' | 'ok' | 'fail', msg: string): void
  /** Called with every finished exchange, for the transcript on the phone. */
  onExchange?(question: string, answer: string): void
  /** Called whenever the visible state changes (phone status line). */
  onChange?(): void
  now?(): Date
  maxRecordSeconds?: number
}

export type State =
  | 'home' | 'recording' | 'transcribing' | 'thinking' | 'answer' | 'proposal' | 'menu' | 'topics' | 'models' | 'notes'

type Purpose = 'question' | 'topicName'

const MIN_PCM_BYTES = 16_000 // half a second
const TICK_MS = 1000
const MAIN_MENU = ['Neuer Chat', 'Thema wählen', 'Modell wählen', 'Notizen ansehen', 'Beenden']

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export class Assistant {
  state: State = 'home'
  private recorder = new PcmRecorder(30)
  private recordMode: 'tap' | 'hold' = 'tap'
  private purpose: Purpose = 'question'
  private tick: ReturnType<typeof setInterval> | null = null
  private abort: AbortController | null = null
  private pages: string[] = ['']
  private pageIndex = 0
  private proposal: string | null = null
  private general: Turn[] = []
  private topicIds: (string | null)[] = []
  private summarizing = new Set<string>()

  constructor(private readonly d: Deps) {}

  // ---- Public API ---------------------------------------------------------------------------

  start() {
    this.showHome()
  }

  get topicName(): string | null {
    return currentTopic(this.d.store.memory)?.name ?? null
  }

  get busy(): boolean {
    return this.state === 'recording' || this.state === 'transcribing' || this.state === 'thinking'
  }

  /** PCM chunks from the glasses microphone. */
  onPcm(chunk: Uint8Array) {
    if (this.state === 'recording') this.recorder.push(chunk)
  }

  /** A question typed on the phone; handled like a spoken one. */
  askText(text: string): boolean {
    if (this.busy || !text.trim()) return false
    void this.handleUtterance(text.trim())
    return true
  }

  newChat() {
    this.leaveTopicContext()
    this.general = []
    const t = currentTopic(this.d.store.memory)
    if (t) this.d.store.update(m => clearHistory(m, t.id))
    this.showHome('Neuer Chat, Boss.')
  }

  switchTopic(id: string | null) {
    this.leaveTopicContext()
    this.general = []
    this.d.store.update(m => selectTopic(m, id))
    const name = this.topicName
    this.showHome(name ? `Thema „${name}“, Boss.` : 'Kein Thema, Boss.')
  }

  /** Draw the current screen again, for example after the host cleared the page. */
  refresh() {
    switch (this.state) {
      case 'answer': return this.renderAnswer()
      case 'notes': return this.renderNotes()
      case 'proposal': return this.showProposal()
      case 'menu': return this.openMenu()
      case 'topics': return this.openTopics()
      case 'models': return this.openModels()
      case 'recording': return this.renderRecording(0, this.purpose)
      case 'transcribing':
      case 'thinking': return this.d.port.showText('Moment, Boss…')
      default: return this.showHome()
    }
  }

  /** The app moved to the background: stop listening. */
  onBackground() {
    if (this.state === 'recording') void this.stopRecording(true)
  }

  shutdown() {
    this.clearTick()
    this.abort?.abort()
    void this.d.port.mic(false)
  }

  onGesture(g: Gesture, listIndex?: number) {
    this.d.log('info', `Geste: ${g} (${this.state})`)
    switch (this.state) {
      case 'home': return this.gestureHome(g)
      case 'recording': return this.gestureRecording(g)
      case 'transcribing':
      case 'thinking': return this.gestureBusy(g)
      case 'answer': return this.gestureAnswer(g)
      case 'proposal': return this.gestureProposal(g)
      case 'menu':
      case 'topics':
      case 'models': return this.gestureList(g, listIndex ?? 0)
      case 'notes': return this.gestureNotes(g)
    }
  }

  // ---- Gestures per screen --------------------------------------------------------------------

  private gestureHome(g: Gesture) {
    if (g === 'tap') void this.startRecording('question', 'tap')
    else if (g === 'long-press') void this.startRecording('question', 'hold')
    else if (g === 'scroll-down') this.openMenu()
    else if (g === 'double-tap') this.d.port.requestExit() // root page: the exit dialog is required
  }

  private gestureRecording(g: Gesture) {
    if (g === 'tap' && this.recordMode === 'tap') void this.stopRecording(false)
    else if (g === 'long-release' && this.recordMode === 'hold') void this.stopRecording(false)
    else if (g === 'double-tap') void this.stopRecording(true)
  }

  private gestureBusy(g: Gesture) {
    if (g !== 'double-tap') return
    this.abort?.abort()
    this.showHome('Abgebrochen, Boss.')
  }

  private gestureAnswer(g: Gesture) {
    if (g === 'scroll-down') {
      if (this.pageIndex < this.pages.length - 1) {
        this.pageIndex++
        this.renderAnswer()
      } else if (this.proposal) this.showProposal()
    } else if (g === 'scroll-up') {
      if (this.pageIndex > 0) {
        this.pageIndex--
        this.renderAnswer()
      }
    } else if (g === 'tap') {
      this.proposal = null
      void this.startRecording('question', 'tap')
    } else if (g === 'double-tap') {
      this.proposal = null
      this.showHome()
    }
  }

  private gestureProposal(g: Gesture) {
    if (g === 'tap') this.acceptProposal()
    else if (g === 'double-tap') {
      this.proposal = null
      this.state = 'answer'
      this.pageIndex = this.pages.length - 1
      this.renderAnswer()
    } else if (g === 'scroll-up') {
      this.state = 'answer'
      this.renderAnswer()
    }
  }

  private gestureNotes(g: Gesture) {
    if (g === 'scroll-down' && this.pageIndex < this.pages.length - 1) {
      this.pageIndex++
      this.renderNotes()
    } else if (g === 'scroll-up' && this.pageIndex > 0) {
      this.pageIndex--
      this.renderNotes()
    } else if (g === 'double-tap' || g === 'tap') this.openMenu()
  }

  private gestureList(g: Gesture, index: number) {
    if (g === 'double-tap') {
      if (this.state === 'menu') this.showHome()
      else this.openMenu()
      return
    }
    if (g !== 'tap') return // scrolling the list is handled by the glasses themselves
    if (this.state === 'menu') this.pickMenu(index)
    else if (this.state === 'topics') this.pickTopic(index)
    else this.pickModel(index)
  }

  // ---- Home and menu --------------------------------------------------------------------------

  private showHome(message?: string) {
    this.clearTick()
    this.state = 'home'
    this.proposal = null
    const model = this.d.models().find(m => m.id === this.d.currentModel())?.text ?? this.d.currentModel()
    this.d.port.showText(
      [
        `IGOR · ${this.topicName ?? 'kein Thema'}`,
        clip(model, 40),
        '',
        clip(message ?? GREETING, 150),
        '',
        'Tippen: sprechen',
        '▼ Wischen: Menü',
        'Doppeltippen: beenden',
      ].join('\n'),
    )
    this.d.onChange?.()
  }

  private openMenu() {
    this.state = 'menu'
    this.d.port.showList('Menü', MAIN_MENU)
    this.d.onChange?.()
  }

  private pickMenu(i: number) {
    switch (MAIN_MENU[i]) {
      case 'Neuer Chat': return this.newChat()
      case 'Thema wählen': return this.openTopics()
      case 'Modell wählen': return this.openModels()
      case 'Notizen ansehen': return this.openNotes()
      case 'Beenden': return this.d.port.requestExit()
    }
  }

  private openTopics() {
    const mem = this.d.store.memory
    this.topicIds = [null, ...mem.topics.map(t => t.id), 'new']
    const items = [
      `${mem.currentTopicId === null ? '● ' : ''}Kein Thema`,
      ...mem.topics.map(t => `${t.id === mem.currentTopicId ? '● ' : ''}${t.name}`),
      '+ Neues Thema (sprechen)',
    ]
    this.state = 'topics'
    this.d.port.showList('Thema wählen', items)
  }

  private pickTopic(i: number) {
    const id = this.topicIds[i]
    if (id === undefined) return
    if (id === 'new') {
      void this.startRecording('topicName', 'tap')
      return
    }
    this.switchTopic(id)
  }

  private openModels() {
    const cur = this.d.currentModel()
    this.state = 'models'
    this.d.port.showList(
      'Modell wählen',
      this.d.models().map(m => `${m.id === cur ? '● ' : ''}${m.text}`),
    )
  }

  private pickModel(i: number) {
    const choice = this.d.models()[i]
    if (!choice) return
    this.d.pickModel(choice.id)
    this.showHome(`Modell: ${choice.text}`)
  }

  private openNotes() {
    const mem = this.d.store.memory
    const topic = currentTopic(mem)
    const lines: string[] = []
    if (mem.notes.length) lines.push('Allgemein:', ...mem.notes.map(n => `- ${n.text}`))
    if (topic?.summary) lines.push('', `Stand ${topic.name}:`, topic.summary)
    if (topic?.notes.length) lines.push('', `Notizen ${topic.name}:`, ...topic.notes.map(n => `- ${n.text}`))
    this.pages = paginate(lines.length ? lines.join('\n') : 'Noch nichts gemerkt, Boss.', this.d.measure)
    this.pageIndex = 0
    this.state = 'notes'
    this.renderNotes()
  }

  private renderNotes() {
    const footer = pageFooter(this.pageIndex, this.pages.length, 'Tippen: zurück')
    this.d.port.showText(`${this.pages[this.pageIndex]}\n${footer}`)
  }

  // ---- Recording ------------------------------------------------------------------------------

  private async startRecording(purpose: Purpose, mode: 'tap' | 'hold') {
    if (this.busy) return
    if (!this.d.hasKey()) {
      this.showHome('Kein Schlüssel hinterlegt, Boss. Bitte am Handy eintragen.')
      return
    }
    this.purpose = purpose
    this.recordMode = mode
    this.recorder = new PcmRecorder(this.d.maxRecordSeconds ?? 30)
    this.state = 'recording' // set before the first await so a second gesture cannot start another recording
    const started = Date.now()
    this.renderRecording(0, purpose)
    const ok = await this.d.port.mic(true)
    if (!ok) {
      this.showHome('Das Mikrofon streikt, Boss.')
      return
    }
    this.d.onChange?.()
    this.tick = setInterval(() => {
      if (this.state !== 'recording') return this.clearTick()
      if (this.recorder.full) return void this.stopRecording(false)
      this.renderRecording((Date.now() - started) / 1000, purpose)
    }, TICK_MS)
  }

  private renderRecording(seconds: number, purpose: Purpose) {
    const what = purpose === 'topicName' ? 'Wie soll das Thema heißen, Boss?' : 'Ich höre, Boss…'
    const how = this.recordMode === 'hold' ? 'Loslassen: senden' : 'Tippen: senden'
    this.d.port.showText(`${what} ${seconds >= 1 ? `${Math.floor(seconds)} s` : ''}\n\n${how}\nDoppeltippen: abbrechen`)
  }

  private clearTick() {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
  }

  private async stopRecording(cancel: boolean) {
    if (this.state !== 'recording') return
    this.state = 'transcribing' // leave 'recording' before the first await
    this.clearTick()
    await this.d.port.mic(false)
    const pcm = this.recorder.take()
    if (cancel) return this.showHome('Abgebrochen, Boss.')
    if (pcm.length < MIN_PCM_BYTES) return this.showHome('Nichts gehört, Boss.')

    this.d.port.showText('Moment, Boss…')
    this.d.onChange?.()
    this.abort = new AbortController()
    try {
      const text = (await this.d.transcribe(pcm, this.abort.signal)).trim()
      if (this.state !== 'transcribing') return // cancelled meanwhile
      if (!text) return this.showHome('Ich habe nichts verstanden, Boss.')
      this.d.log('ok', `Erkannt: "${text}"`)
      if (this.purpose === 'topicName') this.nameTopic(text)
      else await this.handleUtterance(text)
    } catch (err) {
      if (this.state !== 'transcribing') return
      this.d.log('fail', `Spracherkennung: ${(err as Error).message}`)
      this.showHome(friendlyError(err))
    }
  }

  // ---- Utterances: commands, then the model -----------------------------------------------------

  private nameTopic(spoken: string) {
    const name = spoken.replace(/^thema\s*[:,]?\s*/i, '').replace(/[.!?]+$/, '').trim()
    this.useTopic(name)
  }

  private useTopic(name: string) {
    const mem = this.d.store.memory
    const existing = findTopic(mem, name)
    if (existing) return this.switchTopic(existing.id)
    const r = this.d.store.update(m => createTopic(m, name))
    if (!r.ok) return this.showHome(`${r.reason}, Boss.`)
    this.switchTopic(r.value.id)
  }

  private async handleUtterance(text: string) {
    const cmd = parseCommand(text)
    if (cmd?.type === 'remember') {
      const topicId = this.d.store.memory.currentTopicId
      const r = this.d.store.update(m => addNote(m, cmd.text, topicId))
      this.showHome(r.ok ? `Gemerkt, Boss: ${clip(cmd.text, 90)}` : r.reason === 'Schon gemerkt' ? 'Das wusste ich schon, Boss.' : `${r.reason}, Boss.`)
      return
    }
    if (cmd?.type === 'topic') {
      if (cmd.name === null) return this.switchTopic(null)
      return this.useTopic(cmd.name)
    }
    if (cmd?.type === 'newChat') return this.newChat()
    await this.ask(text)
  }

  private currentHistory(): Turn[] {
    return currentTopic(this.d.store.memory)?.history ?? this.general
  }

  private async ask(question: string) {
    this.state = 'thinking'
    this.d.onChange?.()
    const head = `Sie: ${clip(question, 90)}\n\n`
    this.d.port.showText(`${head}Moment, Boss…`)
    this.abort = new AbortController()
    const signal = this.abort.signal
    const history = this.currentHistory()
    // A follow-up like "und die Kaution?" has few keywords of its own, so the previous question helps the search.
    const lastQuestion = [...history].reverse().find(t => t.role === 'user')?.content ?? ''
    const passages = this.d.findPassages?.(`${question} ${lastQuestion}`.trim(), this.d.store.memory.currentTopicId) ?? []
    if (passages.length) this.d.log('info', `Unterlagen: ${passages.map(p => p.source).join(' · ')}`)
    const messages = buildMessages({
      persona: this.d.persona(),
      memory: this.d.store.memory,
      history,
      question,
      now: this.d.now?.(),
      passages,
    })
    try {
      const full = await this.d.ask(
        messages,
        soFar => {
          if (this.state !== 'thinking') return
          // While the answer is being written, show its newest lines.
          const visible = visibleWhileStreaming(soFar)
          const tail = visible.length > 420 ? visible.slice(visible.indexOf(' ', visible.length - 420) + 1) : visible
          const pages = paginate(tail, this.d.measure)
          this.d.port.showText(`${pages[pages.length - 1]}\n… schreibt`)
        },
        signal,
      )
      if (this.state !== 'thinking') return // cancelled meanwhile
      this.finishAnswer(question, full)
    } catch (err) {
      if (this.state !== 'thinking') return
      this.d.log('fail', `Antwort: ${(err as Error).message}`)
      this.showHome(friendlyError(err))
    }
  }

  private finishAnswer(question: string, full: string) {
    const { visible, proposal } = extractProposal(full)
    if (!visible) return this.showHome('Dazu fällt mir nichts ein, Boss.')

    const mem = this.d.store.memory
    const topic = currentTopic(mem)
    const known = [...mem.notes, ...(topic?.notes ?? [])]
    this.proposal = proposal && !isDuplicateNote(known, proposal) ? proposal : null

    const turns: Turn[] = [
      { role: 'user', content: question },
      { role: 'assistant', content: visible },
    ]
    if (topic) {
      this.d.store.update(m => appendTurns(m, topic.id, turns))
      const after = topicById(this.d.store.memory, topic.id)
      if (after && after.sinceSummary >= 3) void this.refreshSummary(topic.id)
    } else this.general = [...this.general, ...turns].slice(-16)

    this.d.onExchange?.(question, visible)
    this.pages = paginate(visible, this.d.measure)
    this.pageIndex = 0
    this.state = 'answer'
    this.renderAnswer()
    this.d.onChange?.()
  }

  private renderAnswer() {
    const last = this.pageIndex === this.pages.length - 1
    const hint = last && this.proposal ? 'Tippen: Frage  ▼ Merken?' : 'Tippen: Frage'
    this.d.port.showText(`${this.pages[this.pageIndex]}\n${pageFooter(this.pageIndex, this.pages.length, hint)}`)
  }

  // ---- Memory proposals -------------------------------------------------------------------------

  private showProposal() {
    this.state = 'proposal'
    const topic = this.topicName
    this.d.port.showText(
      `Merken${topic ? ` (${clip(topic, 20)})` : ''}, Boss?\n\n„${clip(this.proposal ?? '', 200)}“\n\nTippen: Ja · Doppeltippen: Nein`,
    )
  }

  private acceptProposal() {
    const text = this.proposal
    this.proposal = null
    if (!text) return this.showHome()
    const topicId = this.d.store.memory.currentTopicId
    const r = this.d.store.update(m => addNote(m, text, topicId))
    this.showHome(r.ok ? 'Gemerkt, Boss.' : r.reason === 'Schon gemerkt' ? 'Das wusste ich schon, Boss.' : `${r.reason}, Boss.`)
  }

  // ---- Topic summaries ---------------------------------------------------------------------------

  /** Before leaving a topic, fold what was said since the last summary into it. */
  private leaveTopicContext() {
    const t = currentTopic(this.d.store.memory)
    if (t && t.sinceSummary > 0) void this.refreshSummary(t.id)
  }

  private async refreshSummary(topicId: string) {
    if (this.summarizing.has(topicId)) return
    const topic = topicById(this.d.store.memory, topicId)
    if (!topic || topic.sinceSummary < 1) return
    this.summarizing.add(topicId)
    try {
      const fresh = topic.history.slice(-topic.sinceSummary * 2)
      const text = (await this.d.complete(summaryMessages(topic.name, topic.summary, fresh))).trim()
      if (text) {
        this.d.store.update(m => setSummary(m, topicId, text))
        this.d.log('ok', `Zusammenfassung „${topic.name}“ aktualisiert`)
      }
    } catch (err) {
      this.d.log('fail', `Zusammenfassung „${topic.name}“: ${(err as Error).message}`)
    } finally {
      this.summarizing.delete(topicId)
    }
  }
}

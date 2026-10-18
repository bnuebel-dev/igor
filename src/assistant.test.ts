import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureTextWrap } from '@evenrealities/pretext'
import { Assistant, type Deps } from './assistant.ts'
import type { Choice } from './catalog.ts'
import { addNote, createTopic, emptyMemory, MemoryStore, topicById } from './memory.ts'
import { OpenRouterError, type ChatMessage } from './openrouter.ts'
import { pageFooter } from './pager.ts'
import { DEFAULT_PERSONA } from './persona.ts'

const MODELS: Choice[] = [
  { id: 'google/gemini-3.8-flash', label: 'Gemini Flash', tag: 'schnell', text: 'Gemini Flash (schnell)' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku', tag: 'schnell', text: 'Claude Haiku (schnell)' },
]

/** 20 characters per line, explicit line breaks respected: enough to test paging without the font tables. */
const lines20 = (text: string): number => {
  let n = 0
  for (const para of text.split('\n')) {
    n++
    let line = 0
    for (const w of para.split(' ')) {
      if (line === 0) line = w.length
      else if (line + 1 + w.length <= 20) line += 1 + w.length
      else {
        n++
        line = w.length
      }
    }
  }
  return n
}

const SPEECH = new Uint8Array(32_000) // one second
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

type Rig = ReturnType<typeof rig>
function rig(over: Partial<Deps> = {}) {
  const screens: string[] = []
  const lists: { title: string; items: string[] }[] = []
  const asked: ChatMessage[][] = []
  const state = { model: MODELS[0]!.id, key: true, exits: 0, micOn: false, exchanges: [] as [string, string][], answer: 'Zu Befehl, Boss.' }
  const store = new MemoryStore(emptyMemory(), () => {})
  const deps: Deps = {
    port: {
      showText: t => void screens.push(t),
      showList: (title, items) => void lists.push({ title, items }),
      mic: async on => ((state.micOn = on), true),
      requestExit: () => void state.exits++,
    },
    store,
    persona: () => DEFAULT_PERSONA,
    hasKey: () => state.key,
    models: () => MODELS,
    currentModel: () => state.model,
    pickModel: id => void (state.model = id),
    transcribe: async () => 'Wie spät ist es?',
    ask: async (messages, onText) => {
      asked.push(messages)
      onText(state.answer.slice(0, 10))
      return state.answer
    },
    complete: async () => 'Neue Zusammenfassung.',
    measure: lines20,
    log: () => {},
    onExchange: (q, a) => void state.exchanges.push([q, a]),
    now: () => new Date('2026-10-18T15:14:00Z'),
    ...over,
  }
  const a = new Assistant(deps)
  a.start()
  return { a, store, screens, lists, asked, state, last: () => screens[screens.length - 1]! }
}

/** Speak one utterance with a tap: tap, audio, tap, wait for the answer. */
async function speak(r: Rig) {
  r.a.onGesture('tap')
  await flush()
  r.a.onPcm(SPEECH)
  r.a.onGesture('tap')
  await flush()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('home', () => {
  it('greets, shows topic and model, and hints the gestures', () => {
    const r = rig()
    expect(r.last()).toContain('IGOR · kein Thema')
    expect(r.last()).toContain('Gemini Flash (schnell)')
    expect(r.last()).toContain('Zu Diensten, Boss.')
    expect(r.last()).toContain('Wischen: Menü')
  })

  it('opens the exit dialog on a double tap (Even Hub review requirement)', () => {
    const r = rig()
    r.a.onGesture('double-tap')
    expect(r.state.exits).toBe(1)
  })

  it('refuses to listen without a key and says so', () => {
    const r = rig()
    r.state.key = false
    r.a.onGesture('tap')
    expect(r.last()).toContain('Kein Schlüssel hinterlegt')
    expect(r.a.state).toBe('home')
  })
})

describe('asking by voice', () => {
  it('records, recognizes, answers and shows the answer with a footer', async () => {
    const r = rig()
    r.a.onGesture('tap')
    await flush()
    expect(r.a.state).toBe('recording')
    expect(r.state.micOn).toBe(true)
    expect(r.last()).toContain('Ich höre, Boss')
    r.a.onPcm(SPEECH)
    r.a.onGesture('tap')
    await flush()
    expect(r.state.micOn).toBe(false)
    expect(r.a.state).toBe('answer')
    expect(r.last()).toBe('Zu Befehl, Boss.\nTippen: Frage')
    expect(r.state.exchanges).toEqual([['Wie spät ist es?', 'Zu Befehl, Boss.']])
    expect(r.screens.some(s => s.includes('Moment, Boss'))).toBe(true)
  })

  it('shows the newest lines while the answer is being written', async () => {
    const r = rig()
    await speak(r)
    expect(r.screens.some(s => s.endsWith('… schreibt'))).toBe(true)
  })

  it('works with push-to-talk: hold to speak, release to send', async () => {
    const r = rig()
    r.a.onGesture('long-press')
    await flush()
    expect(r.last()).toContain('Loslassen: senden')
    r.a.onPcm(SPEECH)
    r.a.onGesture('tap') // a stray tap while holding must not end the recording
    expect(r.a.state).toBe('recording')
    r.a.onGesture('long-release')
    await flush()
    expect(r.a.state).toBe('answer')
  })

  it('ignores a recording that is too short', async () => {
    const r = rig()
    r.a.onGesture('tap')
    await flush()
    r.a.onPcm(new Uint8Array(1000))
    r.a.onGesture('tap')
    await flush()
    expect(r.last()).toContain('Nichts gehört')
    expect(r.a.state).toBe('home')
  })

  it('cancels a recording on a double tap without asking anything', async () => {
    const r = rig()
    r.a.onGesture('tap')
    await flush()
    r.a.onPcm(SPEECH)
    r.a.onGesture('double-tap')
    await flush()
    expect(r.last()).toContain('Abgebrochen')
    expect(r.asked).toHaveLength(0)
  })

  it('stops by itself at the maximum length', async () => {
    const r = rig({ maxRecordSeconds: 3 })
    r.a.onGesture('tap')
    await flush()
    r.a.onPcm(new Uint8Array(32_000 * 4)) // more than allowed: the recorder caps it
    await vi.advanceTimersByTimeAsync(1100)
    await flush()
    expect(r.a.state).toBe('answer')
  })

  it('cancels a pending answer on a double tap and ignores the late result', async () => {
    let finish: (t: string) => void = () => {}
    const r = rig({ ask: () => new Promise<string>(res => (finish = res)) })
    r.a.onGesture('tap')
    await flush()
    r.a.onPcm(SPEECH)
    r.a.onGesture('tap')
    await flush()
    expect(r.a.state).toBe('thinking')
    r.a.onGesture('double-tap')
    expect(r.last()).toContain('Abgebrochen')
    finish('Zu spät, Boss.')
    await flush()
    expect(r.a.state).toBe('home')
    expect(r.last()).not.toContain('Zu spät')
  })

  it('stops listening when the app goes to the background', async () => {
    const r = rig()
    r.a.onGesture('tap')
    await flush()
    r.a.onBackground()
    await flush()
    expect(r.state.micOn).toBe(false)
    expect(r.a.state).toBe('home')
  })
})

describe('errors are spoken plainly', () => {
  it('invalid key during recognition', async () => {
    const r = rig({ transcribe: async () => { throw new OpenRouterError('x', 401) } })
    await speak(r)
    expect(r.last()).toContain('Schlüssel ist ungültig')
    expect(r.a.state).toBe('home')
  })

  it('no credit during the answer, and the user can ask again', async () => {
    const r = rig({ ask: async () => { throw new OpenRouterError('x', 402) } })
    await speak(r)
    expect(r.last()).toContain('Guthaben')
    r.a.onGesture('tap')
    await flush()
    expect(r.a.state).toBe('recording')
  })

  it('nothing recognized', async () => {
    const r = rig({ transcribe: async () => '   ' })
    await speak(r)
    expect(r.last()).toContain('nichts verstanden')
  })
})

describe('long answers', () => {
  const long = Array.from({ length: 90 }, (_, i) => `wort${i}`).join(' ')

  it('splits into pages that can be paged with swipes', async () => {
    const r = rig()
    r.state.answer = long
    await speak(r)
    expect(r.last()).toMatch(/\n▼ 1\/\d+  Tippen: Frage$/)
    const first = r.last()
    r.a.onGesture('scroll-down')
    expect(r.last()).toMatch(/\n▲▼ 2\/\d+/)
    expect(r.last()).not.toBe(first)
    r.a.onGesture('scroll-up')
    expect(r.last()).toBe(first)
    r.a.onGesture('scroll-up') // already on the first page
    expect(r.last()).toBe(first)
    for (let i = 0; i < 20; i++) r.a.onGesture('scroll-down')
    expect(r.last()).toMatch(/\n▲ \d+\/\d+  Tippen: Frage$/)
  })

  it('goes home on a double tap and asks again on a tap', async () => {
    const r = rig()
    r.state.answer = long
    await speak(r)
    r.a.onGesture('tap')
    await flush()
    expect(r.a.state).toBe('recording')
    r.a.onGesture('double-tap')
    await flush()
    r.state.answer = long
    await speak(r)
    r.a.onGesture('double-tap')
    expect(r.a.state).toBe('home')
  })

  it('footers fit on one line in the real font', () => {
    const worst = [
      `${pageFooter(1, 9, 'Tippen: Frage')}`,
      `${pageFooter(8, 9, 'Tippen: Frage  ▼ Merken?')}`,
    ]
    for (const f of worst) expect(measureTextWrap(f, 560).lineCount).toBe(1)
    expect(measureTextWrap('Doppeltippen: beenden', 560).lineCount).toBe(1)
  })
})

describe('conversation memory', () => {
  it('sends earlier turns with a follow-up question', async () => {
    const r = rig()
    await speak(r)
    r.a.onGesture('tap')
    await flush()
    r.a.onPcm(SPEECH)
    r.a.onGesture('tap')
    await flush()
    const msgs = r.asked[1]!
    expect(msgs.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(msgs[1]!.content).toBe('Wie spät ist es?')
  })

  it('starts empty after "Neuer Chat"', async () => {
    const r = rig()
    await speak(r)
    r.a.newChat()
    await speak(r)
    expect(r.asked[1]!.map(m => m.role)).toEqual(['system', 'user'])
  })

  it('answers typed questions like spoken ones, but not while busy', async () => {
    const r = rig()
    expect(r.a.askText('Hallo?')).toBe(true)
    await flush()
    expect(r.asked).toHaveLength(1)
    expect(r.a.askText('   ')).toBe(false)
    r.a.onGesture('tap')
    await flush()
    expect(r.a.askText('Mitten drin?')).toBe(false)
  })
})

describe('memory proposals', () => {
  const withProposal = 'Schön, dass Sie einen Hund haben, Boss.\n\n[[MERKEN: Hund heißt Rex]]'

  it('offers a proposal after the last page and saves it on a tap', async () => {
    const r = rig()
    r.state.answer = withProposal
    await speak(r)
    expect(r.last()).not.toContain('MERKEN')
    expect(r.last()).toContain('▼ Merken?')
    r.a.onGesture('scroll-down')
    expect(r.a.state).toBe('proposal')
    expect(r.last()).toContain('Merken, Boss?')
    expect(r.last()).toContain('„Hund heißt Rex“')
    r.a.onGesture('tap')
    expect(r.store.memory.notes.map(n => n.text)).toEqual(['Hund heißt Rex'])
    expect(r.last()).toContain('Gemerkt, Boss.')
    expect(r.a.state).toBe('home')
  })

  it('goes back to the answer when declined, and forgets the proposal', async () => {
    const r = rig()
    r.state.answer = withProposal
    await speak(r)
    r.a.onGesture('scroll-down')
    r.a.onGesture('double-tap')
    expect(r.a.state).toBe('answer')
    expect(r.last()).not.toContain('Merken?')
    expect(r.store.memory.notes).toEqual([])
    r.a.onGesture('scroll-down')
    expect(r.a.state).toBe('answer')
  })

  it('does not propose what it already knows', async () => {
    const r = rig()
    r.store.update(m => addNote(m, 'Hund heißt Rex'))
    r.state.answer = withProposal
    await speak(r)
    expect(r.last()).not.toContain('Merken?')
  })

  it('files a proposal under the active topic', async () => {
    const r = rig()
    r.a.askText('Thema Garten')
    await flush()
    r.state.answer = 'Tomaten mögen Sonne, Boss.\n[[MERKEN: Tomaten im Mai pflanzen]]'
    await speak(r)
    r.a.onGesture('scroll-down')
    expect(r.last()).toContain('Merken (Garten), Boss?')
    r.a.onGesture('tap')
    expect(r.store.memory.topics[0]!.notes.map(n => n.text)).toEqual(['Tomaten im Mai pflanzen'])
    expect(r.store.memory.notes).toEqual([])
  })
})

describe('spoken commands', () => {
  it('"Merk dir" saves at once without asking the model', async () => {
    const r = rig({ transcribe: async () => 'Merk dir: Ich bin Veganer.' })
    await speak(r)
    expect(r.asked).toHaveLength(0)
    expect(r.store.memory.notes.map(n => n.text)).toEqual(['Ich bin Veganer'])
    expect(r.last()).toContain('Gemerkt, Boss: Ich bin Veganer')
  })

  it('says so when it knew it already', async () => {
    const r = rig({ transcribe: async () => 'Merk dir: Ich bin Veganer' })
    r.store.update(m => addNote(m, 'Ich bin Veganer'))
    await speak(r)
    expect(r.last()).toContain('Das wusste ich schon')
  })

  it('"Thema Garten" creates and selects the topic; "Kein Thema" leaves it', async () => {
    const r = rig()
    r.a.askText('Thema Garten')
    await flush()
    expect(r.a.topicName).toBe('Garten')
    expect(r.last()).toContain('IGOR · Garten')
    r.a.askText('Thema garten') // finds the existing one instead of creating a second
    await flush()
    expect(r.store.memory.topics).toHaveLength(1)
    r.a.askText('Kein Thema')
    await flush()
    expect(r.a.topicName).toBeNull()
  })

  it('uses topic notes, summary and history in the prompt, and keeps the turns in the topic', async () => {
    const r = rig()
    r.a.askText('Thema Garten')
    await flush()
    const id = r.store.memory.topics[0]!.id
    r.store.update(m => addNote(m, 'Beet liegt im Süden', id))
    r.store.update(m => ({ ...m, topics: m.topics.map(t => ({ ...t, summary: 'Saat folgt im Mai.' })) }))
    r.a.askText('Was steht an?')
    await flush()
    const sys = r.asked[0]![0]!.content
    expect(sys).toContain('Aktuelles Thema: Garten')
    expect(sys).toContain('Saat folgt im Mai.')
    expect(sys).toContain('- Beet liegt im Süden')
    expect(topicById(r.store.memory, id)!.history.map(t => t.role)).toEqual(['user', 'assistant'])
  })

  it('refreshes the topic summary after three exchanges', async () => {
    const complete = vi.fn(async () => 'Neue Zusammenfassung.')
    const r = rig({ complete })
    r.a.askText('Thema Garten')
    await flush()
    for (const q of ['Eins?', 'Zwei?']) {
      r.a.askText(q)
      await flush()
    }
    expect(complete).not.toHaveBeenCalled()
    r.a.askText('Drei?')
    await flush()
    expect(complete).toHaveBeenCalledTimes(1)
    const prompt = (complete.mock.calls[0] as unknown as [ChatMessage[]])[0]
    expect(prompt[1]!.content).toContain('Thema: Garten')
    expect(prompt[1]!.content).toContain('Nutzer: Drei?')
    const t = r.store.memory.topics[0]!
    expect(t.summary).toBe('Neue Zusammenfassung.')
    expect(t.sinceSummary).toBe(0)
  })

  it('a failing summary does not break the conversation', async () => {
    const r = rig({ complete: async () => { throw new Error('offline') } })
    r.a.askText('Thema Garten')
    await flush()
    for (const q of ['Eins?', 'Zwei?', 'Drei?']) {
      r.a.askText(q)
      await flush()
    }
    expect(r.a.state).toBe('answer')
    expect(r.store.memory.topics[0]!.summary).toBe('')
  })
})

describe('menu', () => {
  it('opens with a swipe, offers the five entries, and closes with a double tap', () => {
    const r = rig()
    r.a.onGesture('scroll-down')
    expect(r.lists.at(-1)).toEqual({ title: 'Menü', items: ['Neuer Chat', 'Thema wählen', 'Modell wählen', 'Notizen ansehen', 'Beenden'] })
    r.a.onGesture('double-tap')
    expect(r.a.state).toBe('home')
    expect(r.state.exits).toBe(0)
  })

  it('"Beenden" opens the exit dialog', () => {
    const r = rig()
    r.a.onGesture('scroll-down')
    r.a.onGesture('tap', 4)
    expect(r.state.exits).toBe(1)
  })

  it('lists topics with "no topic" first and "new topic" last, and selects one', () => {
    const r = rig()
    for (const n of ['Garten', 'Urlaub']) r.store.update(m => { const c = createTopic(m, n); return c })
    r.a.onGesture('scroll-down')
    r.a.onGesture('tap', 1)
    expect(r.lists.at(-1)!.items).toEqual(['● Kein Thema', 'Garten', 'Urlaub', '+ Neues Thema (sprechen)'])
    r.a.onGesture('tap', 2) // Urlaub
    expect(r.a.topicName).toBe('Urlaub')
    expect(r.last()).toContain('Thema „Urlaub“, Boss.')
  })

  it('creates a topic by voice from the menu', async () => {
    const r = rig({ transcribe: async () => 'Thema Mein Hobby.' })
    r.a.onGesture('scroll-down')
    r.a.onGesture('tap', 1)
    r.a.onGesture('tap', 1) // "Neues Thema" is the only entry after "Kein Thema"
    await flush()
    expect(r.a.state).toBe('recording')
    expect(r.last()).toContain('Wie soll das Thema heißen')
    r.a.onPcm(SPEECH)
    r.a.onGesture('tap')
    await flush()
    expect(r.a.topicName).toBe('Mein Hobby')
  })

  it('switches the model from the menu', () => {
    const r = rig()
    r.a.onGesture('scroll-down')
    r.a.onGesture('tap', 2)
    expect(r.lists.at(-1)!.items).toEqual(['● Gemini Flash (schnell)', 'Claude Haiku (schnell)'])
    r.a.onGesture('tap', 1)
    expect(r.state.model).toBe('anthropic/claude-haiku-5.5')
    expect(r.last()).toContain('Modell: Claude Haiku (schnell)')
  })

  it('shows the notes on paged text and returns to the menu', () => {
    const r = rig()
    r.store.update(m => addNote(m, 'Hund heißt Rex'))
    r.a.onGesture('scroll-down')
    r.a.onGesture('tap', 3)
    expect(r.a.state).toBe('notes')
    expect(r.last()).toContain('Allgemein:')
    expect(r.last()).toContain('- Hund heißt Rex')
    r.a.onGesture('tap')
    expect(r.a.state).toBe('menu')
  })

  it('says so when there is nothing to remember yet', () => {
    const r = rig()
    r.a.onGesture('scroll-down')
    r.a.onGesture('tap', 3)
    expect(r.last()).toContain('Noch nichts gemerkt')
  })

  it('"Neuer Chat" from the menu clears the conversation', async () => {
    const r = rig()
    await speak(r)
    r.a.onGesture('double-tap') // home
    r.a.onGesture('scroll-down')
    r.a.onGesture('tap', 0)
    expect(r.last()).toContain('Neuer Chat, Boss.')
  })
})

describe('documents', () => {
  const passage = { docId: 'd1', source: 'Mietvertrag, Seite 4', text: 'Die Kündigungsfrist beträgt drei Monate.', score: 3 }

  it('attaches the passages found for the question and the previous one', async () => {
    const queries: [string, string | null][] = []
    const r = rig({ findPassages: (q, t) => (queries.push([q, t]), [passage]) })
    await speak(r)
    const system = r.asked[0]![0]!.content
    expect(system).toContain('Quelle: Mietvertrag, Seite 4')
    expect(system).toContain('Die Kündigungsfrist beträgt drei Monate.')
    expect(queries[0]).toEqual(['Wie spät ist es?', null])

    r.a.onGesture('tap') // answer -> next question
    await flush()
    r.a.onPcm(SPEECH)
    r.a.onGesture('tap')
    await flush()
    expect(queries[1]![0]).toBe('Wie spät ist es? Wie spät ist es?') // follow-up carries the previous question
  })

  it('passes the current topic so its documents rank first', async () => {
    const queries: (string | null)[] = []
    const r = rig({ findPassages: (_q, t) => (queries.push(t), []) })
    const t = r.store.update(m => createTopic(m, 'Hausbau'))
    if (!t.ok) throw new Error('topic')
    r.store.update(m => ({ ...m, currentTopicId: t.value.id }))
    await speak(r)
    expect(queries).toEqual([t.value.id])
  })

  it('sends no document block when nothing matches', async () => {
    const r = rig({ findPassages: () => [] })
    await speak(r)
    expect(r.asked[0]![0]!.content).not.toContain('Auszüge aus den Unterlagen')
  })
})

import { describe, expect, it } from 'vitest'
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import { pageFooter, paginate, TEXT_LINES_PER_PAGE } from './pager.ts'
import { extractProposal, parseCommand, visibleWhileStreaming } from './marker.ts'
import {
  addNote, appendTurns, clearHistory, createTopic, currentTopic, deleteTopic, emptyMemory, findTopic, isDuplicateNote,
  MAX_HISTORY_TURNS, MAX_TOPICS, MemoryStore, parseMemory, removeNote, renameTopic, selectTopic, serializeMemory, setSummary,
  type Memory,
} from './memory.ts'
import { buildMessages, germanNow, summaryMessages, systemPrompt, trimHistory } from './prompt.ts'
import { friendlyError } from './errors.ts'
import { OpenRouterError } from './openrouter.ts'
import { TimeoutError } from './timeout.ts'

/** Fake measurement: greedy wrap at 20 characters, explicit newlines respected. */
const lines20 = (text: string): number => {
  let count = 0
  for (const para of text.split('\n')) {
    let line = 0
    count++
    for (const word of para.split(' ')) {
      if (line === 0) line = word.length
      else if (line + 1 + word.length <= 20) line += 1 + word.length
      else {
        count++
        line = word.length
      }
      while (line > 20) {
        count++
        line -= 20
      }
    }
  }
  return count
}

describe('paginate', () => {
  it('keeps a short answer on one page', () => {
    expect(paginate('Zu Befehl, Boss.', lines20)).toEqual(['Zu Befehl, Boss.'])
  })

  it('never exceeds the line budget and loses no words', () => {
    const text = Array.from({ length: 120 }, (_, i) => `wort${i}`).join(' ')
    const pages = paginate(text, lines20, 4)
    expect(pages.length).toBeGreaterThan(3)
    for (const p of pages) expect(lines20(p)).toBeLessThanOrEqual(4)
    expect(pages.join(' ').split(/\s+/)).toEqual(text.split(/\s+/))
  })

  it('keeps explicit line breaks and drops blank space at page tops', () => {
    const pages = paginate('eins\n\nzwei\n\ndrei\n\nvier', lines20, 3)
    expect(pages).toEqual(['eins\n\nzwei', 'drei\n\nvier'])
  })

  it('splits an oversized word instead of looping forever', () => {
    const pages = paginate('x'.repeat(130), lines20, 2) // 2 lines of 20 = 40 per page
    expect(pages.join('')).toBe('x'.repeat(130))
    for (const p of pages) expect(lines20(p)).toBeLessThanOrEqual(2)
  })

  it('returns one empty page for empty text', () => {
    expect(paginate('   ', lines20)).toEqual([''])
  })

  it('fits the real glasses font: every page measures at most the line budget', () => {
    const text =
      'Der Mars hat keine eigene Zeitzone, aber ein Marstag dauert 24 Stunden und 39 Minuten. ' +
      'Für Ihre Kolonie empfehle ich also längere Mittagspausen, Boss. Außerdem sollten Sie die Größe der Kuppel, ' +
      'die Übergänge zwischen den Schleusen und die Äpfel im Gewächshaus rechtzeitig prüfen. '.repeat(4)
    const real = (t: string) => measureTextWrap(t, 560).lineCount
    const pages = paginate(text, real)
    expect(pages.length).toBeGreaterThan(1)
    for (const p of pages) expect(real(p)).toBeLessThanOrEqual(TEXT_LINES_PER_PAGE)
    expect(getTextWidth('Größe')).toBeGreaterThan(0)
  })

  it('builds footers with arrows', () => {
    expect(pageFooter(0, 1, 'Tippen: Frage')).toBe('Tippen: Frage')
    expect(pageFooter(0, 3, 'Tippen: Frage')).toBe('▼ 1/3  Tippen: Frage')
    expect(pageFooter(1, 3, 'x')).toBe('▲▼ 2/3  x')
    expect(pageFooter(2, 3, 'x')).toBe('▲ 3/3  x')
  })
})

describe('markers and commands', () => {
  it('extracts a memory proposal and hides the marker', () => {
    const r = extractProposal('Schön, Boss.\n\n[[MERKEN: Hund heißt Rex]]')
    expect(r).toEqual({ visible: 'Schön, Boss.', proposal: 'Hund heißt Rex' })
  })

  it('leaves normal answers alone and drops a half-written marker', () => {
    expect(extractProposal('Alles klar.')).toEqual({ visible: 'Alles klar.', proposal: null })
    expect(extractProposal('Alles klar.\n[[MERKEN: Hund')).toEqual({ visible: 'Alles klar.', proposal: null })
  })

  it('hides a marker that is still streaming', () => {
    expect(visibleWhileStreaming('Alles klar.\n[[MER')).toBe('Alles klar.')
    expect(visibleWhileStreaming('Alles klar.')).toBe('Alles klar.')
  })

  it('recognizes "merk dir" in several spoken forms', () => {
    expect(parseCommand('Merk dir: Mein Hund heißt Rex.')).toEqual({ type: 'remember', text: 'Mein Hund heißt Rex' })
    expect(parseCommand('Bitte merke dir, dass ich Veganer bin')).toEqual({ type: 'remember', text: 'ich Veganer bin' })
    expect(parseCommand('Merk dir das')).toBeNull() // refers to the conversation: the model decides
    expect(parseCommand('Wie merke ich mir Namen?')).toBeNull()
  })

  it('recognizes topic and chat commands', () => {
    expect(parseCommand('Thema Garten')).toEqual({ type: 'topic', name: 'Garten' })
    expect(parseCommand('Wechsle zum Thema: Mein Urlaub.')).toEqual({ type: 'topic', name: 'Mein Urlaub' })
    expect(parseCommand('Kein Thema')).toEqual({ type: 'topic', name: null })
    expect(parseCommand('Neuer Chat.')).toEqual({ type: 'newChat' })
    expect(parseCommand('Welches Thema passt zu Gartenarbeit im Winter und was ist sonst noch so los')).toBeNull()
  })
})

describe('memory', () => {
  const withTopic = (name = 'Garten'): { mem: Memory; id: string } => {
    const r = createTopic(emptyMemory(), name)
    if (!r.ok) throw new Error(r.reason)
    return { mem: r.memory, id: r.value.id }
  }

  it('adds notes, refuses duplicates and short text', () => {
    const a = addNote(emptyMemory(), 'Hund heißt Rex')
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(addNote(a.memory, 'hund heißt rex!').ok).toBe(false)
    expect(addNote(a.memory, 'Der Hund heißt Rex und ist braun').ok).toBe(false) // contains the old note
    expect(addNote(a.memory, 'ab').ok).toBe(false)
    expect(isDuplicateNote(a.memory.notes, 'Katze heißt Mia')).toBe(false)
  })

  it('keeps topic notes apart from general notes', () => {
    const { mem, id } = withTopic()
    const r = addNote(mem, 'Tomaten brauchen Sonne', id)
    expect(r.ok && r.memory.topics[0]!.notes.map(n => n.text)).toEqual(['Tomaten brauchen Sonne'])
    expect(r.ok && r.memory.notes).toEqual([])
    expect(addNote(mem, 'Irgendwas Wichtiges', 'gibt-es-nicht').ok).toBe(false)
  })

  it('creates, finds, renames, selects and deletes topics', () => {
    const { mem, id } = withTopic('Mein Garten')
    expect(findTopic(mem, 'garten')?.id).toBe(id)
    expect(findTopic(mem, 'Mein Garten!')?.id).toBe(id)
    expect(findTopic(mem, 'Auto')).toBeUndefined()
    expect(createTopic(mem, 'mein garten').ok).toBe(false)
    const renamed = renameTopic(mem, id, 'Gemüsebeet')
    expect(renamed.ok && renamed.value.name).toBe('Gemüsebeet')
    const selected = selectTopic(mem, id)
    expect(currentTopic(selected)?.name).toBe('Mein Garten')
    expect(deleteTopic(selected, id)).toMatchObject({ topics: [], currentTopicId: null })
    expect(selectTopic(mem, 'unbekannt').currentTopicId).toBeNull()
  })

  it('limits the number of topics to what the glasses list can show', () => {
    let mem = emptyMemory()
    for (let i = 0; i < MAX_TOPICS; i++) {
      const r = createTopic(mem, `Thema ${i}`)
      if (r.ok) mem = r.memory
    }
    expect(mem.topics).toHaveLength(MAX_TOPICS)
    expect(createTopic(mem, 'Eins zu viel').ok).toBe(false)
  })

  it('keeps only the latest turns and counts them for the summary', () => {
    const { mem, id } = withTopic()
    let m = mem
    for (let i = 0; i < 12; i++) {
      m = appendTurns(m, id, [
        { role: 'user', content: `Frage ${i}` },
        { role: 'assistant', content: `Antwort ${i}` },
      ])
    }
    const t = m.topics[0]!
    expect(t.history).toHaveLength(MAX_HISTORY_TURNS * 2)
    expect(t.history.at(-1)!.content).toBe('Antwort 11')
    expect(t.sinceSummary).toBe(12)
    const s = setSummary(m, id, 'Stand: Beet angelegt.')
    expect(s.topics[0]).toMatchObject({ summary: 'Stand: Beet angelegt.', sinceSummary: 0 })
    expect(clearHistory(s, id).topics[0]!.history).toEqual([])
  })

  it('removes a note wherever it lives', () => {
    const { mem, id } = withTopic()
    const a = addNote(mem, 'Tomaten brauchen Sonne', id)
    if (!a.ok) throw new Error()
    expect(removeNote(a.memory, a.value.id).topics[0]!.notes).toEqual([])
  })

  it('survives a save and load round trip, and rejects garbage', () => {
    const { mem, id } = withTopic()
    const a = addNote(selectTopic(mem, id), 'Hund heißt Rex')
    if (!a.ok) throw new Error()
    expect(parseMemory(serializeMemory(a.memory))).toEqual(a.memory)
    expect(parseMemory('kein json')).toBeNull()
    expect(parseMemory('{"notes":"x","topics":[{"id":5}],"currentTopicId":"nope"}')).toEqual(emptyMemory())
  })

  it('saves on every accepted change and stays untouched on refused ones', () => {
    const saved: string[] = []
    const store = new MemoryStore(emptyMemory(), json => void saved.push(json))
    let notified = 0
    store.subscribe(() => notified++)
    expect(store.update(m => addNote(m, 'Hund heißt Rex')).ok).toBe(true)
    expect(store.update(m => addNote(m, 'Hund heißt Rex')).ok).toBe(false)
    expect(saved).toHaveLength(1)
    expect(notified).toBe(1)
    expect(store.memory.notes).toHaveLength(1)
    store.update(m => ({ ...m, currentTopicId: null }))
    expect(saved).toHaveLength(2)
  })
})

describe('prompt', () => {
  const when = new Date('2026-10-18T15:14:00Z')
  const build = () => {
    let mem = emptyMemory()
    const t = createTopic(mem, 'Garten')
    if (!t.ok) throw new Error()
    mem = selectTopic(t.memory, t.value.id)
    const g = addNote(mem, 'Wohne in Köln')
    if (!g.ok) throw new Error()
    const n = addNote(g.memory, 'Tomaten brauchen Sonne', t.value.id)
    if (!n.ok) throw new Error()
    return setSummary(n.memory, t.value.id, 'Beet ist angelegt, Saat folgt im Mai.')
  }

  it('puts notes, topic and rules into the system prompt', () => {
    const sys = systemPrompt('Sie sind IGOR.', build(), when)
    expect(sys).toContain('Sie sind IGOR.')
    expect(sys).toContain('Sonntag, 18. Oktober 2026')
    expect(sys).toContain('- Wohne in Köln')
    expect(sys).toContain('Aktuelles Thema: Garten')
    expect(sys).toContain('Beet ist angelegt, Saat folgt im Mai.')
    expect(sys).toContain('- Tomaten brauchen Sonne')
    expect(sys).toContain('[[MERKEN: kurzer Satz]]')
  })

  it('leaves out empty sections', () => {
    const sys = systemPrompt('Sie sind IGOR.', emptyMemory(), when)
    expect(sys).not.toContain('Das weiß ich über den Nutzer')
    expect(sys).not.toContain('Aktuelles Thema')
    expect(sys).not.toContain('Notizen zu diesem Thema')
  })

  it('keeps the newest notes when the budget is tight', () => {
    let mem = emptyMemory()
    for (let i = 0; i < 80; i++) {
      const r = addNote(mem, `Notiz Nummer ${i} mit etwas mehr Text damit es länger wird`)
      if (r.ok) mem = r.memory
    }
    const sys = systemPrompt('P', mem, when)
    expect(sys).toContain('Notiz Nummer 59 ')
    expect(sys).not.toContain('Notiz Nummer 0 ')
    expect(sys.length).toBeLessThan(3500)
  })

  it('trims history to the budget and starts with the user', () => {
    const turns = [
      { role: 'user' as const, content: 'a'.repeat(100) },
      { role: 'assistant' as const, content: 'b'.repeat(100) },
      { role: 'user' as const, content: 'c'.repeat(100) },
      { role: 'assistant' as const, content: 'd'.repeat(100) },
    ]
    expect(trimHistory(turns, 250).map(t => t.content[0])).toEqual(['c', 'd'])
    expect(trimHistory(turns, 150).map(t => t.content[0])).toEqual([]) // would start with the assistant
  })

  it('builds the message list: system, history, question', () => {
    const msgs = buildMessages({
      persona: 'P',
      memory: emptyMemory(),
      history: [
        { role: 'user', content: 'Wie heißt die Hauptstadt von Frankreich?' },
        { role: 'assistant', content: 'Paris, Boss.' },
      ],
      question: 'Und wie viele Einwohner?',
      now: when,
    })
    expect(msgs.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(msgs.at(-1)!.content).toBe('Und wie viele Einwohner?')
  })

  it('formats the date in German', () => {
    expect(germanNow(new Date('2026-10-18T15:14:00'))).toMatch(/^Sonntag, 18\. Oktober 2026, \d{2}:14 Uhr$/)
  })

  it('asks for a short summary update', () => {
    const msgs = summaryMessages('Garten', 'Beet ist angelegt.', [
      { role: 'user', content: 'Ich pflanze Tomaten.' },
      { role: 'assistant', content: 'Gute Wahl, Boss.' },
    ])
    expect(msgs[1]!.content).toContain('Thema: Garten')
    expect(msgs[1]!.content).toContain('Nutzer: Ich pflanze Tomaten.')
    expect(msgs[1]!.content).toContain('Beet ist angelegt.')
  })
})

describe('friendlyError', () => {
  it('speaks plainly and in character', () => {
    expect(friendlyError(new OpenRouterError('x', 401))).toContain('Schlüssel')
    expect(friendlyError(new OpenRouterError('x', 402))).toContain('Guthaben')
    expect(friendlyError(new OpenRouterError('x', null))).toContain('Verbindung')
    expect(friendlyError(new OpenRouterError('x', 429))).toContain('warten')
    expect(friendlyError(new OpenRouterError('x', 418))).toContain('418')
    expect(friendlyError(new TimeoutError('Antwort', 5000))).toContain('dauert')
    expect(friendlyError(new Error('boom'))).toContain('Boss')
    expect(friendlyError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('Abgebrochen, Boss.')
  })
})

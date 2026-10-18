import type { ChatMessage } from './openrouter.ts'
import { DOC_RULES, MEMORY_RULES } from './persona.ts'
import type { Passage } from './library.ts'
import { topicById, type Memory, type Turn } from './memory.ts'

/** Room for notes in the system prompt, in characters; the newest notes win. */
export const NOTES_BUDGET = 1800
/** Room for recent turns, in characters. */
export const HISTORY_BUDGET = 3200

/** "Sonntag, 18. Oktober 2026, 17:14 Uhr" */
export function germanNow(now: Date = new Date()): string {
  const date = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)
  const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(now)
  return `${date}, ${time} Uhr`
}

function noteLines(notes: { text: string }[], budget: number): string[] {
  const picked: string[] = []
  let used = 0
  for (const n of [...notes].reverse()) {
    if (used + n.text.length + 3 > budget) break
    picked.unshift(`- ${n.text}`)
    used += n.text.length + 3
  }
  return picked
}

/** The most recent turns that fit the budget, oldest first. */
export function trimHistory(history: Turn[], budget = HISTORY_BUDGET): Turn[] {
  const picked: Turn[] = []
  let used = 0
  for (const t of [...history].reverse()) {
    used += t.content.length
    if (used > budget && picked.length) break
    picked.unshift(t)
  }
  // A conversation must start with the user's turn.
  while (picked.length && picked[0]!.role !== 'user') picked.shift()
  return picked
}

/** The passages found for this question, each labelled with the source the model should cite. */
export function passageBlock(passages: Passage[]): string {
  const items = passages.map(p => `Quelle: ${p.source}\n${p.text}`).join('\n\n---\n\n')
  return `${DOC_RULES}\n\nAuszüge aus den Unterlagen:\n\n${items}`
}

export function systemPrompt(persona: string, memory: Memory, now: Date = new Date(), passages: Passage[] = []): string {
  const topic = topicById(memory, memory.currentTopicId)
  const parts = [persona.trim(), `Heute ist ${germanNow(now)}.`]

  const general = noteLines(memory.notes, topic ? Math.floor(NOTES_BUDGET / 2) : NOTES_BUDGET)
  if (general.length) parts.push(`Das weiß ich über den Nutzer (Notizen):\n${general.join('\n')}`)

  if (topic) {
    parts.push(`Aktuelles Thema: ${topic.name}. Bleiben Sie bei diesem Thema, solange der Nutzer nichts anderes fragt.`)
    if (topic.summary) parts.push(`Stand zu diesem Thema bisher:\n${topic.summary}`)
    const own = noteLines(topic.notes, Math.floor(NOTES_BUDGET / 2))
    if (own.length) parts.push(`Notizen zu diesem Thema:\n${own.join('\n')}`)
  }
  if (passages.length) parts.push(passageBlock(passages))
  parts.push(MEMORY_RULES)
  return parts.join('\n\n')
}

/** Everything the model needs for one question: system prompt, recent turns, the new question. */
export function buildMessages(opts: {
  persona: string
  memory: Memory
  history: Turn[]
  question: string
  now?: Date
  passages?: Passage[]
}): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(opts.persona, opts.memory, opts.now, opts.passages) },
    ...trimHistory(opts.history),
    { role: 'user', content: opts.question },
  ]
}

/** Asks the model to fold new conversation into the topic's summary. */
export function summaryMessages(topicName: string, oldSummary: string, turns: Turn[]): ChatMessage[] {
  const talk = turns.map(t => `${t.role === 'user' ? 'Nutzer' : 'IGOR'}: ${t.content}`).join('\n')
  return [
    {
      role: 'system',
      content:
        'Sie führen das Gedächtnis eines Assistenten. Fassen Sie auf Deutsch den Stand eines Gesprächsthemas knapp zusammen: ' +
        'Fakten, Entscheidungen, offene Fragen. Höchstens 600 Zeichen, reiner Text ohne Markdown. Antworten Sie nur mit der Zusammenfassung.',
    },
    {
      role: 'user',
      content: `Thema: ${topicName}\n\nBisherige Zusammenfassung:\n${oldSummary || '(noch keine)'}\n\nNeue Gesprächsteile:\n${talk}\n\nAktualisierte Zusammenfassung:`,
    },
  ]
}

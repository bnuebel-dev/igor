// IGOR's memory: notes the user wants him to know, and topics with their own
// notes, running summary and recent conversation. Pure functions on an immutable
// structure; the store at the bottom persists it.

export type Note = { id: string; text: string; at: number }
export type Turn = { role: 'user' | 'assistant'; content: string }
export type Topic = {
  id: string
  name: string
  /** Running summary of earlier conversations, kept short by the summarizer. */
  summary: string
  notes: Note[]
  /** The most recent turns, so a topic can be continued after a restart. */
  history: Turn[]
  /** Turns added since the summary was last refreshed. */
  sinceSummary: number
  at: number
}
export type Memory = {
  v: 1
  notes: Note[]
  topics: Topic[]
  /** Topic that is active right now, or null for the general chat. */
  currentTopicId: string | null
}

export const MAX_TOPICS = 18 // the glasses list holds 20 entries: "no topic", these topics, "new topic"
export const MAX_NOTES = 60
export const MAX_TOPIC_NOTES = 40
export const MAX_NOTE_CHARS = 200
export const MAX_TOPIC_NAME = 40
export const MAX_HISTORY_TURNS = 8
export const MAX_SUMMARY_CHARS = 800

export const emptyMemory = (): Memory => ({ v: 1, notes: [], topics: [], currentTopicId: null })

let counter = 0
export const newId = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`

/** Lowercase, no punctuation, single spaces: for comparing sentences and names. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isDuplicateNote(notes: Note[], text: string): boolean {
  const n = normalize(text)
  return notes.some(x => {
    const m = normalize(x.text)
    return m === n || m.includes(n) || n.includes(m)
  })
}

export const topicById = (mem: Memory, id: string | null): Topic | undefined =>
  id ? mem.topics.find(t => t.id === id) : undefined

export const currentTopic = (mem: Memory): Topic | undefined => topicById(mem, mem.currentTopicId)

/** Finds a topic by exact name first, then by containment ("garten" finds "Mein Garten"). */
export function findTopic(mem: Memory, name: string): Topic | undefined {
  const n = normalize(name)
  if (!n) return undefined
  return mem.topics.find(t => normalize(t.name) === n) ?? mem.topics.find(t => normalize(t.name).includes(n) || n.includes(normalize(t.name)))
}

export type Result<T> = { ok: true; memory: Memory; value: T } | { ok: false; reason: string }

const cleanText = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max)

/** Adds a note to the general memory, or to a topic. Duplicates and overflow are refused. */
export function addNote(mem: Memory, text: string, topicId: string | null = null): Result<Note> {
  const t = cleanText(text, MAX_NOTE_CHARS)
  if (t.length < 3) return { ok: false, reason: 'Notiz zu kurz' }
  const note: Note = { id: newId(), text: t, at: Date.now() }
  if (topicId) {
    const topic = topicById(mem, topicId)
    if (!topic) return { ok: false, reason: 'Thema nicht gefunden' }
    if (isDuplicateNote(topic.notes, t)) return { ok: false, reason: 'Schon gemerkt' }
    if (topic.notes.length >= MAX_TOPIC_NOTES) return { ok: false, reason: 'Zu viele Notizen im Thema' }
    return {
      ok: true,
      value: note,
      memory: { ...mem, topics: mem.topics.map(x => (x.id === topicId ? { ...x, notes: [...x.notes, note], at: Date.now() } : x)) },
    }
  }
  if (isDuplicateNote(mem.notes, t)) return { ok: false, reason: 'Schon gemerkt' }
  if (mem.notes.length >= MAX_NOTES) return { ok: false, reason: 'Zu viele Notizen' }
  return { ok: true, value: note, memory: { ...mem, notes: [...mem.notes, note] } }
}

export function removeNote(mem: Memory, noteId: string): Memory {
  return {
    ...mem,
    notes: mem.notes.filter(n => n.id !== noteId),
    topics: mem.topics.map(t => ({ ...t, notes: t.notes.filter(n => n.id !== noteId) })),
  }
}

export function createTopic(mem: Memory, name: string): Result<Topic> {
  const n = cleanText(name, MAX_TOPIC_NAME)
  if (n.length < 2) return { ok: false, reason: 'Name zu kurz' }
  if (mem.topics.some(t => normalize(t.name) === normalize(n))) return { ok: false, reason: 'Thema gibt es schon' }
  if (mem.topics.length >= MAX_TOPICS) return { ok: false, reason: 'Zu viele Themen' }
  const topic: Topic = { id: newId(), name: n, summary: '', notes: [], history: [], sinceSummary: 0, at: Date.now() }
  return { ok: true, value: topic, memory: { ...mem, topics: [...mem.topics, topic] } }
}

export function renameTopic(mem: Memory, id: string, name: string): Result<Topic> {
  const n = cleanText(name, MAX_TOPIC_NAME)
  const topic = topicById(mem, id)
  if (!topic) return { ok: false, reason: 'Thema nicht gefunden' }
  if (n.length < 2) return { ok: false, reason: 'Name zu kurz' }
  if (mem.topics.some(t => t.id !== id && normalize(t.name) === normalize(n))) return { ok: false, reason: 'Thema gibt es schon' }
  const renamed = { ...topic, name: n }
  return { ok: true, value: renamed, memory: { ...mem, topics: mem.topics.map(t => (t.id === id ? renamed : t)) } }
}

export function deleteTopic(mem: Memory, id: string): Memory {
  return {
    ...mem,
    topics: mem.topics.filter(t => t.id !== id),
    currentTopicId: mem.currentTopicId === id ? null : mem.currentTopicId,
  }
}

export function selectTopic(mem: Memory, id: string | null): Memory {
  return { ...mem, currentTopicId: id && topicById(mem, id) ? id : null }
}

/** Remembers the latest turns of a topic; the oldest fall off. */
export function appendTurns(mem: Memory, topicId: string, turns: Turn[]): Memory {
  return {
    ...mem,
    topics: mem.topics.map(t =>
      t.id === topicId
        ? {
            ...t,
            history: [...t.history, ...turns].slice(-MAX_HISTORY_TURNS * 2),
            sinceSummary: t.sinceSummary + turns.filter(x => x.role === 'user').length,
            at: Date.now(),
          }
        : t,
    ),
  }
}

export function setSummary(mem: Memory, topicId: string, summary: string): Memory {
  return {
    ...mem,
    topics: mem.topics.map(t => (t.id === topicId ? { ...t, summary: cleanText(summary, MAX_SUMMARY_CHARS), sinceSummary: 0 } : t)),
  }
}

export function clearHistory(mem: Memory, topicId: string): Memory {
  return { ...mem, topics: mem.topics.map(t => (t.id === topicId ? { ...t, history: [], sinceSummary: 0 } : t)) }
}

// ---- Persistence --------------------------------------------------------------------------

const isStr = (x: unknown): x is string => typeof x === 'string'
const sanitizeNotes = (raw: unknown, max: number): Note[] =>
  (Array.isArray(raw) ? raw : [])
    .filter((n): n is Note => !!n && isStr((n as Note).id) && isStr((n as Note).text))
    .slice(0, max)
    .map(n => ({ id: n.id, text: cleanText(n.text, MAX_NOTE_CHARS), at: Number(n.at) || 0 }))

/** Reads stored or imported JSON; anything unexpected is dropped instead of crashing. */
export function parseMemory(json: string): Memory | null {
  let raw: any
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const topics: Topic[] = (Array.isArray(raw.topics) ? raw.topics : [])
    .filter((t: any) => t && isStr(t.id) && isStr(t.name))
    .slice(0, MAX_TOPICS)
    .map((t: any): Topic => ({
      id: t.id,
      name: cleanText(t.name, MAX_TOPIC_NAME),
      summary: isStr(t.summary) ? cleanText(t.summary, MAX_SUMMARY_CHARS) : '',
      notes: sanitizeNotes(t.notes, MAX_TOPIC_NOTES),
      history: (Array.isArray(t.history) ? t.history : [])
        .filter((x: any) => x && (x.role === 'user' || x.role === 'assistant') && isStr(x.content))
        .slice(-MAX_HISTORY_TURNS * 2)
        .map((x: any): Turn => ({ role: x.role, content: x.content.slice(0, 4000) })),
      sinceSummary: Number(t.sinceSummary) || 0,
      at: Number(t.at) || 0,
    }))
  const current = isStr(raw.currentTopicId) && topics.some(t => t.id === raw.currentTopicId) ? raw.currentTopicId : null
  return { v: 1, notes: sanitizeNotes(raw.notes, MAX_NOTES), topics, currentTopicId: current }
}

export const serializeMemory = (mem: Memory): string => JSON.stringify(mem)

/** Holds the memory, saves every change, and tells listeners (the phone page) about it. */
export class MemoryStore {
  private mem: Memory
  private listeners = new Set<() => void>()

  constructor(
    initial: Memory,
    private readonly save: (json: string) => void | Promise<unknown>,
  ) {
    this.mem = initial
  }

  get memory(): Memory {
    return this.mem
  }

  /** Applies a change; refused changes (a `Result` with ok=false) leave the memory untouched. */
  update<T>(change: (m: Memory) => Result<T>): Result<T>
  update(change: (m: Memory) => Memory): Memory
  update(change: (m: Memory) => Memory | Result<unknown>): Memory | Result<unknown> {
    const out = change(this.mem)
    const next = 'ok' in out ? (out.ok ? out.memory : null) : out
    if (next) {
      this.mem = next
      void this.save(serializeMemory(next))
      this.listeners.forEach(l => l())
    }
    return out
  }

  replace(next: Memory) {
    this.update(() => next)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

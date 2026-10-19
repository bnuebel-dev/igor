import { buildDoc, LibraryIndex, MAX_DOC_CHARS, MAX_LIBRARY_CHARS, type Doc, type DocMeta, type Passage, type RawDoc, type SearchOptions } from './library.ts'
import { newId } from './memory.ts'
import type { Kv } from './storage.ts'

const INDEX_KEY = 'igor.lib.idx'
const docKey = (id: string) => `igor.lib.d.${id}`

type Log = (level: 'info' | 'ok' | 'fail', msg: string) => void
export type AddResult = { ok: true; doc: DocMeta; replaced: boolean } | { ok: false; reason: string }

const metaOf = ({ chunks: _chunks, ...meta }: Doc): DocMeta => meta

/**
 * The documents live in the phone's storage: one small index entry plus one entry per
 * document, so adding a file never rewrites the others. The search index is built
 * on first use after a change.
 */
export class LibraryStore {
  private docs = new Map<string, Doc>()
  private index: LibraryIndex | null = null
  private listeners = new Set<() => void>()
  private writes: Promise<unknown> = Promise.resolve()
  /** Batch adds leave the index to commit(); until then the new documents exist only in memory. */
  private dirty = false

  constructor(
    private readonly kv: Kv,
    private readonly log: Log,
  ) {}

  async load(): Promise<void> {
    const raw = await this.kv.get(INDEX_KEY)
    if (!raw) return
    let metas: DocMeta[]
    try {
      metas = JSON.parse(raw)
      if (!Array.isArray(metas)) throw new Error('kein Verzeichnis')
    } catch (err) {
      this.log('fail', `Unterlagen: Verzeichnis unlesbar (${(err as Error).message}), starte leer`)
      return
    }
    for (const meta of metas) {
      try {
        const chunks = JSON.parse(await this.kv.get(docKey(meta.id)))
        if (!Array.isArray(chunks)) throw new Error('leer')
        this.docs.set(meta.id, { ...meta, chunks })
      } catch (err) {
        this.log('fail', `Unterlagen: ${meta.path} nicht lesbar (${(err as Error).message}), übersprungen`)
      }
    }
    this.changed()
  }

  list(): DocMeta[] {
    return [...this.docs.values()].map(metaOf).sort((a, b) => a.path.localeCompare(b.path, 'de'))
  }

  get(id: string): Doc | undefined {
    return this.docs.get(id)
  }

  get totalChars(): number {
    let n = 0
    for (const d of this.docs.values()) n += d.chars
    return n
  }

  get chunkCount(): number {
    let n = 0
    for (const d of this.docs.values()) n += d.chunks.length
    return n
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Adds a document; the same path replaces the older version and keeps its topic. */
  async add(raw: RawDoc, opts: { batch?: boolean } = {}): Promise<AddResult> {
    const doc = buildDoc(raw, newId())
    if (!doc.chunks.length) return { ok: false, reason: `${raw.name}: kein Text gefunden${raw.kind === 'pdf' ? ' (vermutlich ein eingescanntes PDF)' : ''}` }
    if (doc.chars > MAX_DOC_CHARS) return { ok: false, reason: `${raw.name}: zu groß (${Math.round(doc.chars / 1000)}k Zeichen, erlaubt ${MAX_DOC_CHARS / 1000}k)` }
    const old = [...this.docs.values()].find(d => d.path === doc.path)
    if (this.totalChars - (old?.chars ?? 0) + doc.chars > MAX_LIBRARY_CHARS) {
      return { ok: false, reason: `${raw.name}: die Bibliothek wäre voll (höchstens ${MAX_LIBRARY_CHARS / 1_000_000} Mio. Zeichen)` }
    }
    if (old) {
      doc.topicId = old.topicId
      doc.id = old.id
    }
    const next = new Map(this.docs).set(doc.id, doc)
    // In a batch only the document is written now; one index write at the end replaces hundreds.
    const ok = opts.batch
      ? await this.queue(() => this.kv.set(docKey(doc.id), JSON.stringify(doc.chunks)))
      : await this.persist(doc.id, JSON.stringify(doc.chunks), next)
    if (!ok) return { ok: false, reason: `${raw.name}: Speicher der Even-App hat das Schreiben abgelehnt` }
    this.docs = next
    if (opts.batch) {
      this.dirty = true
      this.index = null
    } else this.changed()
    return { ok: true, doc: metaOf(doc), replaced: !!old }
  }

  /** Ends a batch of adds: writes the index once and tells the listeners. */
  async commit(): Promise<boolean> {
    if (!this.dirty) return true
    const ok = await this.writeIndex(this.docs)
    if (ok) this.dirty = false
    this.changed()
    return ok
  }

  /** Removes every document. */
  async clear(): Promise<boolean> {
    const ids = [...this.docs.keys()]
    const ok = await this.writeIndex(new Map())
    if (!ok) return false
    this.docs = new Map()
    this.dirty = false
    this.changed()
    for (const id of ids) void this.queue(() => this.kv.set(docKey(id), '')) // free the space
    return true
  }

  async remove(id: string): Promise<boolean> {
    if (!this.docs.has(id)) return false
    const next = new Map(this.docs)
    next.delete(id)
    const ok = await this.writeIndex(next)
    if (!ok) return false
    this.docs = next
    this.changed()
    void this.queue(() => this.kv.set(docKey(id), '')) // free the space; a failure only leaves an orphan
    return true
  }

  async setTopic(id: string, topicId: string | null): Promise<boolean> {
    const doc = this.docs.get(id)
    if (!doc) return false
    const next = new Map(this.docs).set(id, { ...doc, topicId })
    const ok = await this.writeIndex(next)
    if (!ok) return false
    this.docs = next
    this.changed()
    return true
  }

  /** Documents of a deleted topic fall back to "no topic". */
  async dropTopic(topicId: string): Promise<void> {
    for (const d of [...this.docs.values()]) if (d.topicId === topicId) await this.setTopic(d.id, null)
  }

  search(query: string, opts?: SearchOptions): Passage[] {
    this.index ??= new LibraryIndex([...this.docs.values()])
    return this.index.search(query, opts)
  }

  private changed() {
    this.index = null
    this.listeners.forEach(l => l())
  }

  /** Serialises writes so two quick additions cannot interleave their index updates. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn)
    this.writes = run.catch(() => undefined)
    return run
  }

  private persist(id: string, chunksJson: string, next: Map<string, Doc>): Promise<boolean> {
    return this.queue(async () => {
      if (!(await this.kv.set(docKey(id), chunksJson))) return false
      return this.writeIndexNow(next)
    })
  }

  private writeIndex(next: Map<string, Doc>): Promise<boolean> {
    return this.queue(() => this.writeIndexNow(next))
  }

  private writeIndexNow(next: Map<string, Doc>): Promise<boolean> {
    return this.kv.set(INDEX_KEY, JSON.stringify([...next.values()].map(metaOf)))
  }
}

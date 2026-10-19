// The user's own documents: split into passages, found again by keyword search.
// Pure functions only; storage is in libraryStore.ts and reading files in ingest.ts.

export type DocKind = 'md' | 'txt' | 'pdf'

export type Chunk = {
  /** Section path for Markdown ("Hausbau > Dach"), empty otherwise. */
  heading: string
  /** PDF page, 1-based. */
  page?: number
  text: string
}

export type DocMeta = {
  id: string
  /** Display name, usually the file name. */
  name: string
  /** Folder path inside the source ("Notizen/Hausbau/angebot.md"); equals the name for single files. */
  path: string
  kind: DocKind
  /** Title from the front matter or the first heading. */
  title: string
  tags: string[]
  topicId: string | null
  chars: number
  pages?: number
  addedAt: number
  /** Set when the document was mirrored from pCloud: file id and change marker. */
  remote?: { fileid: number; hash: string }
}

export type Doc = DocMeta & { chunks: Chunk[] }

export type Passage = {
  docId: string
  /** "angebot.md" or "vertrag.pdf, Seite 4" – what the model is told to cite. */
  source: string
  text: string
  score: number
}

export const MAX_CHUNK_CHARS = 1200
export const MAX_DOC_CHARS = 2_000_000
export const MAX_LIBRARY_CHARS = 8_000_000

export const kindOf = (name: string): DocKind | null => {
  if (/\.(md|markdown)$/i.test(name)) return 'md'
  if (/\.txt$/i.test(name)) return 'txt'
  if (/\.pdf$/i.test(name)) return 'pdf'
  return null
}

// ---- Parsing ----------------------------------------------------------------------------------

const cleanTag = (t: string) => t.trim().replace(/^["']+|["']+$/g, '').replace(/^#/, '').trim()

/** Obsidian-style front matter: title, tags; everything else is ignored. */
export function parseFrontMatter(text: string): { body: string; title: string; tags: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { body: text, title: '', tags: [] }
  const head = m[1]!
  const title = /^title:\s*(.+)$/im.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  const tags: string[] = []
  const inline = /^tags:\s*\[(.*)\]\s*$/im.exec(head)
  if (inline) tags.push(...inline[1]!.split(',').map(cleanTag))
  else {
    const block = /^tags:\s*\r?\n((?:[ \t]*-[^\n]*\r?\n?)+)/im.exec(head)
    if (block) for (const line of block[1]!.split(/\r?\n/)) tags.push(cleanTag(line.replace(/^[ \t]*-\s*/, '')))
    else {
      const flat = /^tags:\s*(\S.*)$/im.exec(head)
      if (flat) tags.push(...flat[1]!.split(/[,\s]+/).map(cleanTag))
    }
  }
  return { body: text.slice(m[0].length), title, tags: tags.filter(Boolean) }
}

/** Cuts a long section at paragraph (then line, then word) boundaries so each part stays readable. */
export function splitLong(text: string, max = MAX_CHUNK_CHARS): string[] {
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (clean.length <= max) return clean ? [clean] : []
  const out: string[] = []
  let cur = ''
  const flush = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  const pieces = clean.split(/\n{2,}/)
  for (const piece of pieces) {
    if (piece.length > max) {
      flush()
      let rest = piece
      while (rest.length > max) {
        let cut = rest.lastIndexOf('\n', max)
        if (cut < max / 2) cut = rest.lastIndexOf('. ', max) + 1
        if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
        if (cut < max / 2) cut = max
        out.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
      }
      cur = rest
    } else if (cur && cur.length + piece.length + 2 > max) {
      flush()
      cur = piece
    } else cur = cur ? `${cur}\n\n${piece}` : piece
  }
  flush()
  return out.filter(Boolean)
}

/** Markdown becomes one chunk per section, each tagged with its heading path. */
export function chunkMarkdown(body: string): Chunk[] {
  const chunks: Chunk[] = []
  const path: string[] = []
  let buf: string[] = []
  let inCode = false
  const flush = () => {
    const heading = path.filter(Boolean).join(' > ')
    for (const part of splitLong(buf.join('\n'))) chunks.push({ heading, text: part })
    buf = []
  }
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode
    const h = !inCode ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (h) {
      flush()
      const level = h[1]!.length
      path.length = Math.min(path.length, level - 1)
      while (path.length < level - 1) path.push('')
      path[level - 1] = h[2]!
    } else buf.push(line)
  }
  flush()
  return chunks
}

/** Joins sections that are too small to stand alone ("## Notiz" with one line) with their neighbour. */
export function mergeTiny(chunks: Chunk[], min = 160): Chunk[] {
  const out: Chunk[] = []
  for (const c of chunks) {
    const prev = out[out.length - 1]
    if (prev && prev.page === c.page && (prev.text.length < min || c.text.length < min) && prev.text.length + c.text.length < MAX_CHUNK_CHARS) {
      prev.text = `${prev.text}\n\n${c.heading && c.heading !== prev.heading ? `${c.heading}: ` : ''}${c.text}`
    } else out.push({ ...c })
  }
  return out
}

export type RawDoc =
  | { kind: 'md' | 'txt'; name: string; path: string; text: string }
  | { kind: 'pdf'; name: string; path: string; pages: string[] }

export function buildDoc(raw: RawDoc, id: string, now = Date.now()): Doc {
  let chunks: Chunk[] = []
  let title = ''
  let tags: string[] = []
  let chars = 0
  let pages: number | undefined
  if (raw.kind === 'pdf') {
    pages = raw.pages.length
    raw.pages.forEach((p, i) => {
      for (const part of splitLong(p.replace(/[ \t]+/g, ' '))) chunks.push({ heading: '', page: i + 1, text: part })
      chars += p.length
    })
    title = raw.name.replace(/\.pdf$/i, '')
  } else if (raw.kind === 'md') {
    const fm = parseFrontMatter(raw.text)
    chunks = mergeTiny(chunkMarkdown(fm.body))
    tags = fm.tags
    title = fm.title || /^#\s+(.+)$/m.exec(fm.body)?.[1]?.trim() || raw.name.replace(/\.(md|markdown)$/i, '')
    chars = raw.text.length
  } else {
    chunks = splitLong(raw.text).map(text => ({ heading: '', text }))
    title = raw.name.replace(/\.txt$/i, '')
    chars = raw.text.length
  }
  return { id, name: raw.name, path: raw.path, kind: raw.kind, title, tags, topicId: null, chars, pages, addedAt: now, chunks }
}

// ---- Search -----------------------------------------------------------------------------------

const STOP = new Set(
  ('der die das den dem des ein eine einen einem einer eines und oder aber auch nicht noch nur schon sehr mal ' +
    'ist sind war waren wird werden wurde hat haben hatte kann koennen konnte soll sollen muss muessen will wollen ' +
    'ich du er sie es wir ihr mich mir dich dir ihn ihm uns euch mein meine meinen meiner meinem dein sein seine ' +
    'was wer wie wo wann wieso warum welche welcher welches wieviel wieviele mit von zu zum zur bei nach aus auf an in im am ' +
    'fur fuer uber ueber unter vor um als wenn dass ob dann da hier dort so wie bitte boss igor sag sage sagen gib ' +
    'gibt geben zeig zeige steht stehen the and for what how').split(/\s+/),
)

/** Lower case, umlauts folded, so "Kündigung" and "kundigung" meet. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
}

const STEM = 6

/** Word stems cut to six letters: "Kündigungsfrist", "kündigen", "Kündigung" all become "kuendi". */
export function tokens(text: string): string[] {
  const out: string[] = []
  for (const w of fold(text).split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w)) continue
    out.push(w.length > STEM ? w.slice(0, STEM) : w)
  }
  return out
}

type Entry = { docId: string; chunk: Chunk; tf: Map<string, number>; len: number; boost: number }

const K1 = 1.4
const B = 0.75

export type SearchOptions = {
  /** Documents of this topic score higher (not exclusively: other documents still count). */
  topicId?: string | null
  limit?: number
  /** Total characters of all returned passages. */
  budget?: number
}

export class LibraryIndex {
  private entries: Entry[] = []
  private df = new Map<string, number>()
  private avg = 1
  private names = new Map<string, DocMeta>()

  constructor(docs: Doc[]) {
    for (const d of docs) {
      this.names.set(d.id, d)
      // Names, headings and tags count three times: a hit there is a much stronger signal than in the running text.
      const docHead = tokens(`${d.title} ${d.path} ${d.tags.join(' ')}`)
      for (const chunk of d.chunks) {
        const head = tokens(chunk.heading)
        const body = tokens(chunk.text)
        const all = [...body, ...head, ...head, ...head, ...docHead, ...docHead]
        const tf = new Map<string, number>()
        for (const t of all) tf.set(t, (tf.get(t) ?? 0) + 1)
        this.entries.push({ docId: d.id, chunk, tf, len: all.length || 1, boost: 1 })
        for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      }
    }
    this.avg = this.entries.reduce((n, e) => n + e.len, 0) / (this.entries.length || 1)
  }

  get size(): number {
    return this.entries.length
  }

  search(query: string, opts: SearchOptions = {}): Passage[] {
    const q = [...new Set(tokens(query))]
    if (!q.length || !this.entries.length) return []
    const N = this.entries.length
    const scored: Passage[] = []
    for (const e of this.entries) {
      let score = 0
      let hit = 0
      for (const t of q) {
        const f = e.tf.get(t)
        if (!f) continue
        hit++
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * e.len) / this.avg))
      }
      if (!hit) continue
      // Reward chunks that match several different words of the question.
      score *= 1 + 0.4 * (hit - 1)
      const meta = this.names.get(e.docId)!
      if (opts.topicId && meta.topicId === opts.topicId) score *= 1.6
      scored.push({ docId: e.docId, source: sourceLabel(meta, e.chunk), text: e.chunk.text, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const out: Passage[] = []
    let used = 0
    const budget = opts.budget ?? 4500
    const best = scored[0]?.score ?? 0
    for (const p of scored) {
      if (out.length >= (opts.limit ?? 5)) break
      if (p.score < best * 0.25) break // far behind the best hit: noise
      if (used + p.text.length > budget && out.length) break
      out.push(p)
      used += p.text.length
    }
    return out
  }
}

export function sourceLabel(meta: DocMeta, chunk: Chunk): string {
  const name = meta.kind === 'md' ? meta.title : meta.name
  // "Mietvertrag > Kündigung" in a document titled "Mietvertrag" is just "Kündigung".
  const parts = chunk.heading.split(' > ')
  if (parts[0] === name || parts[0] === meta.title) parts.shift()
  const where = chunk.page ? `Seite ${chunk.page}` : parts.join(' > ')
  return where ? `${name}, ${where}` : name
}

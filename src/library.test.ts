import { describe, expect, it } from 'vitest'
import { buildDoc, chunkMarkdown, kindOf, LibraryIndex, parseFrontMatter, splitLong, tokens, type Doc } from './library.ts'

const md = (name: string, text: string, path = name): Doc => buildDoc({ kind: 'md', name, path, text }, name)

describe('front matter', () => {
  it('reads title and tags in the three Obsidian spellings', () => {
    expect(parseFrontMatter('---\ntitle: Research Storyline\ntags:\n  - phase/foundation\n  - "#ki"\n---\nText')).toEqual({
      body: 'Text', title: 'Research Storyline', tags: ['phase/foundation', 'ki'],
    })
    expect(parseFrontMatter('---\ntags: [a, b]\n---\nX').tags).toEqual(['a', 'b'])
    expect(parseFrontMatter('---\ntags: a b\n---\nX').tags).toEqual(['a', 'b'])
  })

  it('leaves text without front matter alone', () => {
    expect(parseFrontMatter('# Titel\nText')).toEqual({ body: '# Titel\nText', title: '', tags: [] })
    expect(parseFrontMatter('Text\n---\nmehr').title).toBe('')
  })
})

describe('chunking', () => {
  it('splits Markdown by heading and keeps the heading path', () => {
    const chunks = chunkMarkdown('# Haus\nEinleitung\n## Dach\nKostet 12000 Euro.\n## Keller\nWird später.\n# Garten\nTomaten.')
    expect(chunks.map(c => [c.heading, c.text])).toEqual([
      ['Haus', 'Einleitung'],
      ['Haus > Dach', 'Kostet 12000 Euro.'],
      ['Haus > Keller', 'Wird später.'],
      ['Garten', 'Tomaten.'],
    ])
  })

  it('does not treat # inside code blocks as a heading', () => {
    const chunks = chunkMarkdown('# Skript\n```\n# Kommentar\n```\nEnde')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toContain('# Kommentar')
  })

  it('cuts long text at paragraph boundaries and never exceeds the limit', () => {
    const para = 'Satz eins ist hier. Satz zwei folgt danach. '.repeat(12).trim()
    const parts = splitLong(Array(8).fill(para).join('\n\n'), 1200)
    expect(parts.length).toBeGreaterThan(3)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1200)
    expect(parts.join(' ').replace(/\s+/g, ' ')).toContain('Satz zwei folgt danach.')
  })

  it('cuts one giant line without losing text', () => {
    const word = 'wort '.repeat(1000).trim()
    const parts = splitLong(word, 1200)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1200)
    expect(parts.join(' ').split(' ').length).toBe(1000)
  })

  it('merges tiny sections into their neighbour and keeps their heading words searchable', () => {
    const doc = md('a.md', '# A\nKurz.\n## B\nAuch kurz.')
    expect(doc.chunks).toHaveLength(1)
    expect(doc.chunks[0]!.text).toContain('B: Auch kurz.')
  })

  it('builds PDF chunks per page', () => {
    const doc = buildDoc({ kind: 'pdf', name: 'v.pdf', path: 'v.pdf', pages: ['Seite eins', 'Seite zwei'] }, 'v')
    expect(doc.chunks.map(c => c.page)).toEqual([1, 2])
    expect(doc.pages).toBe(2)
  })

  it('takes the title from front matter, then the first heading, then the file name', () => {
    expect(md('x.md', '---\ntitle: Aus Kopf\n---\n# Egal\nText').title).toBe('Aus Kopf')
    expect(md('x.md', '# Erste Überschrift\nText').title).toBe('Erste Überschrift')
    expect(md('x.md', 'Nur Text').title).toBe('x')
  })

  it('recognises supported file types', () => {
    expect(kindOf('A.MD')).toBe('md')
    expect(kindOf('b.txt')).toBe('txt')
    expect(kindOf('c.PDF')).toBe('pdf')
    expect(kindOf('d.pptx')).toBeNull()
  })
})

describe('tokens', () => {
  it('folds umlauts, drops filler words and shares one stem across word forms', () => {
    expect(tokens('Wie lang ist die Kündigungsfrist?')).toEqual(['lang', 'kuendi'])
    expect(tokens('kündigen')).toEqual(tokens('Kündigung'))
    expect(tokens('Straße')).toEqual(['strass'])
  })
})

describe('search', () => {
  const docs = [
    md('mietvertrag.md', '# Mietvertrag\n## Kündigung\nDie Kündigungsfrist beträgt drei Monate zum Monatsende.\n## Kaution\nDie Kaution beträgt drei Nettokaltmieten.'),
    md('heizung.md', '# Heizung\n## Wartung\nDie Heizung wird einmal im Jahr gewartet. Der Filter muss gewechselt werden.\n## Störung\nBei Störung den Hauptschalter aus- und wieder einschalten.'),
    md('garten.md', '---\ntags: [hobby]\n---\n# Garten\nTomaten werden im Mai gepflanzt, Salat schon im April.'),
  ]
  const index = new LibraryIndex(docs)

  it('finds the right passage across word forms and umlauts', () => {
    const [top] = index.search('Wie lang ist die Kündigungsfrist?')
    expect(top!.source).toBe('Mietvertrag, Kündigung')
    expect(top!.text).toContain('drei Monate')
  })

  it('ranks by distinctive words, not by filler', () => {
    expect(index.search('Wann pflanze ich Tomaten?')[0]!.docId).toBe('garten.md')
    expect(index.search('Heizung Störung was tun')[0]!.text).toContain('Hauptschalter')
  })

  it('returns nothing when no word of the question occurs', () => {
    expect(index.search('Wer ist der Bundeskanzler?')).toEqual([])
    expect(index.search('   ')).toEqual([])
    expect(new LibraryIndex([]).search('Heizung')).toEqual([])
  })

  it('finds documents by tag and by file name', () => {
    expect(index.search('hobby')[0]!.docId).toBe('garten.md')
    expect(index.search('Mietvertrag')[0]!.docId).toBe('mietvertrag.md')
  })

  it('prefers documents of the current topic', () => {
    const a = md('a.md', 'Das Dach kostet viel Geld.')
    const b = md('b.md', 'Das Dach kostet viel Geld.')
    b.topicId = 't1'
    const idx = new LibraryIndex([a, b])
    expect(idx.search('Dach Kosten', { topicId: 't1' })[0]!.docId).toBe('b.md')
    expect(idx.search('Dach Kosten', { topicId: 'other' })).toHaveLength(2)
  })

  it('names PDF passages with their page and respects the limits', () => {
    const pdf = buildDoc({ kind: 'pdf', name: 'vertrag.pdf', path: 'vertrag.pdf', pages: ['Allgemeines', 'Die Laufzeit beträgt zwei Jahre.'] }, 'p')
    const [hit] = new LibraryIndex([pdf]).search('Laufzeit')
    expect(hit!.source).toBe('vertrag.pdf, Seite 2')

    const many = Array.from({ length: 30 }, (_, i) => md(`n${i}.md`, `Dach ${i} ${'Text zum Dach. '.repeat(40)}`))
    const found = new LibraryIndex(many).search('Dach', { limit: 5, budget: 1500 })
    expect(found.length).toBeLessThanOrEqual(5)
    expect(found.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(1500 + 700)
  })
})

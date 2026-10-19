import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { docxToText, isZip, readBuffer, readZipBuffer, wordXmlToText, ZIP_LIMITS } from './ingest.ts'
import { buildDoc, kindOf } from './library.ts'

const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))).buffer as ArrayBuffer

describe('readZipBuffer', () => {
  it('returns readable files with their folder path, sorted, and keeps umlauts in names and text', async () => {
    const { entries, skipped } = await readZipBuffer(
      zip({
        'PhD/Übersicht.md': '# Übersicht\nKündigung',
        'PhD/Literatur/A_Verified/Nübel 2013.md': 'Text',
        'PhD/notiz.txt': 'Notiz',
        'PhD/bild.png': 'kein Dokument',
        'PhD/Folien.pptx': 'auch nicht',
      }),
    )
    expect(entries.map(e => e.path)).toEqual(['PhD/Literatur/A_Verified/Nübel 2013.md', 'PhD/notiz.txt', 'PhD/Übersicht.md'])
    expect(entries[0]!.name).toBe('Nübel 2013.md')
    expect(new TextDecoder().decode(entries[2]!.data)).toContain('Kündigung')
    expect(skipped).toEqual([])
  })

  it('leaves out hidden folders such as .trash and .obsidian, and macOS resource forks', async () => {
    const { entries } = await readZipBuffer(
      zip({
        'Tresor/.trash/alt.md': 'x',
        'Tresor/.obsidian/config.md': 'x',
        '__MACOSX/Tresor/._a.md': 'x',
        'Tresor/.versteckt.md': 'x',
        'Tresor/ok.md': 'ok',
      }),
    )
    expect(entries.map(e => e.path)).toEqual(['Tresor/ok.md'])
  })

  it('skips an entry above the size limit and says so', async () => {
    const big = new Uint8Array(ZIP_LIMITS.entryBytes + 1)
    const { entries, skipped } = await readZipBuffer(zip({ 'a/riesig.pdf': big, 'a/klein.md': 'ok' }))
    expect(entries.map(e => e.path)).toEqual(['a/klein.md'])
    expect(skipped).toEqual([expect.stringContaining('riesig.pdf')])
  })

  it('rejects something that is not a ZIP', async () => {
    await expect(readZipBuffer(new TextEncoder().encode('kein zip').buffer as ArrayBuffer)).rejects.toBeTruthy()
  })

  it('hands every entry to the document reader with the path as given', async () => {
    const { entries } = await readZipBuffer(zip({ 'Haus/dach.md': '# Dach\nKostet 12000 Euro.' }))
    const raw = await readBuffer(entries[0]!.name, entries[0]!.path, entries[0]!.data)
    expect(raw).toMatchObject({ kind: 'md', name: 'dach.md', path: 'Haus/dach.md', text: '# Dach\nKostet 12000 Euro.' })
  })
})

describe('isZip', () => {
  it('recognises ZIP names', () => {
    expect(isZip('PhD.zip')).toBe(true)
    expect(isZip('PhD.ZIP')).toBe(true)
    expect(isZip('PhD.zip.md')).toBe(false)
  })
})

const W = (body: string) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`
const para = (text: string, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

describe('Word documents', () => {
  it('turns paragraphs, headings and tables into text', () => {
    const xml = W(
      para('Mietvertrag', 'Heading1') +
        para('Die Kündigungsfrist beträgt <drei> Monate &amp; Tage.') +
        para('Kaution', 'berschrift2') +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Miete</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>900</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '<w:p></w:p>',
    )
    expect(wordXmlToText(xml.replace('<drei>', 'drei'))).toBe('# Mietvertrag\n\nDie Kündigungsfrist beträgt drei Monate & Tage.\n\n## Kaution\n\nMiete\n\n900')
  })

  it('decodes character references and keeps tabs and line breaks inside a paragraph', () => {
    const xml = W('<w:p><w:r><w:t>Gr&#252;&#x00DF;e</w:t><w:tab/><w:t>Boss</w:t><w:br/><w:t>Zeile 2</w:t></w:r></w:p>')
    expect(wordXmlToText(xml)).toBe('Grüße\tBoss\nZeile 2')
  })

  it('reads a .docx file and builds a searchable document with headings as sections', async () => {
    const docx = zipSync({ 'word/document.xml': strToU8(W(para('Vertrag', 'Heading1') + para('Allgemeines', 'Heading2') + para('Die Laufzeit beträgt zwei Jahre.'))), '[Content_Types].xml': strToU8('<x/>') })
    expect(await docxToText(docx.buffer as ArrayBuffer)).toContain('Die Laufzeit beträgt zwei Jahre.')
    const raw = await readBuffer('vertrag.docx', 'Verträge/vertrag.docx', docx.buffer as ArrayBuffer)
    expect(raw.kind).toBe('docx')
    const doc = buildDoc(raw, 'id')
    expect(doc.kind).toBe('docx')
    expect(doc.title).toBe('Vertrag')
    expect(doc.chunks[0]!.heading).toBe('Vertrag > Allgemeines')
  })

  it('refuses a file that is not a Word document, and other types', async () => {
    await expect(docxToText(zipSync({ 'a.txt': strToU8('x') }).buffer as ArrayBuffer)).rejects.toThrow('word/document.xml')
    await expect(readBuffer('bild.png', 'bild.png', new ArrayBuffer(1))).rejects.toThrow('nur MD, TXT, PDF und DOCX')
    expect(kindOf('A.DOCX')).toBe('docx')
  })

  it('finds .docx files in a ZIP and skips Word lock files', async () => {
    const d = zipSync({ 'word/document.xml': strToU8(W(para('x'))) }).buffer as ArrayBuffer
    const inner = new Uint8Array(d)
    const { entries } = await readZipBuffer(zip({ 'Ordner/a.docx': inner, 'Ordner/~$a.docx': inner }))
    expect(entries.map(e => e.path)).toEqual(['Ordner/a.docx'])
  })
})

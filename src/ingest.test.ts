import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { isZip, readBuffer, readZipBuffer, ZIP_LIMITS } from './ingest.ts'

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
        'PhD/Programm.docx': 'auch nicht',
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

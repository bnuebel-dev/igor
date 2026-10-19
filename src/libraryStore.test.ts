import { describe, expect, it } from 'vitest'
import { LibraryStore } from './libraryStore.ts'
import type { Kv } from './storage.ts'

function memoryKv(opts: { failWrites?: () => boolean } = {}): Kv & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    backend: 'browser',
    async get(k) {
      return data.get(k) ?? ''
    },
    async set(k, v) {
      if (opts.failWrites?.()) return false
      data.set(k, v)
      return true
    },
  }
}

const log = () => undefined
const md = (name: string, text: string, path = name) => ({ kind: 'md' as const, name, path, text })

describe('LibraryStore', () => {
  it('stores documents, finds them, and survives a restart', async () => {
    const kv = memoryKv()
    const store = new LibraryStore(kv, log)
    const r = await store.add(md('mietvertrag.md', '# Mietvertrag\nDie Kündigungsfrist beträgt drei Monate.', 'Verträge/mietvertrag.md'))
    expect(r).toMatchObject({ ok: true, replaced: false })
    expect(store.search('Kündigungsfrist')[0]!.text).toContain('drei Monate')

    const again = new LibraryStore(kv, log)
    await again.load()
    expect(again.list().map(d => d.path)).toEqual(['Verträge/mietvertrag.md'])
    expect(again.search('Kündigungsfrist')).toHaveLength(1)
  })

  it('replaces the same path, keeps its topic, and does not duplicate', async () => {
    const store = new LibraryStore(memoryKv(), log)
    const first = await store.add(md('a.md', 'Alter Text über das Dach.', 'Haus/a.md'))
    if (!first.ok) throw new Error('add failed')
    await store.setTopic(first.doc.id, 't1')
    const second = await store.add(md('a.md', 'Neuer Text über den Keller.', 'Haus/a.md'))
    expect(second).toMatchObject({ ok: true, replaced: true })
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.topicId).toBe('t1')
    expect(store.search('Dach')).toEqual([])
    expect(store.search('Keller')).toHaveLength(1)
  })

  it('removes documents and frees their storage entry', async () => {
    const kv = memoryKv()
    const store = new LibraryStore(kv, log)
    const r = await store.add(md('a.md', 'Text zum Dach.'))
    if (!r.ok) throw new Error('add failed')
    expect(await store.remove(r.doc.id)).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.search('Dach')).toEqual([])
    await new Promise(res => setTimeout(res, 0))
    expect([...kv.data.entries()].filter(([k, v]) => k.startsWith('igor.lib.d.') && v)).toEqual([])
    expect(await store.remove('gibt-es-nicht')).toBe(false)
  })

  it('refuses empty documents with a helpful reason', async () => {
    const store = new LibraryStore(memoryKv(), log)
    expect(await store.add(md('leer.md', '   '))).toMatchObject({ ok: false })
    const pdf = await store.add({ kind: 'pdf', name: 'scan.pdf', path: 'scan.pdf', pages: ['', ' '] })
    expect(pdf).toMatchObject({ ok: false, reason: expect.stringContaining('eingescanntes PDF') })
  })

  it('leaves the library unchanged when the storage refuses the write', async () => {
    let fail = false
    const store = new LibraryStore(memoryKv({ failWrites: () => fail }), log)
    await store.add(md('a.md', 'Text zum Dach.'))
    fail = true
    const r = await store.add(md('b.md', 'Text zum Keller.'))
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('abgelehnt') })
    expect(store.list().map(d => d.name)).toEqual(['a.md'])
    expect(store.search('Keller')).toEqual([])
  })

  it('moves documents of a deleted topic back to no topic', async () => {
    const store = new LibraryStore(memoryKv(), log)
    const r = await store.add(md('a.md', 'Text.'))
    if (!r.ok) throw new Error('add failed')
    await store.setTopic(r.doc.id, 't1')
    await store.dropTopic('t1')
    expect(store.list()[0]!.topicId).toBeNull()
  })

  it('skips a damaged document at load time instead of failing', async () => {
    const kv = memoryKv()
    const store = new LibraryStore(kv, log)
    const a = await store.add(md('a.md', 'Text zum Dach.'))
    await store.add(md('b.md', 'Text zum Keller.'))
    if (!a.ok) throw new Error('add failed')
    kv.data.set(`igor.lib.d.${a.doc.id}`, '{kaputt')
    const lines: string[] = []
    const again = new LibraryStore(kv, (_l, m) => lines.push(m))
    await again.load()
    expect(again.list().map(d => d.name)).toEqual(['b.md'])
    expect(lines.some(l => l.includes('a.md'))).toBe(true)
  })

  it('writes the index once for a batch and tells the listeners once', async () => {
    const kv = memoryKv()
    const store = new LibraryStore(kv, log)
    let notified = 0
    store.subscribe(() => notified++)
    let indexWrites = 0
    const set = kv.set.bind(kv)
    kv.set = async (k, v) => (k === 'igor.lib.idx' && indexWrites++, set(k, v))

    for (let i = 0; i < 25; i++) await store.add(md(`n${i}.md`, `Notiz ${i} zum Dach.`, `Ordner/n${i}.md`), { batch: true })
    expect(indexWrites).toBe(0)
    expect(notified).toBe(0)
    expect(store.search('Dach').length).toBeGreaterThan(0) // searchable before the commit

    expect(await store.commit()).toBe(true)
    expect(indexWrites).toBe(1)
    expect(notified).toBe(1)

    const again = new LibraryStore(kv, log)
    await again.load()
    expect(again.list()).toHaveLength(25)
  })

  it('reports a failed commit and a failed batch write', async () => {
    let fail = false
    const kv = memoryKv({ failWrites: () => fail })
    const store = new LibraryStore(kv, log)
    await store.add(md('a.md', 'Text.'), { batch: true })
    fail = true
    expect(await store.commit()).toBe(false)
    expect(await store.add(md('b.md', 'Text.'), { batch: true })).toMatchObject({ ok: false })
  })

  it('clears everything and frees the entries', async () => {
    const kv = memoryKv()
    const store = new LibraryStore(kv, log)
    await store.add(md('a.md', 'Text zum Dach.'))
    await store.add(md('b.md', 'Text zum Keller.'))
    expect(await store.clear()).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.search('Dach')).toEqual([])
    await new Promise(res => setTimeout(res, 0))
    expect([...kv.data.entries()].filter(([k, v]) => k.startsWith('igor.lib.d.') && v)).toEqual([])
    const again = new LibraryStore(kv, log)
    await again.load()
    expect(again.list()).toEqual([])
  })
})

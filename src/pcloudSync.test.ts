import { describe, expect, it } from 'vitest'
import { flatten, MAX_FILE_BYTES, planSync, type RemoteFile } from './pcloudSync.ts'
import type { DocMeta } from './library.ts'

const tree = {
  name: 'Notizen',
  contents: [
    { name: 'a.md', fileid: 1, hash: 11, size: 100 },
    { name: 'bild.png', fileid: 2, hash: 12, size: 5000 },
    { name: 'Haus', isfolder: true, folderid: 9, contents: [
      { name: 'dach.PDF', fileid: 3, hash: 13, size: 2000 },
      { name: 'Keller', isfolder: true, contents: [{ name: 'plan.txt', fileid: 4, hash: 14, size: 10 }] },
    ] },
    { name: 'riesig.pdf', fileid: 5, hash: 15, size: MAX_FILE_BYTES + 1 },
  ],
}

const meta = (path: string, hash: string | null, extra: Partial<DocMeta> = {}): DocMeta => ({
  id: path, name: path.split('/').pop()!, path, kind: 'md', title: path, tags: [], topicId: null, chars: 1, addedAt: 0,
  ...(hash === null ? {} : { remote: { fileid: 1, hash } }), ...extra,
})

describe('flatten', () => {
  it('lists readable files with their path from the chosen folder, skipping other types and huge files', () => {
    const { files, skipped } = flatten(tree, 'Notizen')
    expect(files.map(f => f.path)).toEqual(['Notizen/a.md', 'Notizen/Haus/dach.PDF', 'Notizen/Haus/Keller/plan.txt'])
    expect(skipped).toEqual([expect.stringContaining('riesig.pdf')])
  })

  it('copes with an empty or missing folder', () => {
    expect(flatten({ name: 'x' }, 'x').files).toEqual([])
    expect(flatten(undefined, 'x').files).toEqual([])
  })
})

describe('planSync', () => {
  const remote: RemoteFile[] = flatten(tree, 'Notizen').files

  it('adds everything on the first run', () => {
    const plan = planSync(remote, [], 'Notizen')
    expect(plan.add).toHaveLength(3)
    expect(plan).toMatchObject({ update: [], remove: [], same: 0 })
  })

  it('leaves unchanged files alone and reloads changed ones', () => {
    const local = [meta('Notizen/a.md', '11'), meta('Notizen/Haus/dach.PDF', 'alt'), meta('Notizen/Haus/Keller/plan.txt', '14')]
    const plan = planSync(remote, local, 'Notizen')
    expect(plan.same).toBe(2)
    expect(plan.update.map(f => f.path)).toEqual(['Notizen/Haus/dach.PDF'])
    expect(plan.add).toEqual([])
  })

  it('removes documents that vanished from the folder, but never manual uploads', () => {
    const local = [
      meta('Notizen/a.md', '11'),
      meta('Notizen/weg.md', '99'), // came from pCloud, now gone
      meta('Notizen/Hand.md', null), // same prefix but uploaded by hand
      meta('Anderswo/x.md', '5'), // other folder
    ]
    const plan = planSync(remote.slice(0, 1), local, 'Notizen')
    expect(plan.remove.map(d => d.path)).toEqual(['Notizen/weg.md'])
  })

  it('takes over a manually uploaded file with the same path', () => {
    const plan = planSync(remote.slice(0, 1), [meta('Notizen/a.md', null)], 'Notizen')
    expect(plan.update.map(f => f.path)).toEqual(['Notizen/a.md'])
  })
})

import { describeReport, runSync, type SyncDeps } from './pcloudSync.ts'
import type { RawDoc } from './library.ts'

describe('runSync', () => {
  function fakes(over: Partial<SyncDeps> = {}, local: DocMeta[] = []) {
    const added: string[] = []
    const removed: string[] = []
    const progress: string[] = []
    const deps: SyncDeps = {
      listTree: async () => tree,
      download: async id => new TextEncoder().encode(`Inhalt ${id}`).buffer as ArrayBuffer,
      read: async (name, path, data): Promise<RawDoc> => ({ kind: 'md', name, path, text: new TextDecoder().decode(data) }),
      library: {
        list: () => local,
        add: async raw => (added.push(raw.path), { ok: true }),
        remove: async id => (removed.push(id), true),
      },
      progress: m => void progress.push(m),
      ...over,
    }
    return { deps, added, removed, progress }
  }

  it('loads new files, reports progress, and describes the result', async () => {
    const f = fakes()
    const report = await runSync({ folderid: 7, name: 'Notizen' }, f.deps)
    expect(f.added).toEqual(['Notizen/a.md', 'Notizen/Haus/dach.PDF', 'Notizen/Haus/Keller/plan.txt'])
    expect(f.progress.some(m => m.startsWith('Lade 3 von 3'))).toBe(true)
    expect(describeReport(report)).toBe('3 neu, 0 geändert, 0 entfernt, 0 unverändert, 1 übersprungen')
  })

  it('keeps going when one file fails and reports it', async () => {
    const f = fakes({
      download: async id => {
        if (id === 3) throw new Error('Download: HTTP 500')
        return new ArrayBuffer(1)
      },
    })
    const report = await runSync({ folderid: 7, name: 'Notizen' }, f.deps)
    expect(report.added).toBe(2)
    expect(report.failed).toEqual(['Notizen/Haus/dach.PDF: Download: HTTP 500'])
  })

  it('stops at once when the pCloud login has expired', async () => {
    const f = fakes({
      download: async () => {
        throw Object.assign(new Error('Anmeldung abgelaufen'), { code: 2000 })
      },
    })
    await expect(runSync({ folderid: 7, name: 'Notizen' }, f.deps)).rejects.toThrow('Anmeldung abgelaufen')
  })

  it('removes vanished documents after loading the rest', async () => {
    const local = [meta('Notizen/weg.md', '99')]
    const f = fakes({}, local)
    const report = await runSync({ folderid: 7, name: 'Notizen' }, f.deps)
    expect(f.removed).toEqual(['Notizen/weg.md'])
    expect(report.removed).toBe(1)
  })

  it('reports a document the library refuses', async () => {
    const f = fakes({
      library: { list: () => [], add: async raw => ({ ok: false, reason: `${raw.name}: kein Text gefunden` }), remove: async () => true },
    })
    const report = await runSync({ folderid: 7, name: 'Notizen' }, f.deps)
    expect(report.failed).toHaveLength(3)
    expect(report.added).toBe(0)
  })
})

import { FAIL_LIMIT } from './pcloudSync.ts'

describe('runSync safeguards', () => {
  it('skips hidden folders such as .trash', () => {
    const t = { name: 'x', contents: [{ name: '.trash', isfolder: true, contents: [{ name: 'alt.md', fileid: 1, hash: 1, size: 1 }] }, { name: 'ok.md', fileid: 2, hash: 2, size: 1 }] }
    expect(flatten(t, 'x').files.map(f => f.path)).toEqual(['x/ok.md'])
  })

  it('stops after a run of failed downloads instead of repeating the same error', async () => {
    const many = { name: 'x', contents: Array.from({ length: 30 }, (_, i) => ({ name: `n${i}.md`, fileid: i, hash: i, size: 1 })) }
    let calls = 0
    const deps: SyncDeps = {
      listTree: async () => many,
      download: async () => {
        calls++
        throw new Error('Invalid link referer')
      },
      read: async () => ({ kind: 'md', name: 'a', path: 'a', text: '' }),
      library: { list: () => [], add: async () => ({ ok: true }), remove: async () => true },
      progress: () => {},
    }
    await expect(runSync({ folderid: 1, name: 'x' }, deps)).rejects.toThrow(/hintereinander fehlgeschlagen.*Invalid link referer/)
    expect(calls).toBe(FAIL_LIMIT)
  })

  it('a refused document in between does not count as a connection problem', async () => {
    const many = { name: 'x', contents: Array.from({ length: 12 }, (_, i) => ({ name: `n${i}.md`, fileid: i, hash: i, size: 1 })) }
    const deps: SyncDeps = {
      listTree: async () => many,
      download: async () => new ArrayBuffer(1),
      read: async (name, path) => ({ kind: 'md', name, path, text: '' }),
      library: { list: () => [], add: async raw => ({ ok: false, reason: `${raw.name}: kein Text` }), remove: async () => true },
      progress: () => {},
    }
    const report = await runSync({ folderid: 1, name: 'x' }, deps)
    expect(report.failed).toHaveLength(12)
  })
})

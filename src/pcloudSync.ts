import { kindOf, type DocMeta, type RawDoc } from './library.ts'

export type RemoteFile = { path: string; name: string; fileid: number; hash: string; size: number }

/** Files above this size are skipped: the phone has to read them into memory and parse them. */
export const MAX_FILE_BYTES = 30 * 1024 * 1024

/** All readable files below a pCloud folder (as returned by listfolder recursive=1), with their path from the chosen folder. */
export function flatten(tree: any, rootName: string): { files: RemoteFile[]; skipped: string[] } {
  const files: RemoteFile[] = []
  const skipped: string[] = []
  const walk = (node: any, prefix: string) => {
    for (const c of node?.contents ?? []) {
      if (c.isfolder) {
        walk(c, `${prefix}/${c.name}`)
      } else if (kindOf(c.name)) {
        const path = `${prefix}/${c.name}`
        if ((c.size ?? 0) > MAX_FILE_BYTES) skipped.push(`${path} (${Math.round(c.size / 1024 / 1024)} MB, zu groß)`)
        else files.push({ path, name: c.name, fileid: c.fileid, hash: String(c.hash ?? c.modified ?? ''), size: c.size ?? 0 })
      }
    }
  }
  walk(tree, rootName)
  return { files, skipped }
}

export type SyncPlan = { add: RemoteFile[]; update: RemoteFile[]; remove: DocMeta[]; same: number }

/**
 * What has to change so the library mirrors the folder. Only documents that came from this
 * folder (they carry a pCloud id and its path prefix) can be removed; uploads stay.
 */
export function planSync(remote: RemoteFile[], local: DocMeta[], rootName: string): SyncPlan {
  const byPath = new Map(local.map(d => [d.path, d]))
  const plan: SyncPlan = { add: [], update: [], remove: [], same: 0 }
  const seen = new Set<string>()
  for (const f of remote) {
    seen.add(f.path)
    const have = byPath.get(f.path)
    if (!have) plan.add.push(f)
    else if (!have.remote || have.remote.hash !== f.hash) plan.update.push(f)
    else plan.same++
  }
  for (const d of local) {
    if (d.remote && d.path.startsWith(`${rootName}/`) && !seen.has(d.path)) plan.remove.push(d)
  }
  return plan
}

// ---- Running a sync ---------------------------------------------------------------------------

export type SyncDeps = {
  listTree(folderid: number): Promise<any>
  download(fileid: number): Promise<ArrayBuffer>
  read(name: string, path: string, data: ArrayBuffer): Promise<RawDoc>
  library: {
    list(): DocMeta[]
    add(raw: RawDoc, remote: DocMeta['remote']): Promise<{ ok: true } | { ok: false; reason: string }>
    remove(id: string): Promise<boolean>
  }
  progress(message: string): void
}

export type SyncReport = { added: number; updated: number; removed: number; same: number; failed: string[]; skipped: string[] }

const isAuthError = (err: unknown) => (err as { code?: number })?.code === 1000 || (err as { code?: number })?.code === 2000

/** Mirrors the folder into the library; one bad file is reported and does not stop the others. */
export async function runSync(folder: { folderid: number; name: string }, d: SyncDeps): Promise<SyncReport> {
  d.progress('Lese Ordnerliste …')
  const { files, skipped } = flatten(await d.listTree(folder.folderid), folder.name)
  const plan = planSync(files, d.library.list(), folder.name)
  const report: SyncReport = { added: 0, updated: 0, removed: 0, same: plan.same, failed: [], skipped }
  const todo = [...plan.add.map(f => ({ f, isNew: true })), ...plan.update.map(f => ({ f, isNew: false }))]

  let done = 0
  for (const { f, isNew } of todo) {
    d.progress(`Lade ${++done} von ${todo.length}: ${f.name}`)
    try {
      const raw = await d.read(f.name, f.path, await d.download(f.fileid))
      const r = await d.library.add(raw, { fileid: f.fileid, hash: f.hash })
      if (r.ok) report[isNew ? 'added' : 'updated']++
      else report.failed.push(r.reason)
    } catch (err) {
      if (isAuthError(err)) throw err
      report.failed.push(`${f.path}: ${(err as Error).message}`)
    }
  }
  for (const doc of plan.remove) if (await d.library.remove(doc.id)) report.removed++
  return report
}

export function describeReport(r: SyncReport): string {
  const parts = [`${r.added} neu`, `${r.updated} geändert`, `${r.removed} entfernt`, `${r.same} unverändert`]
  if (r.failed.length) parts.push(`${r.failed.length} fehlgeschlagen`)
  if (r.skipped.length) parts.push(`${r.skipped.length} übersprungen`)
  return parts.join(', ')
}

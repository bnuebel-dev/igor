import { kindOf, type RawDoc } from './library.ts'

/** Text of every page of a PDF. pdf.js is large, so it is loaded only when a PDF arrives. */
export async function pdfPages(data: ArrayBuffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise
  try {
    const pages: string[] = []
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent()
      let text = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        text += item.str
        text += item.hasEOL ? '\n' : ' '
      }
      pages.push(text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim())
    }
    return pages
  } finally {
    await doc.cleanup()
  }
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENTITIES[e.toLowerCase()]!,
  )

/** Plain text of a Word document: one line per paragraph, headings as Markdown "#" lines. Tables become tab-separated rows. */
export function wordXmlToText(xml: string): string {
  const lines: string[] = []
  for (const para of xml.split(/<\/w:p>/)) {
    const style = /<w:pStyle w:val="([^"]*)"/.exec(para)?.[1] ?? ''
    const level = /^(?:Heading|berschrift|Titel|Title)(\d?)/i.exec(style)
    let text = ''
    for (const m of para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:tc>/g)) {
      text += m[1] !== undefined ? decodeXml(m[1]) : m[0] === '</w:tc>' ? '\t' : m[0] === '<w:tab/>' ? '\t' : '\n'
    }
    text = text.replace(/\t+$/, '').trim()
    if (!text) continue
    lines.push(level ? `${'#'.repeat(Math.min(6, Number(level[1]) || 1))} ${text}` : text)
  }
  return lines.join('\n\n')
}

export async function docxToText(data: ArrayBuffer): Promise<string> {
  const { unzip } = await import('fflate')
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(new Uint8Array(data), { filter: f => f.name === 'word/document.xml' }, (err, out) => (err ? reject(err) : resolve(out))),
  )
  const xml = files['word/document.xml']
  if (!xml) throw new Error('keine Word-Datei (word/document.xml fehlt)')
  return wordXmlToText(new TextDecoder('utf-8').decode(xml))
}

/** Turns file content into a document the library can take; throws a message the user can read. */
export async function readBuffer(name: string, path: string, data: ArrayBuffer): Promise<RawDoc> {
  const kind = kindOf(name)
  if (!kind) throw new Error('nur MD, TXT, PDF und DOCX werden gelesen')
  if (kind === 'pdf') return { kind, name, path, pages: await pdfPages(data) }
  if (kind === 'docx') return { kind, name, path, text: await docxToText(data) }
  return { kind, name, path, text: new TextDecoder('utf-8').decode(data) }
}

export async function readFile(file: File, path = file.webkitRelativePath || file.name): Promise<RawDoc> {
  return readBuffer(file.name, path, await file.arrayBuffer())
}

// ---- ZIP archives -----------------------------------------------------------------------------
// The file picker of the Even app's WebView cannot select a folder, but it can select one ZIP file,
// which carries a whole folder tree.

export const ZIP_LIMITS = { entryBytes: 30 * 1024 * 1024, totalBytes: 400 * 1024 * 1024, entries: 5000 }

export type ZipEntry = { name: string; path: string; data: ArrayBuffer }
export type ZipContents = { entries: ZipEntry[]; skipped: string[] }

export const isZip = (name: string) => /\.zip$/i.test(name)

// Hidden folders, macOS resource forks and the lock files Word leaves next to open documents (~$name.docx).
const isHiddenPath = (path: string) => path.split('/').some(seg => seg.startsWith('.') || seg.startsWith('~$') || seg === '__MACOSX')

/** Readable files of a ZIP with their folder path. Hidden folders (.trash, .obsidian), other file types and huge entries are left out. */
export async function readZipBuffer(data: ArrayBuffer): Promise<ZipContents> {
  const { unzip } = await import('fflate')
  const skipped: string[] = []
  let total = 0
  let count = 0
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(
      new Uint8Array(data),
      {
        // Decided from the directory, before anything is inflated: unwanted entries cost no memory.
        filter: file => {
          const path = file.name.replace(/^\.?\/+/, '')
          if (path.endsWith('/') || isHiddenPath(path) || !kindOf(path)) return false
          if (file.originalSize > ZIP_LIMITS.entryBytes) {
            skipped.push(`${path} (${Math.round(file.originalSize / 1024 / 1024)} MB, zu groß)`)
            return false
          }
          if (count >= ZIP_LIMITS.entries || total + file.originalSize > ZIP_LIMITS.totalBytes) {
            skipped.push(`${path} (Archiv zu groß)`)
            return false
          }
          count++
          total += file.originalSize
          return true
        },
      },
      (err, out) => (err ? reject(err) : resolve(out)),
    )
  })
  const entries = Object.entries(files)
    .map(([raw, bytes]) => {
      const path = raw.replace(/^\.?\/+/, '')
      return { name: path.split('/').pop()!, path, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
    })
    .sort((a, b) => a.path.localeCompare(b.path, 'de'))
  return { entries, skipped }
}

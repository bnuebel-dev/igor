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

/** Reads a picked file into a document the library can take; throws a message the user can read. */
export async function readFile(file: File, path = file.webkitRelativePath || file.name): Promise<RawDoc> {
  const kind = kindOf(file.name)
  if (!kind) throw new Error(`${file.name}: nur MD, TXT und PDF werden gelesen`)
  if (kind === 'pdf') return { kind, name: file.name, path, pages: await pdfPages(await file.arrayBuffer()) }
  return { kind, name: file.name, path, text: await file.text() }
}

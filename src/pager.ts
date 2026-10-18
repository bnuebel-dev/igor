// Split a long answer into pages that fit the 576x288 glasses display exactly.
// A page is a plain string; the caller adds the footer. Measuring is injected so the
// logic can be tested without the firmware font tables.

/** Number of display lines the text needs when wrapped to the container width. */
export type LineCounter = (text: string) => number

/** Display geometry: 10 lines fit; one is left free for the footer and one as slack. */
export const TEXT_LINES_PER_PAGE = 8

/**
 * Greedy, word-based pagination. Explicit line breaks are kept. A single word that
 * is longer than a page (an URL, say) is split by characters.
 */
export function paginate(text: string, lineCount: LineCounter, maxLines = TEXT_LINES_PER_PAGE): string[] {
  const clean = text.replace(/\r\n?/g, '\n').trim()
  if (!clean) return ['']

  const tokens = clean.match(/\s+|\S+/g) ?? []
  const pages: string[] = []
  let page = ''

  const fits = (candidate: string) => lineCount(candidate.trimEnd()) <= maxLines
  const flush = () => {
    const done = page.trim()
    if (done) pages.push(done)
    page = ''
  }

  for (const token of tokens) {
    if (/^\s+$/.test(token) && page === '') continue // no whitespace at the top of a page
    if (fits(page + token)) {
      page += token
      continue
    }
    if (/^\s+$/.test(token)) {
      // The break falls into whitespace: end the page here.
      flush()
      continue
    }
    flush()
    if (fits(token)) {
      page = token
      continue
    }
    // Oversized word: fill pages character by character.
    let rest = [...token]
    while (rest.length) {
      let n = rest.length
      while (n > 1 && !fits(rest.slice(0, n).join(''))) n--
      pages.push(rest.slice(0, n).join(''))
      rest = rest.slice(n)
    }
  }
  flush()
  return pages.length ? pages : ['']
}

/** "Seite 2/4  ▲▼" style footer; the single-page case needs no paging hint. */
export function pageFooter(index: number, total: number, hint: string): string {
  if (total <= 1) return hint
  const arrows = index === 0 ? '▼' : index === total - 1 ? '▲' : '▲▼'
  return `${arrows} ${index + 1}/${total}  ${hint}`.trim()
}

// Text helpers for the G2 display: one firmware font, no Markdown, no emoji,
// and a byte limit per text container.

/** Upper bound for one text container. Firmware allows 1000 chars; the simulator caps at 999 bytes. */
export const MAX_CONTAINER_BYTES = 990

const encoder = new TextEncoder()

export function utf8Length(text: string): number {
  return encoder.encode(text).length
}

/** Cut text to at most `maxBytes` UTF-8 bytes without splitting a character; appends '…' when cut. */
export function clampUtf8(text: string, maxBytes = MAX_CONTAINER_BYTES): string {
  if (utf8Length(text) <= maxBytes) return text
  const ellipsis = '…'
  const budget = maxBytes - utf8Length(ellipsis)
  let used = 0
  let out = ''
  for (const ch of text) {
    const size = utf8Length(ch)
    if (used + size > budget) break
    out += ch
    used += size
  }
  return out + ellipsis
}

// Emoji and pictographs are missing from the firmware font.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu

/** Turn a model answer into plain text the glasses can render. */
export function sanitizeForGlasses(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Web search answers: footnote markers and bare links are noise on the glasses.
    .replace(/\s?\[\d+(?:[,\s]*\d+)*\]/g, '')
    .replace(/\s?\(https?:\/\/[^\s)]+\)|\s?<?https?:\/\/[^\s)>]+>?/g, '')
    .replace(EMOJI, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

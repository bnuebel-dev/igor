// Minimal Server-Sent-Events parser for OpenAI-style streaming responses.
// OpenRouter sends `data: {json}` lines, keep-alive comments (`: OPENROUTER PROCESSING`) and `data: [DONE]`.

export class SseParser {
  private buffer = ''

  /** Feed raw text; returns the `data` payloads of every complete event. */
  feed(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    let sep: number
    while ((sep = this.nextBoundary()) !== -1) {
      const block = this.buffer.slice(0, sep)
      this.buffer = this.buffer.slice(sep).replace(/^(\r?\n){1,2}/, '')
      const data = block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data) out.push(data)
    }
    return out
  }

  private nextBoundary(): number {
    const a = this.buffer.indexOf('\n\n')
    const b = this.buffer.indexOf('\r\n\r\n')
    if (a === -1) return b
    if (b === -1) return a
    return Math.min(a, b)
  }
}

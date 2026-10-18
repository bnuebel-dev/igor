// The G2 microphone delivers PCM s16le, 16 kHz, mono in small chunks.

export const SAMPLE_RATE = 16_000
const BYTES_PER_SECOND = SAMPLE_RATE * 2

/** Collects mic chunks up to a maximum duration. */
export class PcmRecorder {
  private chunks: Uint8Array[] = []
  private size = 0

  constructor(private readonly maxSeconds = 60) {}

  push(chunk: Uint8Array): void {
    const room = this.maxSeconds * BYTES_PER_SECOND - this.size
    if (room <= 0) return
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk
    this.chunks.push(part)
    this.size += part.length
  }

  get byteLength(): number {
    return this.size
  }

  get seconds(): number {
    return this.size / BYTES_PER_SECOND
  }

  get full(): boolean {
    return this.size >= this.maxSeconds * BYTES_PER_SECOND
  }

  take(): Uint8Array {
    const out = new Uint8Array(this.size)
    let offset = 0
    for (const c of this.chunks) {
      out.set(c, offset)
      offset += c.length
    }
    this.chunks = []
    this.size = 0
    return out
  }
}

/** Wrap raw PCM in a 44-byte WAV header (fallback for providers that reject headerless PCM). */
export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length)
  const v = new DataView(out.buffer)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, SAMPLE_RATE, true)
  v.setUint32(28, BYTES_PER_SECOND, true)
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/** Peak level 0..1 of a PCM chunk, for a simple recording meter. */
export function peakLevel(chunk: Uint8Array): number {
  const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  let peak = 0
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const s = Math.abs(v.getInt16(i, true))
    if (s > peak) peak = s
  }
  return peak / 32768
}

/** Float samples (-1..1) to little-endian signed 16-bit PCM. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const v = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!))
    v.setInt16(i * 2, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true)
  }
  return out
}

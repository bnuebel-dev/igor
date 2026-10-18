import { describe, expect, it } from 'vitest'
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { clampUtf8, sanitizeForGlasses, utf8Length } from './text.ts'
import { PcmRecorder, floatToPcm16, pcmToWav, peakLevel, toBase64 } from './pcm.ts'
import { SseParser } from './sse.ts'
import { createGestureFilter, gestureOf } from './events.ts'

describe('text', () => {
  it('clamps by UTF-8 bytes without splitting umlauts', () => {
    const s = 'ä'.repeat(600) // 1200 bytes
    const out = clampUtf8(s, 100)
    expect(utf8Length(out)).toBeLessThanOrEqual(100)
    expect(out.endsWith('…')).toBe(true)
    expect(out.replace('…', '')).toMatch(/^ä+$/)
  })

  it('keeps short text unchanged', () => {
    expect(clampUtf8('Hallo Boss')).toBe('Hallo Boss')
  })

  it('strips markdown and emoji', () => {
    const md = '# Titel\n**Fett** und *kursiv*, `code` 😀\n- Punkt\n[Link](https://x.y)'
    expect(sanitizeForGlasses(md)).toBe('Titel\nFett und kursiv, code\n• Punkt\nLink')
  })

  it('drops footnote markers and bare links from search answers', () => {
    const a = 'Laut Tagesschau steigt der Leitzins [1][2]. Mehr unter https://www.tagesschau.de/wirtschaft (Stand heute) [3, 4].'
    expect(sanitizeForGlasses(a)).toBe('Laut Tagesschau steigt der Leitzins. Mehr unter (Stand heute).')
    expect(sanitizeForGlasses('Quelle: (https://x.y/z)')).toBe('Quelle:')
    expect(sanitizeForGlasses('[[MERKEN: Hund heißt Rex]]')).toBe('[[MERKEN: Hund heißt Rex]]')
  })
})

describe('pcm', () => {
  it('collects chunks and caps at max duration', () => {
    const r = new PcmRecorder(1) // 32000 bytes
    r.push(new Uint8Array(20000))
    r.push(new Uint8Array(20000))
    expect(r.byteLength).toBe(32000)
    expect(r.full).toBe(true)
    expect(r.take().length).toBe(32000)
    expect(r.byteLength).toBe(0)
  })

  it('writes a valid WAV header', () => {
    const wav = pcmToWav(new Uint8Array(320))
    const text = (a: number, b: number) => String.fromCharCode(...wav.subarray(a, b))
    const v = new DataView(wav.buffer)
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 12)).toBe('WAVE')
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(40, true)).toBe(320)
    expect(wav.length).toBe(364)
  })

  it('base64-encodes large buffers', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    const decoded = Uint8Array.from(atob(toBase64(bytes)), c => c.charCodeAt(0))
    expect(decoded).toEqual(bytes)
  })

  it('converts float samples to s16le and clamps', () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]))
    const v = new DataView(pcm.buffer)
    const got = [0, 1, 2, 3, 4, 5].map(i => v.getInt16(i * 2, true))
    expect(got).toEqual([0, 32767, -32768, 16384, 32767, -32768])
  })

  it('measures peak level', () => {
    const chunk = new Uint8Array(4)
    new DataView(chunk.buffer).setInt16(2, -16384, true)
    expect(peakLevel(chunk)).toBeCloseTo(0.5)
  })
})

describe('sse', () => {
  it('handles split chunks, comments and DONE', () => {
    const p = new SseParser()
    expect(p.feed(': OPENROUTER PROCESSING\n\ndata: {"a"')).toEqual([])
    expect(p.feed(':1}\n\ndata: [DONE]\n\n')).toEqual(['{"a":1}', '[DONE]'])
  })

  it('handles CRLF line endings', () => {
    expect(new SseParser().feed('data: x\r\n\r\n')).toEqual(['x'])
  })
})

describe('events', () => {
  const ev = (e: Partial<EvenHubEvent>) => e as EvenHubEvent

  it('reads a tap without eventType', () => {
    expect(gestureOf(ev({ sysEvent: { eventSource: 1 } as never }))).toBe('tap')
  })

  it('does not treat audio frames as taps', () => {
    expect(gestureOf(ev({ audioEvent: { audioPcm: new Uint8Array(2) } as never }))).toBeNull()
  })

  it('maps explicit event types', () => {
    expect(gestureOf(ev({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } as never }))).toBe('double-tap')
    expect(gestureOf(ev({ textEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } as never }))).toBe('scroll-down')
    expect(gestureOf(ev({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } as never }))).toBe('long-release')
    expect(gestureOf(ev({ sysEvent: { eventType: OsEventTypeList.IMU_DATA_REPORT } as never }))).toBeNull()
  })

  it('drops duplicates inside the window', () => {
    let t = 0
    const accept = createGestureFilter({ foreground: 600 }, () => t)
    expect(accept('foreground')).toBe(true)
    t = 100
    expect(accept('foreground')).toBe(false)
    t = 800
    expect(accept('foreground')).toBe(true)
    expect(accept('tap')).toBe(true)
    expect(accept('tap')).toBe(true)
  })
})

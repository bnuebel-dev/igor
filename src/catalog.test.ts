import { describe, expect, it } from 'vitest'
import { CHAT_SPECS, STT_SPECS, resolveChoices, shortName, withSelected } from './catalog.ts'
import type { ModelInfo } from './openrouter.ts'

const m = (id: string, created = 0, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id,
  inputModalities: ['text'],
  outputModalities: ['text'],
  created,
  ...extra,
})

const catalog: ModelInfo[] = [
  m('google/gemini-2.5-flash', 100),
  m('google/gemini-3-flash-preview', 200),
  m('google/gemini-2.5-flash-lite', 110),
  m('google/gemini-2.5-flash-image', 300), // image model, must never win
  m('google/gemini-2.5-pro', 120),
  m('anthropic/claude-sonnet-4', 50),
  m('anthropic/claude-sonnet-4.5', 150),
  m('anthropic/claude-3.7-sonnet', 40),
  m('anthropic/claude-sonnet-4.5:thinking', 400), // variant with colon, excluded
  m('openai/gpt-5', 160, { promptPrice: '0.00000125', completionPrice: '0.00001' }),
  m('openai/gpt-5-mini', 170),
  m('openai/gpt-5-audio', 500),
  m('deepseek/deepseek-chat-v3.1', 130),
  m('meta-llama/llama-3.3-70b-instruct', 10), // not curated
]

describe('resolveChoices (chat)', () => {
  const choices = resolveChoices(CHAT_SPECS, catalog)

  it('uses the newest model of a family', () => {
    expect(choices.find(c => c.label === 'Gemini Flash')?.id).toBe('google/gemini-3-flash-preview')
    expect(choices.find(c => c.label === 'Claude Sonnet')?.id).toBe('anthropic/claude-sonnet-4.5')
  })

  it('keeps lite, image, audio and variants apart', () => {
    expect(choices.find(c => c.label === 'Gemini Lite')?.id).toBe('google/gemini-2.5-flash-lite')
    expect(choices.map(c => c.id)).not.toContain('google/gemini-2.5-flash-image')
    expect(choices.map(c => c.id)).not.toContain('openai/gpt-5-audio')
    expect(choices.map(c => c.id).some(id => id.includes(':'))).toBe(false)
  })

  it('shows short names with the tag in parentheses, and drops families without a match', () => {
    expect(choices.find(c => c.label === 'GPT Mini')?.text).toBe('GPT Mini (günstig)')
    expect(choices.some(c => c.label === 'Claude Opus')).toBe(false)
    expect(choices.some(c => c.id.startsWith('meta-llama'))).toBe(false)
  })

  it('formats the price per million tokens', () => {
    expect(choices.find(c => c.label === 'GPT')?.price).toBe('1,3 / 10 $ pro Mio. Tokens (rein / raus)')
  })

  it('never returns more than ten and never repeats an id', () => {
    const many = CHAT_SPECS.map((s, i) => m(s.fallback!, i + 1))
    const out = resolveChoices(CHAT_SPECS, many, { max: 10 })
    expect(out.length).toBeLessThanOrEqual(10)
    expect(new Set(out.map(c => c.id)).size).toBe(out.length)
  })
})

describe('resolveChoices (fallbacks and speech)', () => {
  it('shows the built-in picks when the catalog is empty', () => {
    const out = resolveChoices(CHAT_SPECS, [])
    expect(out.length).toBe(10)
    expect(out[0]!.id).toBe('google/gemini-2.5-flash')
  })

  it('offers only certain speech models offline', () => {
    const out = resolveChoices(STT_SPECS, [])
    expect(out.map(c => c.label)).toEqual(['Whisper Turbo', 'Whisper Large', 'Whisper'])
  })

  it('picks speech models from the live list and fills up when few families match', () => {
    const stt = [m('openai/whisper-large-v3-turbo'), m('acme/hear-7b'), m('acme/other-x')]
    const out = resolveChoices(STT_SPECS, stt, { fillRest: true })
    expect(out.map(c => c.id)).toEqual(['openai/whisper-large-v3-turbo', 'acme/hear-7b', 'acme/other-x'])
    expect(out[1]!.text).toBe('Hear 7b (weitere)')
  })
})

describe('resolveChoices (real speech catalog from OpenRouter, 18.10.2026)', () => {
  const ids = [
    'assemblyai/universal-3-6-pro', 'elevenlabs/scribe-v2', 'elevenlabs/scribe-v2-medical', 'google/gemini-3.5-transcribe',
    'fish-audio/transcribe-1-pro', 'assemblyai/universal-3-5-pro', 'meta/muse-voice-transcribe-1.0', 'microsoft/mai-transcribe-2',
    'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b', 'mistralai/voxtral-small-24b-2507-stt', 'mistralai/voxtral-mini-3b-2507',
    'qwen/qwen3-asr-1.7b', 'qwen/qwen3-asr-0.6b', 'openai/gpt-transcribe', 'fish-audio/transcribe-1', 'x-ai/grok-stt-1.0',
    'deepgram/nova-3', 'microsoft/mai-transcribe-1.5', 'nvidia/parakeet-tdt-0.6b-v3', 'mistralai/voxtral-mini-transcribe',
    'google/chirp-3', 'openai/gpt-4o-mini-transcribe', 'openai/whisper-large-v3', 'openai/whisper-large-v3-turbo',
    'openai/whisper-1', 'openai/gpt-4o-transcribe',
  ]
  // The newer generation of a family must win; everything else gets an arbitrary older date.
  const newer = new Set(['assemblyai/universal-3-6-pro', 'openai/gpt-transcribe'])
  const stt = ids.map((id, i) => m(id, newer.has(id) ? 9000 : 1000 + i))
  const out = resolveChoices(STT_SPECS, stt, { fillRest: true })

  it('offers ten entries, one model per family', () => {
    expect(out.map(c => c.text)).toEqual([
      'Whisper Turbo (schnell)',
      'GPT Transcribe (genau)',
      'GPT Transcribe Mini (günstig)',
      'Deepgram Nova (schnell)',
      'ElevenLabs Scribe (genau)',
      'AssemblyAI (genau)',
      'Gemini Transcribe (Google)',
      'Voxtral (EU, günstig)',
      'Whisper Large (bewährt)',
      'Whisper (Standard)',
    ])
  })

  it('maps to the intended models, not to variants', () => {
    const id = (label: string) => out.find(c => c.label === label)?.id
    expect(id('GPT Transcribe')).toBe('openai/gpt-transcribe') // newer than gpt-4o-transcribe
    expect(id('ElevenLabs Scribe')).toBe('elevenlabs/scribe-v2') // not the medical variant
    expect(id('AssemblyAI')).toBe('assemblyai/universal-3-6-pro')
    expect(id('Voxtral')).toBe('mistralai/voxtral-mini-transcribe') // not the chat-style small model
  })
})

describe('helpers', () => {
  it('builds a readable short name from an id', () => {
    expect(shortName('google/gemini-2.5-flash')).toBe('Gemini 2.5 Flash')
  })

  it('keeps a saved model visible when it is not in the list', () => {
    const list = resolveChoices(CHAT_SPECS, catalog)
    expect(withSelected(list, 'openai/gpt-5')).toBe(list)
    const kept = withSelected(list, 'foo/bar-1')
    expect(kept[0]).toMatchObject({ id: 'foo/bar-1', tag: 'eigene' })
  })
})

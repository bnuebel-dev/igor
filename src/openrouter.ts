import { SseParser } from './sse.ts'
import { toBase64, pcmToWav } from './pcm.ts'

// Build-time override for local tests against scripts/mock-openrouter.mjs; never taken from the URL.
export const API: string = import.meta.env.VITE_OPENROUTER_API || 'https://openrouter.ai/api/v1'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type ModelInfo = {
  id: string
  name: string
  inputModalities: string[]
  outputModalities: string[]
  promptPrice?: string
  completionPrice?: string
  /** Unix seconds; used to find the newest version of a model family. */
  created?: number
}

export type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number }

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

function describeStatus(status: number): string {
  switch (status) {
    case 400: return 'Anfrage abgelehnt'
    case 401: return 'Schlüssel ungültig'
    case 402: return 'Kein Guthaben'
    case 403: return 'Zugriff verweigert (Moderation)'
    case 404: return 'Modell oder Endpunkt nicht gefunden'
    case 408: return 'Zeitüberschreitung beim Anbieter'
    case 429: return 'Zu viele Anfragen'
    case 502: return 'Modell nicht erreichbar'
    case 503: return 'Kein Anbieter verfügbar'
    default: return `HTTP ${status}`
  }
}

async function request(path: string, init: RequestInit & { key?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.key) headers.set('Authorization', `Bearer ${init.key}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(`${API}${path}`, { ...init, headers })
  } catch (err) {
    // A CORS rejection and a missing network look the same from JavaScript.
    throw new OpenRouterError('Netzwerk oder CORS blockiert', null, String(err))
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      detail = body?.error?.message ?? JSON.stringify(body)
    } catch {
      detail = await res.text().catch(() => '')
    }
    throw new OpenRouterError(describeStatus(res.status), res.status, detail)
  }
  return res
}

function toModel(raw: any): ModelInfo {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    inputModalities: raw.architecture?.input_modalities ?? [],
    outputModalities: raw.architecture?.output_modalities ?? [],
    promptPrice: raw.pricing?.prompt,
    completionPrice: raw.pricing?.completion,
    created: typeof raw.created === 'number' ? raw.created : undefined,
  }
}

/** Chat models (text output). Works without a key. */
export async function listModels(): Promise<ModelInfo[]> {
  const res = await request('/models')
  const body = await res.json()
  return (body.data ?? []).map(toModel)
}

/** Speech-to-text models, which the default catalog leaves out. */
export async function listTranscriptionModels(): Promise<ModelInfo[]> {
  const res = await request('/models?output_modalities=transcription')
  const body = await res.json()
  return (body.data ?? []).map(toModel)
}

/** Metadata of the key; doubles as a cheap "is this key valid" check. */
export async function keyInfo(key: string): Promise<{ label?: string; usage?: number; limit?: number | null }> {
  const res = await request('/key', { key })
  const body = await res.json()
  return body.data ?? {}
}

export type ChatResult = {
  text: string
  /** ms until the first content token (streaming) or the whole answer (non-streaming). */
  firstTokenMs: number
  /** ms until the response headers arrived. */
  headersMs: number
  totalMs: number
  usage?: Usage
  streamed: boolean
  /** Number of reads from the response body; 1 for a long answer means the stream was buffered. */
  reads: number
  /** "stop" is normal; "length" means the answer was cut off by the token limit. */
  finishReason?: string
  /** True when the model was asked not to think (reasoning off) and accepted that. */
  thinkingOff: boolean
}

// Models that refuse `reasoning: { enabled: false }` are remembered so the retry happens only once.
const refusesThinkingOff = new Set<string>()

/**
 * Thinking models spend most of the token budget and several seconds on hidden
 * reasoning, which is wrong for a voice assistant. Ask for no reasoning first;
 * if the model insists on it (HTTP 400 mentioning reasoning), retry without.
 */
async function sendChat(
  key: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ res: Response; thinkingOff: boolean }> {
  const model = String(body.model)
  const post = (extra: Record<string, unknown>) =>
    request('/chat/completions', { key, method: 'POST', signal, body: JSON.stringify({ ...body, ...extra }) })

  if (!refusesThinkingOff.has(model)) {
    try {
      return { res: await post({ reasoning: { enabled: false } }), thinkingOff: true }
    } catch (err) {
      if (!(err instanceof OpenRouterError) || err.status !== 400 || !/reason|think/i.test(err.detail ?? '')) throw err
      refusesThinkingOff.add(model)
    }
  }
  return { res: await post({}), thinkingOff: false }
}

export async function chat(
  key: string,
  model: string,
  messages: ChatMessage[],
  opts: { stream?: boolean; onDelta?: (text: string) => void; signal?: AbortSignal; maxTokens?: number } = {},
): Promise<ChatResult> {
  const started = performance.now()
  const stream = opts.stream ?? true
  const { res, thinkingOff } = await sendChat(
    key,
    // Generous limit: models that think anyway must still have room left for the answer.
    { model, messages, stream, max_tokens: opts.maxTokens ?? 1500 },
    opts.signal,
  )
  const headersMs = performance.now() - started

  if (!stream || !res.body) {
    const body = await res.json()
    const text = body.choices?.[0]?.message?.content ?? ''
    const ms = performance.now() - started
    opts.onDelta?.(text)
    return {
      text, firstTokenMs: ms, headersMs, totalMs: ms, usage: body.usage, streamed: false, reads: 1,
      finishReason: body.choices?.[0]?.finish_reason, thinkingOff,
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let text = ''
  let firstTokenMs = 0
  let usage: Usage | undefined
  let finishReason: string | undefined
  let reads = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    reads++
    for (const data of parser.feed(decoder.decode(value, { stream: true }))) {
      if (data === '[DONE]') continue
      let chunk: any
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (chunk.error) throw new OpenRouterError('Fehler im Stream', null, chunk.error.message)
      const delta: string = chunk.choices?.[0]?.delta?.content ?? ''
      if (delta) {
        if (!firstTokenMs) firstTokenMs = performance.now() - started
        text += delta
        opts.onDelta?.(text)
      }
      finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason
      if (chunk.usage) usage = chunk.usage
    }
  }
  return { text, firstTokenMs, headersMs, totalMs: performance.now() - started, usage, streamed: true, reads, finishReason, thinkingOff }
}

export type TranscriptionResult = { text: string; totalMs: number; usage?: Usage }

/**
 * Speech-to-text. `pcm` sends the glasses audio unchanged (OpenRouter defines
 * "pcm" as headerless s16le mono 16 kHz); `wav` adds a header as fallback.
 */
export async function transcribe(
  key: string,
  model: string,
  pcm: Uint8Array,
  opts: { format?: 'pcm' | 'wav'; language?: string; signal?: AbortSignal } = {},
): Promise<TranscriptionResult> {
  const started = performance.now()
  const format = opts.format ?? 'pcm'
  const bytes = format === 'wav' ? pcmToWav(pcm) : pcm
  const res = await request('/audio/transcriptions', {
    key,
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify({
      model,
      input_audio: { data: toBase64(bytes), format },
      ...(opts.language ? { language: opts.language } : {}),
    }),
  })
  const body = await res.json()
  return { text: (body.text ?? '').trim(), totalMs: performance.now() - started, usage: body.usage }
}

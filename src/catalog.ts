import type { ModelInfo } from './openrouter.ts'

// A short, curated pick list instead of OpenRouter's several hundred models.
// Each entry names a model *family* by pattern; the newest matching model in
// the live catalog is used, so new versions show up without a code change.

export type Spec = {
  /** Short display name. */
  label: string
  /** The one property worth knowing, shown in parentheses. */
  tag: string
  /** Matches the model id of the family. */
  match: RegExp
  /** Shown only when the live catalog cannot be loaded; omitted when the id is not certain. */
  fallback?: string
}

export type Choice = {
  id: string
  label: string
  tag: string
  /** "Label (tag)" for the select box. */
  text: string
  /** Price per million tokens, when OpenRouter reports one. */
  price?: string
}

export const CUSTOM = '__custom__'
export const MAX_CHOICES = 10

export const CHAT_SPECS: Spec[] = [
  { label: 'Gemini Flash', tag: 'schnell', match: /^google\/gemini-[\d.]+-flash(-preview[\w.-]*)?$/, fallback: 'google/gemini-2.5-flash' },
  { label: 'Gemini Lite', tag: 'günstig', match: /^google\/gemini-[\d.]+-flash-lite(-preview[\w.-]*)?$/, fallback: 'google/gemini-2.5-flash-lite' },
  { label: 'Gemini Pro', tag: 'stark', match: /^google\/gemini-[\d.]+-pro(-preview[\w.-]*)?$/, fallback: 'google/gemini-2.5-pro' },
  { label: 'Claude Haiku', tag: 'schnell', match: /^anthropic\/claude-(haiku-[\d.]+|[\d.]+-haiku)$/, fallback: 'anthropic/claude-haiku-4.5' },
  { label: 'Claude Sonnet', tag: 'ausgewogen', match: /^anthropic\/claude-(sonnet-[\d.]+|[\d.]+-sonnet)$/, fallback: 'anthropic/claude-sonnet-4.5' },
  { label: 'Claude Opus', tag: 'beste Qualität', match: /^anthropic\/claude-(opus-[\d.]+|[\d.]+-opus)$/, fallback: 'anthropic/claude-opus-4.1' },
  { label: 'GPT', tag: 'allrounder', match: /^openai\/gpt-[\d.]+$/, fallback: 'openai/gpt-5' },
  { label: 'GPT Mini', tag: 'günstig', match: /^openai\/gpt-[\d.]+-mini$/, fallback: 'openai/gpt-5-mini' },
  { label: 'DeepSeek', tag: 'sehr günstig', match: /^deepseek\/deepseek-chat(-v[\d.]+)?$/, fallback: 'deepseek/deepseek-chat-v3.1' },
  { label: 'Mistral', tag: 'EU', match: /^mistralai\/mistral-(medium|large)-[\d.]+$/, fallback: 'mistralai/mistral-medium-3.1' },
]

export const STT_SPECS: Spec[] = [
  { label: 'Whisper Turbo', tag: 'schnell', match: /whisper-large-v3-turbo/, fallback: 'openai/whisper-large-v3-turbo' },
  { label: 'Whisper Large', tag: 'genau', match: /whisper-large-v3$/, fallback: 'openai/whisper-large-v3' },
  { label: 'Whisper', tag: 'Standard', match: /whisper-1$/, fallback: 'openai/whisper-1' },
  { label: 'GPT Transcribe', tag: 'genau', match: /gpt-4o-transcribe$/ },
  { label: 'GPT Transcribe Mini', tag: 'günstig', match: /gpt-4o-mini-transcribe/ },
  { label: 'Deepgram Nova', tag: 'schnell', match: /deepgram\/nova/ },
  { label: 'ElevenLabs Scribe', tag: 'genau', match: /elevenlabs\/scribe/ },
  { label: 'Voxtral', tag: 'EU', match: /voxtral/ },
  { label: 'AssemblyAI', tag: 'Untertitel', match: /assemblyai/ },
]

// Variants that are not plain chat models, or that need extra setup.
const EXCLUDED = /:|-image|-audio|-search|-tts|-realtime|-instruct-\d{4}|customtools|-codex|-deep-research/

const perMillion = (per?: string): number | null => {
  const n = Number(per)
  return Number.isFinite(n) && n > 0 ? n * 1_000_000 : null
}

function formatPrice(m: ModelInfo): string | undefined {
  const inp = perMillion(m.promptPrice)
  const out = perMillion(m.completionPrice)
  if (inp === null && out === null) return undefined
  const f = (n: number | null) => (n === null ? '?' : n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 1 : 0)).replace('.', ',')
  return `${f(inp)} / ${f(out)} $ pro Mio. Tokens (rein / raus)`
}

/** Newest model of a family: highest `created`, ties broken by id. */
function newest(models: ModelInfo[], spec: Spec): ModelInfo | undefined {
  return models
    .filter(m => spec.match.test(m.id) && !EXCLUDED.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || b.id.localeCompare(a.id))[0]
}

const toChoice = (spec: Spec, id: string, model?: ModelInfo): Choice => ({
  id,
  label: spec.label,
  tag: spec.tag,
  text: `${spec.label} (${spec.tag})`,
  price: model ? formatPrice(model) : undefined,
})

/** "google/gemini-2.5-flash" -> "Gemini 2.5 Flash", for models outside the curated families. */
export function shortName(id: string): string {
  const slug = id.split('/').pop() ?? id
  return slug
    .split(/[-_]/)
    .map(w => (w.length > 2 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/**
 * Resolve the curated list against the live catalog. Families without a live
 * match are dropped; without any catalog the static fallbacks are shown.
 * `requireAudio` limits entries to models that accept audio input.
 */
export function resolveChoices(
  specs: Spec[],
  models: ModelInfo[],
  opts: { max?: number; requireAudio?: boolean; fillRest?: boolean } = {},
): Choice[] {
  const max = opts.max ?? MAX_CHOICES
  const out: Choice[] = []
  const seen = new Set<string>()
  const add = (c: Choice) => {
    if (!seen.has(c.id) && out.length < max) {
      seen.add(c.id)
      out.push(c)
    }
  }

  if (models.length === 0) {
    for (const s of specs) if (s.fallback) add(toChoice(s, s.fallback))
    return out
  }

  const pool = opts.requireAudio ? models.filter(m => m.inputModalities.includes('audio')) : models
  for (const s of specs) {
    const m = newest(pool, s)
    if (m) add(toChoice(s, m.id, m))
  }
  // Catalog without any curated family (e.g. only speech models): list the first few as they come.
  if (opts.fillRest && out.length < Math.min(max, 3)) {
    for (const m of models.filter(x => !EXCLUDED.test(x.id))) {
      add({ id: m.id, label: shortName(m.id), tag: 'weitere', text: `${shortName(m.id)} (weitere)`, price: formatPrice(m) })
    }
  }
  return out
}

/** Make sure a saved selection that is not in the list stays visible instead of silently changing. */
export function withSelected(choices: Choice[], selected: string): Choice[] {
  if (!selected || choices.some(c => c.id === selected)) return choices
  return [{ id: selected, label: shortName(selected), tag: 'eigene', text: `${shortName(selected)} (eigene)` }, ...choices]
}

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

// Only the SDK storage survives restarts inside the Even app; browser
// localStorage is used when the page runs in a normal browser.

export type Settings = {
  apiKey: string
  chatModel: string
  sttModel: string
  sttFormat: 'pcm' | 'wav'
  language: string
  /** Empty = the built-in persona. */
  persona: string
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  // Empty = not chosen yet: the first entry of the curated list applies.
  chatModel: '',
  sttModel: '',
  // Measured on the glasses: the Whisper provider rejects headerless pcm (HTTP 400) but takes wav.
  sttFormat: 'wav',
  language: 'de',
  persona: '',
}

const SETTINGS_KEY = 'igor.settings'
export const MEMORY_KEY = 'igor.memory'

/** Key/value storage on the phone: the Even app's storage, or the browser's as a fallback. */
export type Kv = {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<boolean>
  readonly backend: 'even' | 'browser'
}

export function createKv(bridge: EvenAppBridge | null): Kv {
  return {
    backend: bridge ? 'even' : 'browser',
    async get(key) {
      if (bridge) return (await bridge.getLocalStorage(key)) ?? ''
      try {
        return localStorage.getItem(key) ?? ''
      } catch {
        return ''
      }
    },
    async set(key, value) {
      if (bridge) return bridge.setLocalStorage(key, value)
      try {
        localStorage.setItem(key, value)
        return true
      } catch {
        return false
      }
    },
  }
}

export async function loadSettings(kv: Kv): Promise<Settings> {
  const raw = await kv.get(SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export const saveSettings = (kv: Kv, settings: Settings) => kv.set(SETTINGS_KEY, JSON.stringify(settings))

/**
 * Debounces writes: the storage shares the Bluetooth link with the display, so
 * a burst of changes should become one write. `flush()` writes immediately.
 */
export function debouncedSave(write: (json: string) => unknown, delayMs = 600) {
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending !== null) {
      const json = pending
      pending = null
      void write(json)
    }
  }
  return Object.assign(
    (json: string) => {
      pending = json
      if (!timer) timer = setTimeout(flush, delayMs)
    },
    { flush },
  )
}

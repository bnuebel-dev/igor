import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

// Only the SDK storage survives restarts inside the Even app; browser
// localStorage is used when the page runs in a normal browser.

export type Settings = {
  apiKey: string
  chatModel: string
  sttModel: string
  sttFormat: 'pcm' | 'wav'
  language: string
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  // Empty = not chosen yet: the first entry of the curated list applies.
  chatModel: '',
  sttModel: '',
  // Measured on the glasses: the Whisper provider rejects headerless pcm (HTTP 400) but takes wav.
  sttFormat: 'wav',
  language: 'de',
}

const KEY = 'igor.settings'

export type Store = {
  load(): Promise<Settings>
  save(settings: Settings): Promise<boolean>
  readonly backend: 'even' | 'browser'
}

export function createStore(bridge: EvenAppBridge | null): Store {
  const read = async (): Promise<string> => {
    if (bridge) return (await bridge.getLocalStorage(KEY)) ?? ''
    try {
      return localStorage.getItem(KEY) ?? ''
    } catch {
      return ''
    }
  }
  const write = async (value: string): Promise<boolean> => {
    if (bridge) return bridge.setLocalStorage(KEY, value)
    try {
      localStorage.setItem(KEY, value)
      return true
    } catch {
      return false
    }
  }
  return {
    backend: bridge ? 'even' : 'browser',
    async load() {
      const raw = await read()
      if (!raw) return { ...DEFAULT_SETTINGS }
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
      } catch {
        return { ...DEFAULT_SETTINGS }
      }
    },
    save: settings => write(JSON.stringify(settings)),
  }
}

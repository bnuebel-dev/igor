/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local mock of the OpenRouter API, see scripts/mock-openrouter.mjs. Unset in real builds. */
  readonly VITE_OPENROUTER_API?: string
}

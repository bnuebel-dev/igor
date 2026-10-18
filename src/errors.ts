import { OpenRouterError } from './openrouter.ts'
import { TimeoutError } from './timeout.ts'

/** What IGOR says on the glasses when something goes wrong: short, in character, with a hint. */
export function friendlyError(err: unknown): string {
  if (err instanceof OpenRouterError) {
    switch (err.status) {
      case null: return 'Keine Verbindung, Boss. Bitte Netz prüfen.'
      case 401: return 'Der Schlüssel ist ungültig, Boss. Bitte am Handy prüfen.'
      case 402: return 'Kein Guthaben mehr bei OpenRouter, Boss.'
      case 403: return 'Das hat die Moderation gesperrt, Boss.'
      case 404: return 'Dieses Modell gibt es nicht, Boss. Bitte ein anderes wählen.'
      case 408: return 'Der Anbieter war zu langsam, Boss. Bitte nochmal.'
      case 429: return 'Zu viele Anfragen, Boss. Bitte kurz warten.'
      case 502:
      case 503: return 'Das Modell ist gerade nicht erreichbar, Boss. Anderes Modell?'
      default: return `Das ging schief, Boss (Fehler ${err.status}).`
    }
  }
  if (err instanceof TimeoutError) return 'Das dauert zu lange, Boss. Bitte nochmal.'
  if ((err as Error)?.name === 'AbortError') return 'Abgebrochen, Boss.'
  return 'Das ging schief, Boss. Bitte nochmal.'
}

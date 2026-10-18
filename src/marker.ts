// Small text protocols between the app and the model / the user's voice.

const PROPOSAL = /\[\[\s*MERKEN\s*:\s*([^\]]{3,240}?)\s*\]\]/i

/**
 * The model may end an answer with `[[MERKEN: kurzer Satz]]` to propose a memory.
 * Returns the answer without the marker and the proposed sentence, if any.
 */
export function extractProposal(text: string): { visible: string; proposal: string | null } {
  const match = text.match(PROPOSAL)
  const visible = text.replace(PROPOSAL, '').replace(/\[\[[^\]]*$/, '').replace(/\n{3,}/g, '\n\n').trim()
  const proposal = match?.[1]?.replace(/\s+/g, ' ').trim() ?? null
  return { visible, proposal }
}

/** While streaming, hide a marker that is still being written. */
export function visibleWhileStreaming(text: string): string {
  const cut = text.indexOf('[[')
  return (cut === -1 ? text : text.slice(0, cut)).trimEnd()
}

export type Command =
  | { type: 'remember'; text: string }
  | { type: 'topic'; name: string | null }
  | { type: 'newChat' }

const strip = (s: string) =>
  s
    .trim()
    .replace(/^[\s"„“'‚]+|[\s"“”'‘.!?,;:]+$/g, '')
    .trim()

/**
 * Spoken commands that the app handles itself instead of sending them to the model:
 * "Merk dir: ...", "Thema Garten", "Kein Thema", "Neuer Chat".
 */
export function parseCommand(transcript: string): Command | null {
  const t = transcript.trim()

  const remember = t.match(/^(?:bitte\s+)?merk(?:e)?\s+(?:dir|es dir)\s*(?:bitte)?\s*[:,]?\s*(?:dass\s+)?(.+)$/is)
  if (remember) {
    const text = strip(remember[1]!)
    // "Merk dir das" refers to the conversation, which only the model can resolve.
    if (text.length >= 3 && !/^(?:das|es|dies|dieses|diese[nr]?|alles)$/i.test(text)) return { type: 'remember', text }
  }

  if (/^(?:wechsle zu )?kein(?:em)? thema[.!]?$/i.test(t) || /^thema (?:aus|beenden|verlassen)[.!]?$/i.test(t)) {
    return { type: 'topic', name: null }
  }
  const topic = t.match(/^(?:wechsle? (?:zum|zu) )?thema\s*[:,]?\s+(.+)$/is)
  if (topic) {
    const name = strip(topic[1]!)
    if (name.length >= 2 && name.length <= 40) return { type: 'topic', name }
  }

  if (/^(?:ein )?neuer chat[.!]?$/i.test(t) || /^von vorn[.!]?$/i.test(t)) return { type: 'newChat' }
  return null
}

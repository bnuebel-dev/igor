// Local stand-in for the OpenRouter endpoints IGOR uses, for simulator tests
// without network access. Start: node scripts/mock-openrouter.mjs [port]
// Then: VITE_OPENROUTER_API=http://localhost:8787/api/v1 npm run dev
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8787)

const ANSWER =
  'Zu Befehl, Boss. Der Mars hat keine eigene Zeitzone, aber ein Marstag dauert 24 Stunden und 39 Minuten. ' +
  'Für Ihre Kolonie empfehle ich also längere Mittagspausen, Boss.'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function json(res, status, body) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

// Test control: POST /__say {"text": "..."} sets what the next speech recognition returns.
let nextSpeech = 'Wie spät ist es auf dem Mars, Igor?'

const authorized = req => (req.headers.authorization ?? '').startsWith('Bearer sk-or-')

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)
  const path = url.pathname.replace(/^\/api\/v1/, '')
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
  if (url.pathname === '/__say') {
    nextSpeech = String((await readBody(req)).text ?? nextSpeech)
    return json(res, 200, { ok: true, nextSpeech })
  }

  if (path === '/models') {
    if (url.searchParams.get('output_modalities') === 'transcription') {
      const stt = ['openai/whisper-1', 'openai/whisper-large-v3', 'openai/whisper-large-v3-turbo', 'acme/hear-7b'].map((id, i) => ({
        id, name: id, created: 1700000000 + i, architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
      }))
      return json(res, 200, { data: stt })
    }
    const text = (id, created, prompt = 0.000001, completion = 0.000004, input = ['text']) => ({
      id, name: id, created, pricing: { prompt: String(prompt), completion: String(completion) },
      architecture: { input_modalities: input, output_modalities: ['text'] },
    })
    return json(res, 200, {
      data: [
        text('google/gemini-2.5-flash', 1750000000, 0.0000003, 0.0000025, ['text', 'audio']),
        text('google/gemini-3-flash-preview', 1760000000, 0.0000005, 0.000003, ['text', 'audio']),
        text('google/gemini-2.5-flash-lite', 1751000000, 0.0000001, 0.0000004),
        text('google/gemini-2.5-flash-image', 1770000000),
        text('google/gemini-2.5-pro', 1752000000, 0.00000125, 0.00001),
        text('anthropic/claude-haiku-4.5', 1753000000, 0.000001, 0.000005),
        text('anthropic/claude-sonnet-4', 1700000000),
        text('anthropic/claude-sonnet-4.5', 1754000000, 0.000003, 0.000015),
        text('anthropic/claude-sonnet-4.5:thinking', 1790000000),
        text('openai/gpt-5', 1755000000, 0.00000125, 0.00001),
        text('openai/gpt-5-mini', 1756000000, 0.00000025, 0.000002),
        text('deepseek/deepseek-chat-v3.1', 1757000000, 0.0000002, 0.0000008),
        text('mistralai/mistral-medium-3.1', 1758000000, 0.0000004, 0.000002),
        text('meta-llama/llama-3.3-70b-instruct', 1600000000),
      ],
    })
  }
  if (!authorized(req)) return json(res, 401, { error: { message: 'No auth credentials found', code: 401 } })

  if (path === '/key') return json(res, 200, { data: { label: 'mock', usage: 0.42, limit: null } })

  if (path === '/audio/transcriptions') {
    const body = await readBody(req)
    const bytes = Buffer.from(body.input_audio?.data ?? '', 'base64').length
    console.log(`transcription: ${body.model} format=${body.input_audio?.format} ${bytes} bytes lang=${body.language}`)
    return json(res, 200, { text: nextSpeech, usage: { cost: 0.0002 } })
  }

  if (path === '/chat/completions') {
    const body = await readBody(req)
    const last = String(body.messages?.at(-1)?.content ?? '')
    const system = String(body.messages?.[0]?.content ?? '')
    console.log(`chat: ${body.model} stream=${body.stream} reasoning=${JSON.stringify(body.reasoning)} turns=${body.messages?.length} "${last.slice(0, 60).replace(/\n/g, ' ')}"`)
    // Answer depends on the question so the app's features can be exercised without a real model.
    let answer = ANSWER
    if (system.startsWith('Sie führen das Gedächtnis')) answer = 'Garten: Beet im Süden angelegt, Tomaten folgen im Mai.'
    else if (/hund/i.test(last)) answer = 'Ein Hund, Boss, wie wunderbar! Rex ist ein schöner Name.\n\n[[MERKEN: Hund heißt Rex]]'
    else if (/lang|ausführlich/i.test(last)) answer = Array.from({ length: 14 }, (_, i) => `Absatz ${i + 1}: Der Mars hat keine eigene Zeitzone, aber ein Marstag dauert 24 Stunden und 39 Minuten, Boss.`).join('\n\n')
    const usage = { prompt_tokens: 120, completion_tokens: 60, cost: 0.00012 }
    if (!body.stream) {
      return json(res, 200, { choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage })
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' })
    res.write(': OPENROUTER PROCESSING\n\n')
    for (const w of answer.split(/(?<= )/)) {
      await new Promise(r => setTimeout(r, 15))
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }
  json(res, 404, { error: { message: 'not found' } })
}).listen(port, () => console.log(`mock OpenRouter on http://localhost:${port}/api/v1`))

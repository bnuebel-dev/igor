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

const authorized = req => (req.headers.authorization ?? '').startsWith('Bearer sk-or-')

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)
  const path = url.pathname.replace(/^\/api\/v1/, '')
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()

  if (path === '/models') {
    if (url.searchParams.get('output_modalities') === 'transcription') {
      return json(res, 200, { data: [{ id: 'openai/whisper-large-v3-turbo', name: 'Whisper', architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] } }] })
    }
    return json(res, 200, {
      data: [
        { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', architecture: { input_modalities: ['text', 'image', 'audio'], output_modalities: ['text'] } },
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      ],
    })
  }
  if (!authorized(req)) return json(res, 401, { error: { message: 'No auth credentials found', code: 401 } })

  if (path === '/key') return json(res, 200, { data: { label: 'mock', usage: 0.42, limit: null } })

  if (path === '/audio/transcriptions') {
    const body = await readBody(req)
    const bytes = Buffer.from(body.input_audio?.data ?? '', 'base64').length
    console.log(`transcription: ${body.model} format=${body.input_audio?.format} ${bytes} bytes lang=${body.language}`)
    return json(res, 200, { text: 'Wie spät ist es auf dem Mars, Igor?', usage: { cost: 0.0002 } })
  }

  if (path === '/chat/completions') {
    const body = await readBody(req)
    console.log(`chat: ${body.model} stream=${body.stream} "${body.messages?.at(-1)?.content}"`)
    const usage = { prompt_tokens: 120, completion_tokens: 60, cost: 0.00012 }
    if (!body.stream) {
      return json(res, 200, { choices: [{ message: { role: 'assistant', content: ANSWER } }], usage })
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' })
    res.write(': OPENROUTER PROCESSING\n\n')
    const words = ANSWER.split(/(?<= )/)
    for (const w of words) {
      await new Promise(r => setTimeout(r, 60))
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} , finish_reason: 'stop' }], usage })}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }
  json(res, 404, { error: { message: 'not found' } })
}).listen(port, () => console.log(`mock OpenRouter on http://localhost:${port}/api/v1`))

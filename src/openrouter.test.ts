import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, OpenRouterError } from './openrouter.ts'

type Call = { url: string; body: Record<string, any> }

function stubFetch(responses: Array<() => Response>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      const next = responses.shift()
      if (!next) throw new Error('unexpected extra request')
      return next()
    }),
  )
  return calls
}

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })
const fail = (status: number, message: string) => () =>
  new Response(JSON.stringify({ error: { message } }), { status })

const answer = { choices: [{ message: { content: 'Zu Diensten, Boss.' }, finish_reason: 'stop' }], usage: { cost: 0.0001 } }
const msgs = [{ role: 'user' as const, content: 'Hallo' }]

afterEach(() => vi.unstubAllGlobals())

describe('chat: thinking off', () => {
  it('asks for no reasoning first and gives the model room for the answer', async () => {
    const calls = stubFetch([ok(answer)])
    const r = await chat('sk-or-x', 'vendor/model-a', msgs, { stream: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.reasoning).toEqual({ enabled: false })
    expect(calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(1000)
    expect(r).toMatchObject({ text: 'Zu Diensten, Boss.', thinkingOff: true, finishReason: 'stop' })
  })

  it('retries once without the flag when the model insists on reasoning, and remembers it', async () => {
    const calls = stubFetch([
      fail(400, 'Reasoning is mandatory for this endpoint and cannot be disabled.'),
      ok(answer),
      ok(answer), // second chat with the same model: no probing request this time
    ])
    const first = await chat('sk-or-x', 'vendor/model-b', msgs, { stream: false })
    expect(first.thinkingOff).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.reasoning).toEqual({ enabled: false })
    expect('reasoning' in calls[1]!.body).toBe(false)

    await chat('sk-or-x', 'vendor/model-b', msgs, { stream: false })
    expect(calls).toHaveLength(3)
    expect('reasoning' in calls[2]!.body).toBe(false)
  })

  it('does not retry on unrelated errors', async () => {
    const calls = stubFetch([fail(401, 'No auth credentials found')])
    await expect(chat('bad', 'vendor/model-c', msgs, { stream: false })).rejects.toMatchObject({
      name: 'OpenRouterError',
      status: 401,
    })
    expect(calls).toHaveLength(1)
  })

  it('reports a cut-off answer', async () => {
    stubFetch([ok({ choices: [{ message: { content: 'Guten Tag, Boss, Ihr treuer' }, finish_reason: 'length' }] })])
    const r = await chat('sk-or-x', 'vendor/model-d', msgs, { stream: false })
    expect(r.finishReason).toBe('length')
  })
})

describe('chat: streaming diagnostics', () => {
  const sse = (...events: string[]) => events.map(e => `data: ${e}\n\n`).join('')
  const streamOf = (...chunks: string[]) => () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          for (const c of chunks) controller.enqueue(enc.encode(c))
          controller.close()
        },
      }),
      { status: 200 },
    )

  it('counts deltas and body reads', async () => {
    stubFetch([
      streamOf(
        sse('{"choices":[{"delta":{"content":"Eins, "}}]}'),
        sse('{"choices":[{"delta":{"content":"zwei."},"finish_reason":"stop"}],"usage":{"cost":0.1}}', '[DONE]'),
      ),
    ])
    const seen: string[] = []
    const r = await chat('sk-or-x', 'vendor/model-e', msgs, { onDelta: t => seen.push(t) })
    expect(seen).toEqual(['Eins, ', 'Eins, zwei.'])
    expect(r).toMatchObject({ text: 'Eins, zwei.', reads: 2, streamed: true, finishReason: 'stop' })
    expect(r.usage?.cost).toBe(0.1)
  })

  it('shows a buffered stream as a single read', async () => {
    stubFetch([
      streamOf(
        sse('{"choices":[{"delta":{"content":"Eins, "}}]}', '{"choices":[{"delta":{"content":"zwei."}}]}', '[DONE]'),
      ),
    ])
    const r = await chat('sk-or-x', 'vendor/model-f', msgs)
    expect(r.reads).toBe(1)
  })

  it('raises mid-stream errors', async () => {
    stubFetch([streamOf(sse('{"error":{"message":"provider failed"}}'))])
    await expect(chat('sk-or-x', 'vendor/model-g', msgs)).rejects.toBeInstanceOf(OpenRouterError)
  })
})

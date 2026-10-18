import { floatToPcm16, SAMPLE_RATE } from './pcm.ts'

export type BrowserRecording = {
  /** Stops and returns PCM s16le, 16 kHz, mono: the same format the glasses deliver. */
  stop(): Promise<Uint8Array>
}

/**
 * Browser microphone, for use without glasses (virtual glasses on the phone page, diagnostics).
 * On the glasses the microphone comes through the Even bridge instead.
 */
export async function startBrowserRecording(): Promise<BrowserRecording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kein Browser-Mikrofon verfügbar')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
  const stopped = new Promise<void>(resolve => (recorder.onstop = () => resolve()))
  recorder.start()

  return {
    async stop() {
      try {
        if (recorder.state !== 'inactive') recorder.stop()
        await stopped
      } finally {
        stream.getTracks().forEach(t => t.stop())
      }
      const encoded = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()
      const ctx = new AudioContext()
      try {
        const decoded = await ctx.decodeAudioData(encoded)
        const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE))
        const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE)
        const source = offline.createBufferSource()
        source.buffer = decoded
        source.connect(offline.destination)
        source.start()
        return floatToPcm16((await offline.startRendering()).getChannelData(0))
      } finally {
        void ctx.close()
      }
    },
  }
}

/** Fixed-length recording, for the diagnostic test. */
export async function recordBrowserPcm(seconds: number, onStart?: () => void): Promise<Uint8Array> {
  const rec = await startBrowserRecording()
  onStart?.()
  await new Promise(r => setTimeout(r, seconds * 1000))
  return rec.stop()
}

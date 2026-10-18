import { floatToPcm16, SAMPLE_RATE } from './pcm.ts'

/**
 * Record `seconds` from the browser microphone and return PCM s16le, 16 kHz, mono:
 * the same format the glasses deliver. Only for diagnostics in a normal browser;
 * on the glasses the microphone comes through the Even bridge.
 */
export async function recordBrowserPcm(seconds: number, onStart?: () => void): Promise<Uint8Array> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kein Browser-Mikrofon verfügbar')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  try {
    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
    const stopped = new Promise<void>(resolve => (recorder.onstop = () => resolve()))
    recorder.start()
    onStart?.()
    await new Promise(r => setTimeout(r, seconds * 1000))
    recorder.stop()
    await stopped
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
      const rendered = await offline.startRendering()
      return floatToPcm16(rendered.getChannelData(0))
    } finally {
      void ctx.close()
    }
  } finally {
    stream.getTracks().forEach(t => t.stop())
  }
}

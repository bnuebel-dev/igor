import {
  AudioInputSource,
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { clampUtf8, sanitizeForGlasses } from './text.ts'
import { withTimeout } from './timeout.ts'

const MAIN = { id: 1, name: 'main' }

/** Minimum gap between two display writes; BLE cannot keep up with more. */
const MIN_WRITE_GAP_MS = 250

type Log = (msg: string) => void

/**
 * All bridge calls go through one serial queue with a timeout: concurrent
 * calls can wedge the connection, and a flaky BLE hop can hang for ~30 s.
 */
export class Glasses {
  private queue: Promise<unknown> = Promise.resolve()
  private startupSpent = false
  private pendingText: string | null = null
  private flushScheduled = false
  private lastWrite = 0

  constructor(
    readonly bridge: EvenAppBridge,
    private readonly log: Log,
  ) {}

  private enqueue<T>(label: string, fn: () => Promise<T>, ms = 5000): Promise<T> {
    const run = this.queue.then(() => withTimeout(fn(), ms, label))
    this.queue = run.catch(err => this.log(`${label} fehlgeschlagen: ${(err as Error).message}`))
    return run
  }

  /** One-shot page setup. Latched even on failure: a retry blocks ~2 s and is rejected anyway. */
  async start(text: string): Promise<boolean> {
    if (this.startupSpent) return false
    this.startupSpent = true
    const result = await this.enqueue('Seite anlegen', () =>
      this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 1,
          textObject: [
            new TextContainerProperty({
              xPosition: 0,
              yPosition: 0,
              width: 576,
              height: 288,
              borderWidth: 0,
              borderColor: 0,
              paddingLength: 6,
              containerID: MAIN.id,
              containerName: MAIN.name,
              content: clampUtf8(text),
              isEventCapture: 1,
            }),
          ],
        }),
      ),
    )
    if (result !== StartUpPageCreateResult.success) {
      this.log(`Seite anlegen: Ergebnis ${result}`)
      return false
    }
    return true
  }

  /** Show text; rapid calls are coalesced so only the latest text is sent. */
  show(text: string): void {
    this.pendingText = clampUtf8(sanitizeForGlasses(text))
    if (this.flushScheduled) return
    this.flushScheduled = true
    const wait = Math.max(0, this.lastWrite + MIN_WRITE_GAP_MS - Date.now())
    setTimeout(() => {
      void this.enqueue('Text anzeigen', async () => {
        this.flushScheduled = false
        const content = this.pendingText
        this.pendingText = null
        if (content === null) return true
        this.lastWrite = Date.now()
        return this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: MAIN.id, containerName: MAIN.name, content }),
        )
      })
    }, wait)
  }

  mic(on: boolean): Promise<boolean> {
    return this.enqueue(on ? 'Mikrofon an' : 'Mikrofon aus', () =>
      on ? this.bridge.audioControl(true, AudioInputSource.Glasses) : this.bridge.audioControl(false),
    )
  }

  /** Ask the host for its exit dialog (required on the root page by the Even Hub review). */
  requestExit(): Promise<boolean> {
    return this.enqueue('Beenden', () => this.bridge.shutDownPageContainer(1))
  }
}

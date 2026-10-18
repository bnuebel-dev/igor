import {
  AudioInputSource,
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { clampUtf8, sanitizeForGlasses } from './text.ts'
import { withTimeout } from './timeout.ts'

/** Text page: one full-screen container that also catches the input events. */
const MAIN = { id: 1, name: 'main' }
/** List page: a heading and the native list below it. */
const HEAD = { id: 2, name: 'head' }
const LIST = { id: 3, name: 'menu' }

/** Minimum gap between two display writes; BLE cannot keep up with more. */
const MIN_WRITE_GAP_MS = 250
const MAX_LIST_ITEMS = 20
const MAX_ITEM_CHARS = 56

type Log = (msg: string) => void
type Desired = { kind: 'text'; text: string } | { kind: 'list'; title: string; items: string[] }

const textContainer = (content: string) =>
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
    content: clampUtf8(content),
    isEventCapture: 1,
  })

/**
 * All bridge calls go through one serial queue with a timeout: concurrent
 * calls can wedge the connection, and a flaky BLE hop can hang for ~30 s.
 *
 * The screen shows either a text page or a list page. Switching between them
 * rebuilds the page (about 165 ms, with a brief flicker); updating text on a
 * text page is done in place.
 */
export class Glasses {
  private queue: Promise<unknown> = Promise.resolve()
  private startupSpent = false
  private pageKind: 'text' | 'list' = 'text'
  private desired: Desired | null = null
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
        new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [textContainer(text)] }),
      ),
    )
    if (result !== StartUpPageCreateResult.success) {
      this.log(`Seite anlegen: Ergebnis ${result}; versuche stattdessen die vorhandene Seite zu ersetzen`)
      // A page from an earlier run may still be on the glasses; replacing it works where creating is refused.
      const rebuilt = await this.enqueue('Seite ersetzen', () =>
        this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 1, textObject: [textContainer(text)] })),
      ).catch(() => false)
      if (!rebuilt) this.log('Seite ersetzen: abgelehnt')
      return rebuilt
    }
    return true
  }

  /** Show text; rapid calls are coalesced so only the latest screen is sent. */
  showText(text: string): void {
    this.desired = { kind: 'text', text: clampUtf8(sanitizeForGlasses(text)) }
    this.scheduleFlush()
  }

  /** Show a native list. Entries beyond 20 are dropped; selection comes back as a list event. */
  showList(title: string, items: string[]): void {
    const shown = items.slice(0, MAX_LIST_ITEMS).map(i => (i.length > MAX_ITEM_CHARS ? `${i.slice(0, MAX_ITEM_CHARS - 1)}…` : i))
    this.desired = { kind: 'list', title: clampUtf8(title, 120), items: shown.length ? shown : ['(leer)'] }
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.flushScheduled) return
    this.flushScheduled = true
    const wait = Math.max(0, this.lastWrite + MIN_WRITE_GAP_MS - Date.now())
    setTimeout(() => {
      void this.enqueue('Anzeige', async () => {
        this.flushScheduled = false
        const want = this.desired
        this.desired = null
        if (!want) return true
        this.lastWrite = Date.now()
        return want.kind === 'text' ? this.writeText(want.text) : this.writeList(want)
      })
    }, wait)
  }

  private async writeText(text: string): Promise<boolean> {
    if (this.pageKind === 'text') {
      return this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: MAIN.id, containerName: MAIN.name, content: text }),
      )
    }
    const ok = await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: 1, textObject: [textContainer(text)] }),
    )
    if (ok) this.pageKind = 'text'
    else this.log('Textseite aufbauen: abgelehnt')
    return ok
  }

  private async writeList(want: { title: string; items: string[] }): Promise<boolean> {
    const ok = await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 40,
            borderWidth: 0,
            borderColor: 0,
            paddingLength: 4,
            containerID: HEAD.id,
            containerName: HEAD.name,
            content: want.title,
            isEventCapture: 0,
          }),
        ],
        listObject: [
          new ListContainerProperty({
            xPosition: 0,
            yPosition: 44,
            width: 576,
            height: 244,
            borderWidth: 1,
            borderColor: 5,
            borderRadius: 4,
            paddingLength: 4,
            containerID: LIST.id,
            containerName: LIST.name,
            isEventCapture: 1,
            itemContainer: new ListItemContainerProperty({
              itemCount: want.items.length,
              itemWidth: 0,
              isItemSelectBorderEn: 1,
              itemName: want.items,
            }),
          }),
        ],
      }),
    )
    if (ok) this.pageKind = 'list'
    else this.log('Liste aufbauen: abgelehnt')
    return ok
  }

  /**
   * The host cleared the page (exit dialog, app returning from the background):
   * the next text write must rebuild the page instead of updating it in place.
   */
  invalidate() {
    this.pageKind = 'list'
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

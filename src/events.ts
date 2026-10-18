import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

/**
 * Event type of one envelope. CLICK_EVENT is 0 and protobuf omits zero values,
 * so a tap arrives without `eventType`. Resolve the default inside the envelope
 * check, otherwise every audio frame would count as a tap.
 */
export function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

export type Gesture =
  | 'tap'
  | 'double-tap'
  | 'long-press'
  | 'long-release'
  | 'scroll-up'
  | 'scroll-down'
  | 'foreground'
  | 'background'
  | 'exit'

/** Map an SDK event to one gesture, or null for audio, IMU and unknown events. */
export function gestureOf(event: EvenHubEvent): Gesture | null {
  if (event.audioEvent) return null
  const types = [eventTypeOf(event.sysEvent), eventTypeOf(event.textEvent), eventTypeOf(event.listEvent)]
  const has = (t: OsEventTypeList) => types.includes(t)
  // Explicit ids first; CLICK is the fallback for envelopes without a type.
  if (has(OsEventTypeList.DOUBLE_CLICK_EVENT)) return 'double-tap'
  if (has(OsEventTypeList.LONG_PRESS_EVENT)) return 'long-press'
  if (has(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return 'long-release'
  if (has(OsEventTypeList.SCROLL_TOP_EVENT)) return 'scroll-up'
  if (has(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return 'scroll-down'
  if (has(OsEventTypeList.FOREGROUND_ENTER_EVENT)) return 'foreground'
  if (has(OsEventTypeList.FOREGROUND_EXIT_EVENT)) return 'background'
  if (has(OsEventTypeList.SYSTEM_EXIT_EVENT) || has(OsEventTypeList.ABNORMAL_EXIT_EVENT)) return 'exit'
  if (has(OsEventTypeList.IMU_DATA_REPORT)) return null
  if (has(OsEventTypeList.CLICK_EVENT)) return 'tap'
  return null
}

/**
 * Drops repeats of the same gesture within `windowMs`. The firmware sends
 * duplicate lifecycle events, and one swipe can fire several scroll events.
 */
export function createGestureFilter(windowMs: Partial<Record<Gesture, number>>, now = () => Date.now()) {
  const last = new Map<Gesture, number>()
  return (gesture: Gesture): boolean => {
    const window = windowMs[gesture]
    if (!window) return true
    const t = now()
    const prev = last.get(gesture)
    last.set(gesture, t)
    return prev === undefined || t - prev >= window
  }
}

/** Index of the selected entry when the event comes from a list page (the first entry arrives as undefined). */
export function listIndexOf(event: EvenHubEvent): number | undefined {
  return event.listEvent ? (event.listEvent.currentSelectItemIndex ?? 0) : undefined
}

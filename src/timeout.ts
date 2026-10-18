export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: keine Antwort nach ${ms} ms`)
    this.name = 'TimeoutError'
  }
}

/** Reject if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

import type { AcpPendingResponse, AcpRequestOptions, AcpResponse } from './acp-response-settlement'
import type { AcpJsonRpcMessage } from './acp-rpc-envelope'

type EarlierCall = AcpPendingResponse & { matches: (frame: AcpJsonRpcMessage) => boolean }

/**
 * A peer's outstanding calls by id. An agent kept running across an app restart already saw the
 * earlier app's ids, so this app's start above them and can wait on an earlier app's call.
 */
export class AcpPendingCalls {
  readonly pending = new Map<number, AcpPendingResponse>()
  private next = 1
  /** Ids at or below this were sent by the app that ran this agent before a restart. */
  private earlierThrough = 0
  /** An earlier call whose id is unknown; the first earlier answer `matches` accepts settles it. */
  private earlier?: EarlierCall

  constructor(private readonly closedWith: () => Error | undefined) {}

  nextId(): number {
    return this.next++
  }

  startAbove(floor: number): void {
    this.earlierThrough = Math.max(this.earlierThrough, floor)
    this.next = Math.max(this.next, floor + 1)
  }

  /** Waits for an earlier app's call; a null id takes the first earlier answer `matches` accepts. */
  adoptEarlier<T>(
    id: number | null,
    method: string,
    settle: AcpRequestOptions<T>['settle'],
    matches: (frame: AcpJsonRpcMessage) => boolean
  ): Promise<T> {
    const closed = this.closedWith()
    if (closed) {
      return Promise.reject(closed)
    }
    return new Promise<T>((resolve, reject) => {
      const answer = (response: AcpResponse): void => {
        try {
          resolve(settle(response))
        } catch (error) {
          reject(error)
        }
      }
      const call = {
        method,
        resolve: (value: unknown) => answer({ value }),
        reject: (error: Error) => answer({ error })
      }
      if (id === null) {
        this.earlier = { ...call, matches }
      } else {
        this.pending.set(id, call)
      }
    })
  }

  /** Before an answer is settled: an earlier answer nobody waits on by id may be the adopted call. */
  claim(frame: AcpJsonRpcMessage): void {
    const { earlier } = this
    if (
      earlier &&
      typeof frame.id === 'number' &&
      frame.id <= this.earlierThrough &&
      !this.pending.has(frame.id) &&
      earlier.matches(frame)
    ) {
      this.earlier = undefined
      this.pending.set(frame.id, earlier)
    }
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.earlier?.reject(error)
    this.earlier = undefined
  }
}

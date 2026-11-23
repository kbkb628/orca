import type { z } from 'zod'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import type { RelayedProviderProcess } from '../../provider-relay/app-provider-relays'
import { settleAcpSessionCall } from '../protocol/acp-session-call'
import { keptAcpSessionStart } from '../protocol/acp-session-setup'
import type { AcpPendingCalls } from '../transport/acp-pending-calls'
import {
  ACP_PROTOCOL_VERSION,
  InitializeResponseSchema,
  PromptResponseSchema,
  type InitializeResponse,
  type PromptResponse
} from '../generated/acp-protocol.generated'
import { acpKeptAgent, type AcpKeptAgent } from './acp-kept-agent'

const SESSION_STARTS = new Set(['session/new', 'session/load', 'session/resume'])

function readNotification(line: string): { method: string; params: unknown } | null {
  try {
    const message: unknown = JSON.parse(line)
    if (typeof message !== 'object' || message === null || 'id' in message) {
      return null
    }
    const method = 'method' in message ? message.method : undefined
    const params = 'params' in message ? message.params : undefined
    return typeof method === 'string' ? { method, params } : null
  } catch {
    return null
  }
}

/**
 * An ACP agent kept running under the terminal daemon from before this app started. It is
 * initialized and its session is live, so both are answered from what the daemon kept; a reload
 * would replay history and may replace the live session mid-turn.
 */
export class AcpKeptSession {
  private readonly kept: AcpKeptAgent
  private initialized: Promise<InitializeResponse> | null
  private startTaken = false

  constructor(
    private readonly child: RelayedProviderChild,
    private readonly calls: AcpPendingCalls,
    /** Delivers a kept state update as if the agent had just sent it. */
    private readonly notify: (method: string, params: unknown) => void
  ) {
    this.kept = acpKeptAgent(child)
    calls.startAbove(this.kept.requestFloor)
    const initialize = InitializeResponseSchema.safeParse(this.kept.initialize)
    this.initialized =
      initialize.success && initialize.data.protocolVersion === ACP_PROTOCOL_VERSION
        ? Promise.resolve(initialize.data)
        : null
  }

  /** Null: nothing usable was kept, so the agent is asked. */
  initialize(): Promise<InitializeResponse> | null {
    return this.initialized
  }

  /** The kept answer to the first session start, then the state it changed to since; undefined asks the agent. */
  answerStart<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    received?: (response: T) => void
  ): Promise<T> | undefined {
    const start = this.kept.sessionStart
    if (this.startTaken || !start || !SESSION_STARTS.has(method)) {
      return undefined
    }
    const sessionId =
      typeof params === 'object' && params !== null && 'sessionId' in params
        ? String(params.sessionId)
        : undefined
    const started = keptAcpSessionStart(start, sessionId)
    if (!started) {
      return undefined
    }
    this.startTaken = true
    try {
      const answer = settleAcpSessionCall(
        method,
        schema,
        undefined,
        received
      )({
        value: started.response
      })
      // Mode, config and commands changed since the start apply before anything new.
      for (const line of this.kept.stateLines) {
        const update = readNotification(line)
        if (update) {
          this.notify(update.method, update.params)
        }
      }
      return Promise.resolve(answer)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** The answer to the earlier app's prompt: by id while unanswered, else its answer in the replay. */
  earlierPrompt(): Promise<PromptResponse> {
    return this.calls.adoptEarlier(
      this.kept.earlierPromptId,
      'session/prompt',
      settleAcpSessionCall('session/prompt', PromptResponseSchema, undefined),
      (frame) =>
        'error' in frame ||
        (typeof frame.result === 'object' && frame.result !== null && 'stopReason' in frame.result)
    )
  }

  /** Lets the held output through once the chat can route it. */
  releaseOutput(): void {
    this.child.releaseOutput()
  }
}

export function keptAcpSession(
  relayed: RelayedProviderProcess | undefined,
  calls: AcpPendingCalls,
  notify: (method: string, params: unknown) => void
): AcpKeptSession | null {
  return relayed?.reattached ? new AcpKeptSession(relayed.child, calls, notify) : null
}

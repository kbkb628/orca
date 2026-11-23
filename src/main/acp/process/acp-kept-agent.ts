import type { ProviderRelayKeepSpec } from '../../daemon/protocol/daemon-provider-relay-protocol'
import {
  launchRelayedProviderProcess,
  type ProviderRelayLaunch,
  type ProviderRelayWorkMarkers,
  type RelayedProviderProcess
} from '../../provider-relay/app-provider-relays'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import { isJsonRpcAnswerAbove, jsonRpcResultOf } from '../../provider-relay/relayed-json-rpc-lines'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'

const SESSION_STARTS = ['session/new', 'session/load', 'session/resume']
const PROMPT = 'session/prompt'

/** Session state the daemon keeps for the next app: the start answer and the latest state updates. */
const ACP_RELAY_KEEP: ProviderRelayKeepSpec = {
  answers: SESSION_STARTS,
  lines: ['"config_option_update"', '"current_mode_update"', '"available_commands_update"'],
  // An unanswered prompt is a running turn; the daemon never idle-stops it.
  outstanding: [PROMPT]
}

/** An ACP turn is its prompt's request; no agent line marks it, so the daemon tracks the request. */
const ACP_RELAY_WORK_MARKERS: ProviderRelayWorkMarkers = { workStarts: [], workEnds: [] }

function acpRelayLaunch(
  chatKey: string,
  passWhileHeld: (line: string) => boolean
): ProviderRelayLaunch {
  return { chatKey, markers: ACP_RELAY_WORK_MARKERS, keep: ACP_RELAY_KEEP, passWhileHeld }
}

/** What a reattached agent already did for the app that started it. */
export type AcpKeptAgent = {
  /** The earlier app's highest request id; this app's ids start above it. */
  requestFloor: number
  /** The kept agent's `initialize` result. */
  initialize: unknown
  /** The latest session start the agent answered. */
  sessionStart: { method: string; result: unknown } | null
  /** `session/update` lines kept since that start, oldest first. */
  stateLines: string[]
  /** The earlier app's prompt the agent still owes an answer; null when none is listed. */
  earlierPromptId: number | null
}

export function acpKeptAgent(child: RelayedProviderChild): AcpKeptAgent {
  const attach = child.attachResult
  let sessionStart: (AcpKeptAgent['sessionStart'] & { seq: number }) | null = null
  const states: { seq: number; line: string }[] = []
  for (const { seq, name } of attach?.kept ?? []) {
    const line = child.keptLines.get(seq)
    if (line === undefined) {
      continue
    }
    const method = name.startsWith('a:') ? name.slice(2) : null
    if (method && SESSION_STARTS.includes(method)) {
      if (!sessionStart || seq > sessionStart.seq) {
        sessionStart = { method, result: jsonRpcResultOf(line), seq }
      }
    } else if (name.startsWith('l:')) {
      states.push({ seq, line })
    }
  }
  const startSeq = sessionStart?.seq ?? Number.POSITIVE_INFINITY
  const prompt = (attach?.outstanding ?? []).findLast((request) => request.method === PROMPT)
  return {
    requestFloor: attach?.maxClientRequestId ?? 0,
    initialize: jsonRpcResultOf(child.initializeLine),
    sessionStart: sessionStart && { method: sessionStart.method, result: sessionStart.result },
    stateLines: states
      .filter((state) => state.seq > startSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((state) => state.line),
    earlierPromptId: typeof prompt?.id === 'number' ? prompt.id : null
  }
}

/**
 * Starts a chat's agent under the terminal daemon, or reattaches the one it kept running, so it
 * outlives a restart. Null: relaying isn't available here, and the caller launches as today.
 */
export async function launchRelayedAcpAgent(
  launch: ProviderProcessLaunch,
  chatKey: string,
  abandoned: () => boolean
): Promise<RelayedProviderProcess | null> {
  // Answers to this app's own requests pass a reattach's hold; everything else waits for the chat.
  let floor = Number.POSITIVE_INFINITY
  const relayed = await launchRelayedProviderProcess(
    launch,
    acpRelayLaunch(chatKey, (line) => isJsonRpcAnswerAbove(line, floor))
  )
  floor = relayed?.child.attachResult?.maxClientRequestId ?? 0
  // The chat closed meanwhile: its agent ends here, before any connection owns it.
  if (relayed && abandoned()) {
    void relayed.managed.close().catch(() => undefined)
  }
  return relayed
}

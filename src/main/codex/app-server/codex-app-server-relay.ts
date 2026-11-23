import type { ProviderRelayWorkMarkers } from '../../provider-relay/app-provider-relays'
import { jsonRpcResultOf } from '../../provider-relay/relayed-json-rpc-lines'

export { isJsonRpcAnswerAbove as isCodexAnswerAbove } from '../../provider-relay/relayed-json-rpc-lines'

/** A turn is work from its start notification to its completion; the daemon never idle-stops it. */
export const CODEX_RELAY_WORK_MARKERS: ProviderRelayWorkMarkers = {
  workStarts: ['turn/started'],
  workEnds: ['turn/completed']
}

/** The kept agent's answer to the first app's `initialize`; callers only need it to resolve. */
export function keptInitializeResult(line: string | null): unknown {
  return jsonRpcResultOf(line) ?? {}
}

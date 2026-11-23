import { providerTimelineTurnKeyPart } from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import { ACP_PROMPT_TURN_PREFIX } from '../../timeline/acp-prompt-turns'
import type { AcpStructuredSessionAdapterDeps } from '../acp-structured-session-adapter-deps'
import { assertAcpStartingSession, type AcpStructuredChild } from '../children/acp-structured-child'

/** The message that opened a chat's running prompt turn, from the journal's spelling of its id;
 *  null for other turns and for ids too long to have been kept whole. */
function promptClientMessageId(turnId: string): string | null {
  const part = providerTimelineTurnKeyPart(turnId)
  if (part === null || part.includes('#')) {
    return null
  }
  let turn: string
  try {
    turn = decodeURIComponent(part)
  } catch {
    return null
  }
  return turn.startsWith(ACP_PROMPT_TURN_PREFIX) ? turn.slice(ACP_PROMPT_TURN_PREFIX.length) : null
}

/**
 * After a kept agent's chat opened: the turn the earlier app left running carries on (the agent's
 * answer to that prompt ends it), then the output held since the last ack is let through in order.
 */
export async function carryOnKeptAcpAgent<Opened>(
  opened: Opened,
  child: AcpStructuredChild,
  deps: Pick<AcpStructuredSessionAdapterDeps, 'runningTurnId'>,
  signal: AbortSignal
): Promise<Opened> {
  const { kept } = child.connection
  if (!kept) {
    return opened
  }
  const turnId = (await deps.runningTurnId?.(child.sessionId).catch(() => null)) ?? null
  assertAcpStartingSession(child, () => signal.aborted)
  const clientMessageId = turnId === null ? null : promptClientMessageId(turnId)
  if (clientMessageId !== null) {
    child.turns?.adoptEarlier(clientMessageId, () => kept.earlierPrompt())
  }
  kept.releaseOutput()
  return opened
}

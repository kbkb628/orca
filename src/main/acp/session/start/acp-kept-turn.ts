import { ACP_PROMPT_TURN_PREFIX } from '../../timeline/acp-prompt-turns'
import type { AcpStructuredSessionAdapterDeps } from '../acp-structured-session-adapter-deps'
import { assertAcpStartingSession, type AcpStructuredChild } from '../children/acp-structured-child'

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
  if (turnId?.startsWith(ACP_PROMPT_TURN_PREFIX)) {
    const clientMessageId = turnId.slice(ACP_PROMPT_TURN_PREFIX.length)
    child.turns?.adoptEarlier(clientMessageId, () => kept.earlierPrompt())
  }
  kept.releaseOutput()
  return opened
}

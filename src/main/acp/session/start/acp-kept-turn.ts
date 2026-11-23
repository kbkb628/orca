import { providerTimelineTurnKeyPart } from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import { ACP_PROMPT_TURN_PREFIX } from '../../timeline/acp-prompt-turns'
import { structuredAgentSessionCommandTurn } from '../../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { isStructuredAgentSessionCommandTurnId } from '../../../native-chat/agent-session-wire/operations/structured-agent-session-command-turn'
import type { AcpKeptRows } from './acp-kept-rows'
import type { StructuredAgentSessionCommandRun } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
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

/** The host's `/compact` turn as it saved it, so the compaction's answer settles it as usual. */
async function savedCommandRun(
  child: AcpStructuredChild,
  turnId: string
): Promise<StructuredAgentSessionCommandRun | null> {
  const clientMessageId = turnId.slice('compact:'.length)
  const turn = structuredAgentSessionCommandTurn(clientMessageId)
  const saved = await child.events
    ?.journalHistory?.()
    ?.readInOrder((reads) => reads.itemDetail(turn.itemId))
    .catch(() => null)
  const running = saved?.body
  return running?.kind === 'turn' && running.state === 'running'
    ? {
        clientMessageId,
        turnId: turn.turnId,
        identity: turn.identity,
        resultIdentity: turn.resultIdentity,
        running
      }
    : null
}

/**
 * After a kept agent's chat opened: the prompt or `/compact` turn the earlier app left running
 * carries on (the agent's answer to that prompt ends it), then the output held since the last ack is let through in order.
 */
export async function carryOnKeptAcpAgent<Opened>(
  opened: Opened,
  child: AcpStructuredChild,
  deps: Pick<AcpStructuredSessionAdapterDeps, 'runningTurnId'>,
  signal: AbortSignal,
  rows: AcpKeptRows | null = null
): Promise<Opened> {
  const { kept } = child.connection
  if (!kept) {
    return opened
  }
  const turnId = (await deps.runningTurnId?.(child.sessionId).catch(() => null)) ?? null
  assertAcpStartingSession(child, () => signal.aborted)
  const command =
    turnId !== null && isStructuredAgentSessionCommandTurnId(turnId)
      ? await savedCommandRun(child, turnId)
      : null
  assertAcpStartingSession(child, () => signal.aborted)
  const clientMessageId =
    command?.clientMessageId ?? (turnId === null ? null : promptClientMessageId(turnId))
  if (clientMessageId !== null && child.turns && !child.turns.running) {
    if (command) {
      child.lane?.beginCommand(command)
    }
    const answered = kept.earlierPrompt()
    // Saved rows are continued only within the carried turn.
    void answered.then(
      () => rows?.end(),
      () => rows?.end()
    )
    child.turns.adoptEarlier(clientMessageId, () => answered, command?.turnId)
  } else {
    rows?.end()
  }
  kept.releaseOutput()
  return opened
}

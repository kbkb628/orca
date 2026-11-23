import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { createLegacyProviderTimelineIdentityScheme } from '../../../native-chat/agent-session-timeline/provider-timeline-identity'
import {
  providerKey,
  ProviderTimelineRows
} from '../../../native-chat/agent-session-timeline/provider-timeline-rows'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { AcpSessionEvent } from '../../protocol/acp-session-events'
import type { AcpStructuredSessionAdapterDeps } from '../acp-structured-session-adapter-deps'
import type { StructuredAgentSessionAcquireInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AcpTimelineTranslator } from '../../timeline/acp-timeline-translator'
import { acpNamedTextKey } from '../../timeline/acp-turn-messages'

import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'

type SavedRow = (itemId: string) => Promise<AgentJournalRenderItem | null>

/** The provider item a text chunk or call update continues, when the earlier app may have saved it. */
function continuedItem(event: AcpSessionEvent): { key: string; text?: string } | null {
  if (event.kind !== 'known') {
    return null
  }
  const { update } = event.notification
  if (update.sessionUpdate === 'tool_call_update') {
    return { key: `tool:${update.toolCallId}` }
  }
  if (
    (update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk') &&
    update.messageId &&
    update.content.type === 'text'
  ) {
    const channel = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
    return { key: acpNamedTextKey(update.messageId, channel), text: update.content.text }
  }
  return null
}

/** The chunk with the saved text ahead of its own, so the stream's snapshot is the whole message. */
function afterSavedText(event: AcpSessionEvent, saved: AgentJournalRenderItem): AcpSessionEvent {
  if (event.kind !== 'known' || saved.body.kind !== 'message') {
    return event
  }
  const { update } = event.notification
  const text = saved.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
  if (
    !text ||
    (update.sessionUpdate !== 'agent_message_chunk' &&
      update.sessionUpdate !== 'agent_thought_chunk') ||
    update.content.type !== 'text'
  ) {
    return event
  }
  const content = { ...update.content, text: text + update.content.text }
  return { ...event, notification: { ...event.notification, update: { ...update, content } } }
}

/**
 * A kept agent's updates to a message or call the earlier app saved, during the turn it carries
 * on. This run's translator has seen neither, and a text or call write replaces the saved row
 * whole, so the first update to each waits for that row once and continues it. Later updates keep
 * their order behind it. Ends with the carried turn; after that nothing is read.
 */
export class AcpKeptRows {
  private readonly seen = new Set<string>()
  private held: (() => void)[] | null = null
  private ended = false

  constructor(
    private readonly deps: {
      agent: AgentType
      sessionId: string
      translator: () => AcpTimelineTranslator | undefined
      read: SavedRow
    }
  ) {}

  end(): void {
    this.ended = true
    this.seen.clear()
  }

  route(deliver: (event: AcpSessionEvent) => void): (event: AcpSessionEvent) => void {
    const route = (event: AcpSessionEvent): void => {
      if (this.held) {
        this.held.push(() => route(event))
        return
      }
      const translator = this.deps.translator()
      // A call this run saw begin has nothing saved before it.
      const update = event.kind === 'known' ? event.notification.update : null
      if (!this.ended && update?.sessionUpdate === 'tool_call') {
        this.seen.add(`tool:${update.toolCallId}`)
      }
      const item = this.ended || !translator ? null : continuedItem(event)
      if (!translator || !item || this.seen.has(item.key)) {
        deliver(event)
        return
      }
      this.seen.add(item.key)
      this.held = []
      void this.deps
        .read(this.rowId(translator, item.key))
        .catch(() => null)
        .then((saved) => {
          if (saved?.body.kind === 'tool-call') {
            translator.carryTool(saved.body)
          }
          deliver(saved ? afterSavedText(event, saved) : event)
          const held = this.held ?? []
          this.held = null
          for (const next of held) {
            next()
          }
        })
    }
    return route
  }

  private rowId(translator: AcpTimelineTranslator, key: string): string {
    const namespace = translator.providerSessionId
    const rows = new ProviderTimelineRows({
      scheme: createLegacyProviderTimelineIdentityScheme(this.deps),
      generation: '',
      namespace
    })
    return rows.item('item', providerKey(key), namespace).itemId
  }
}

/** The gate for a kept agent's chat, reading saved rows from its journal; null for a fresh agent. */
export function keptAcpRows(
  kept: unknown,
  events: StructuredAgentSessionEventSink | undefined,
  chat: {
    deps: Pick<AcpStructuredSessionAdapterDeps, 'spec'>
    acquire: Pick<StructuredAgentSessionAcquireInput, 'identity'>
  },
  translator: () => AcpTimelineTranslator | undefined
): AcpKeptRows | null {
  return kept && events
    ? new AcpKeptRows({
        agent: chat.deps.spec.agent,
        sessionId: chat.acquire.identity.sessionId,
        translator,
        read: async (itemId) =>
          (await events.journalHistory?.()?.readInOrder((reads) => reads.itemDetail(itemId))) ??
          null
      })
    : null
}

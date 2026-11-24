import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { OrchestrationDb } from '../../../../runtime/orchestration/db/orchestration-db'
import { settleStructuredMailAttempt } from '../../../../runtime/orchestration/mailbox/structured-mail/structured-mail-custody'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'

// Phase-1 evidence: Stop on a turn the agent never ends, with a person follow-up and real mailbox mail queued.
let rig: QueuedMessageTestRig
let db: OrchestrationDb
let dir: string
afterEach(async () => {
  await rig.dispose()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const MAILBOX = 'term_bot'

describe('#47817 host Stop with real mailbox mail', () => {
  it('H2: Stop settles the stuck turn and status, holds the follow-up, and leaves the mail unread without re-delivery', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-47817-'))
    db = new OrchestrationDb(join(dir, 'orchestration.db'))
    const message = db.insertMessage({ from: 'term_sender', to: MAILBOX, subject: 'please run' })
    rig = await createQueuedMessageTestRig({ windsDown: true })
    const statuses: { sessionId?: string; status?: unknown }[] = []
    rig.host.subscribeStatus({
      id: 'status',
      emit: (event) => statuses.push(event as never)
    })

    const stuck = await rig.workingSend()
    await rig.settleAccepted(stuck, 'working')
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: `turn-of-${stuck}`, ordinal: 0 },
      {
        kind: 'turn',
        turnId: `turn-of-${stuck}`,
        startedAt: HOST_TEST_NOW,
        userItemId: agentJournalSubmissionKey(stuck),
        state: 'running'
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const followUp = await rig.send('then fix the tests', 'queue-if-active').result
    expect(followUp).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    const followUpId = (followUp as { value: { queued: { messageId: string } } }).value.queued
      .messageId

    const from: AgentMessageSource = {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: MAILBOX,
        dispatchId: null,
        messages: [{ messageId: message.id, runId: null, from: 'term_sender', content: '' }]
      }
    } as never
    const mailSend = rig.send('check your mailbox', 'queue-if-active', { internal: true, from })
    const operationId = mailSend.id
    const attempt = {
      mailbox_handle: MAILBOX,
      message_id: message.id,
      session_id: SESSION,
      operation_id: operationId,
      minted_at_ms: HOST_TEST_NOW
    }
    expect(db.reserveStructuredMailSend(attempt)).toBe(true)
    const mail = await mailSend.result
    const mailCardId = (mail as { value: { queued?: { messageId: string } } }).value.queued
      ?.messageId
    const fenceBefore = rig.store.getRecord(SESSION)!.lease.runtimeFence

    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(rig.closeSession).toHaveBeenCalled())
    await eventually(async () =>
      expect((await rig.host.currentWork(SESSION))?.working() ?? false).toBe(false)
    )
    await rig.host.flushAllStreamedEvents()

    const observation = await rig.host.mailObservation(attempt)
    const decision = settleStructuredMailAttempt(db, attempt, observation, () => 'owed')
    const after = db.getMessageById(message.id)!
    const report = {
      mailCardId,
      operationId,
      observation: observation.state,
      withdrawal: observation.withdrawal,
      decision,
      mailRead: after.read,
      mailDelivered: after.delivered_at !== null,
      attemptLeft: db.getStructuredMailSend(MAILBOX, message.id) !== undefined,
      dispatches: rig.dispatch.mock.calls.map(([input]) => input.clientMessageId),
      drafts: await rig.drafts(),
      queuePause: await rig.queuePause(),
      followUpHandedOff: (await rig.handoff(followUpId)) !== undefined,
      savedLastTurn: rig.store.getRecord(SESSION)!.lastTurn?.state ?? null,
      lastPublished: statuses.filter((event) => JSON.stringify(event).includes(SESSION)).at(-1),
      fence: [fenceBefore, rig.store.getRecord(SESSION)!.lease.runtimeFence]
    }
    console.log('H2 observed', JSON.stringify(report))

    expect(report.dispatches.filter((id) => id === stuck)).toHaveLength(1)
    expect(report.dispatches).not.toContain(operationId)
    expect(report.followUpHandedOff).toBe(false)
    expect(report.fence[1]).toBeGreaterThanOrEqual(report.fence[0])
    expect(report.savedLastTurn).not.toBe('open')
  })
})

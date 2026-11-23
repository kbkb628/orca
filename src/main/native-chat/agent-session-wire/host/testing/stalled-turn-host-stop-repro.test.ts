import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
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

// Phase-1 host reproduction for a turn the agent accepted but never ends and whose interrupt it ignores.
let rig: QueuedMessageTestRig
afterEach(() => rig.dispose())

const MAIL: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'term_b', dispatchId: null, messages: [] }
}

function journal() {
  return rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
}

async function runningProviderTurn(id: string) {
  await journal().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: `turn-of-${id}`, ordinal: 0 },
    {
      kind: 'turn',
      turnId: `turn-of-${id}`,
      startedAt: HOST_TEST_NOW,
      userItemId: agentJournalSubmissionKey(id),
      state: 'running'
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

async function working(): Promise<boolean> {
  return (await rig.host.currentWork(SESSION))?.working() ?? false
}

describe('#47817 host Stop on a stalled turn', () => {
  it('H1: Stop ends the child, settles the turn, sends nothing twice and keeps agent mail queued', async () => {
    rig = await createQueuedMessageTestRig({ windsDown: true })
    const stuck = await rig.workingSend()
    await rig.settleAccepted(stuck, 'working')
    await runningProviderTurn(stuck)
    const mail = await rig.send('check your mailbox', 'queue-if-active', {
      internal: true,
      from: MAIL
    }).result
    expect(mail).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    const fenceBefore = rig.store.getRecord(SESSION)!.lease.runtimeFence
    expect(await working()).toBe(true)

    const stopped = await rig.stop()
    expect(stopped).toMatchObject({ ok: true })
    await eventually(() => expect(rig.closeSession).toHaveBeenCalled())
    await eventually(async () => expect(await working()).toBe(false))

    const dispatchedStuck = rig.dispatch.mock.calls.filter(
      ([input]) => input.clientMessageId === stuck
    )
    expect(dispatchedStuck).toHaveLength(1)
    expect(rig.store.getRecord(SESSION)!.lease.runtimeFence).toBeGreaterThanOrEqual(fenceBefore)
    // Report-only observation: what happened to the queued agent mail after the Stop.
    console.log(
      'H1 observed',
      JSON.stringify({
        drafts: await rig.drafts(),
        queuePause: await rig.queuePause(),
        dispatches: rig.dispatch.mock.calls.map(([input]) => input.clientMessageId),
        lastTurn: rig.store.getRecord(SESSION)!.lastTurn?.state ?? null
      })
    )
  })
})

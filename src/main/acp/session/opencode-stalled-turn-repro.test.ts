import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

// Phase-1 reproduction for a stalled OpenCode turn; synthetic agent, no real provider.
afterEach(async () => {
  await closeProviderTimelineRigs()
})

const OPENCODE = acpLaunchSpecFor('opencode')!
const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}
const MODELS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'lane/a',
    options: [
      { value: 'lane/a', name: 'A' },
      { value: 'lane/b', name: 'B' }
    ]
  }
]
// What OpenCode's ACP answers when its own server refuses POST /api/session/:id/model with 503.
const SERVER_503 = { code: -32603, message: 'Internal error', data: { details: 'HTTP 503' } }

async function turns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

async function openOpenCode(script: Parameters<typeof openAcpAdapterRig>[0]['script']) {
  return openAcpAdapterRig({
    spec: OPENCODE,
    deps: { stopGraceMs: 50 },
    script: (agent) => {
      agent.on('session/new', (frame) =>
        agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: MODELS })
      )
      script?.(agent)
    }
  })
}

describe('#47817 OpenCode stalled turn', () => {
  it('R1: a model write the agent refuses with 503 fails the send visibly and sends no prompt', async () => {
    const rig = await openOpenCode((agent) => {
      agent.on('session/set_config_option', (frame) =>
        agent.fail(frame, SERVER_503.code, SERVER_503.message, SERVER_503.data)
      )
    })
    await rig.acquire()
    await expect(
      rig.adapter.dispatch({
        sessionId: SESSION,
        clientMessageId: 'send-1',
        body: hello,
        fence: 1,
        executionOptions: { model: 'lane/b' }
      })
    ).rejects.toMatchObject({ name: expect.any(String) })
    await rig.settle()
    expect(rig.sent('session/prompt')).toHaveLength(0)
    expect((await turns(rig)).filter((turn) => turn.state === 'running')).toEqual([])
  })

  it('R2: a prompt the agent never answers stays running with a live child until Stop', async () => {
    const rig = await openOpenCode(() => {})
    await rig.acquire()
    expect(
      await rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'send-1', body: hello, fence: 1 })
    ).toEqual({ state: 'admitted' })
    await rig.frame('session/prompt')
    await new Promise((resolve) => setTimeout(resolve, 200))
    await rig.settle()
    expect(rig.child().exited).toBe(false)
    expect((await turns(rig)).at(-1)).toMatchObject({ state: 'running' })
  })

  it('R3: Stop on a prompt that ignores session/cancel ends at grace and settles the turn', async () => {
    const rig = await openOpenCode(() => {})
    await rig.acquire()
    await rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'send-1', body: hello, fence: 1 })
    await rig.frame('session/prompt')
    const stoppedAt = Date.now()
    await expect(
      rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1, stoppedAt })
    ).resolves.toEqual({ cancelled: true })
    await rig.frame('session/cancel')
    await rig.adapter.awaitStoppedRequestEnd!(SESSION, stoppedAt)
    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
    // What the host's stopAgent does once grace expires.
    await rig.adapter.closeSession!(SESSION)
    await waitFor(async () => expect((await turns(rig)).at(-1)?.state).not.toBe('running'))
    expect(rig.settled).toEqual(
      expect.arrayContaining([expect.objectContaining({ clientMessageId: 'send-1' })])
    )
  })

  it('R4: reopening the chat after the child ends never re-sends the accepted prompt', async () => {
    const rig = await openOpenCode(() => {})
    await rig.acquire()
    await rig.adapter.dispatch({ sessionId: SESSION, clientMessageId: 'send-1', body: hello, fence: 1 })
    await rig.frame('session/prompt')
    rig.child().exit()
    await waitFor(() => expect(rig.ended).toHaveLength(1))
    await rig.acquire({ fence: 2 })
    await rig.settle()
    expect(rig.sent('session/prompt')).toHaveLength(0)
  })
})

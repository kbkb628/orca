import { expect, it } from 'vitest'
import {
  observeAgentPickerAcquisition,
  retryAgentPickerCatalog
} from './agent-launch-picker-acquisition'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const ENTRY: AgentPickerEntry = {
  agent: 'antigravity',
  label: 'Antigravity',
  rows: [],
  surfaces: ['chat'],
  defaultSurface: 'chat',
  terminal: { options: {} },
  structured: { options: {} },
  catalog: { origin: 'unknown' }
}
const catalog = (id: string): AgentPickerEntry['catalog'] => ({
  origin: 'probe',
  fetchedAt: 0,
  models: [{ id, label: id, isDefault: false, efforts: [] }]
})

it('a Refresh supersedes a read already running and answers from a read that relists', async () => {
  const calls: { relist: boolean; answer: (value: AgentPickerEntry['catalog']) => void }[] = []
  let shown: AgentPickerEntry[] = []
  const stop = observeAgentPickerAcquisition(
    'refresh-order',
    [ENTRY],
    {
      catalog: (_entry, _wait, _signal, relist = false) =>
        new Promise((answer) => calls.push({ relist, answer })),
      support: async () => undefined
    },
    { publish: (entries) => (shown = entries), selected: () => 'antigravity' }
  )
  expect(calls.map((call) => call.relist)).toEqual([false])
  retryAgentPickerCatalog('refresh-order', 'antigravity', true)
  expect(calls.map((call) => call.relist)).toEqual([false, true])
  calls[0].answer(catalog('before-refresh'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(shown[0].catalogRead).toBe('pending')
  calls[1].answer(catalog('after-refresh'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(shown[0].catalog.origin !== 'unknown' && shown[0].catalog.models[0].id).toBe(
    'after-refresh'
  )
  expect(shown[0].catalogRead).toBe('settled')
  stop()
})

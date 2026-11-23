import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import { createAgentModelCatalogLiveListings } from './agent-model-catalog-live-listings'
import type { AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import SyncDatabase from '../../sqlite/sync-database'
import { parseAgyModelListing } from '../../antigravity/antigravity-model-listing'

const listing = (rows: string[]) => parseAgyModelListing(rows.join('\n'))
const levels = (family: string, name: string) =>
  ['high', 'medium', 'low'].map((level) => `${family}-${level}\t${name} (${level})`)
// What a live `agy acp` session, or a good `agy models` run, lists.
const FULL = listing([
  ...levels('gemini-4-neon', 'Gemini 4 Neon'),
  ...levels('gemini-4-argon', 'Gemini 4 Argon'),
  ...levels('gemini-3.8-flash', 'Gemini 3.8 Flash'),
  ...levels('claude-opus-5-5', 'Claude Opus 5.5'),
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
])
// A degraded `agy models` run: fewer rows, one renamed, one the full list lacks.
const DEGRADED = listing([
  ...levels('gemini-3.8-flash', 'Gemini 3.8 Flash Lite'),
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
])
const ONLY_FULL = ['gemini-4-neon', 'gemini-4-argon', 'claude-opus-5-5']
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

function catalog() {
  const clock = { now: 1_000_000 }
  const store = new AgentModelCatalogStore({ now: () => clock.now })
  const write = (
    models: typeof FULL,
    source: 'discovery' | 'live',
    fp = 'fp',
    agent = 'antigravity'
  ) =>
    store.recordSuccess(
      fp,
      agent,
      { models, origin: source === 'live' ? 'live-session' : 'probe' },
      source
    )
  const ids = (fp = 'fp') => store.get(fp)?.models.map((model) => model.id) ?? []
  return { clock, store, write, ids }
}

it('a shorter probe adds its new rows and newer labels; earlier rows age from when they were listed', () => {
  const { clock, write, ids, store } = catalog()
  write(FULL, 'discovery')
  const start = clock.now
  for (const after of [MINUTE, 2 * MINUTE, DAY - 1]) {
    clock.now = start + after
    write(DEGRADED, 'discovery')
    expect(ids()).toEqual(expect.arrayContaining([...ONLY_FULL, 'claude-sonnet-4-6']))
  }
  const flash = store.get('fp')?.models.find((model) => model.id === 'gemini-3.8-flash')
  expect(flash?.label).toBe('Gemini 3.8 Flash Lite')
  // A day after the full probe, not after the last short one, its other rows are gone.
  clock.now = start + DAY
  write(DEGRADED, 'discovery')
  expect(ids()).toEqual(DEGRADED.map((model) => model.id))
  expect(store.shouldRefresh('fp')).toBe(false)
})

it('a probe shorter than a chat lists again after five minutes, also after a later live write', () => {
  const { clock, write, store, ids } = catalog()
  write(FULL, 'live')
  clock.now += MINUTE
  const probed = clock.now
  write(DEGRADED, 'discovery')
  expect(ids()).toEqual(expect.arrayContaining(ONLY_FULL))
  clock.now = probed + 2 * MINUTE
  write(FULL, 'live')
  clock.now = probed + 5 * MINUTE - 1
  expect(store.shouldRefresh('fp')).toBe(false)
  clock.now = probed + 5 * MINUTE
  expect(store.shouldRefresh('fp')).toBe(true)
})

it('rows only an older listing shows ask for a listing the moment they turn a day old', () => {
  const { clock, write, store, ids } = catalog()
  const probed = clock.now
  write(FULL, 'discovery')
  clock.now += MINUTE
  write(
    FULL.filter((model) => !ONLY_FULL.includes(model.id)),
    'live'
  )
  expect(ids()).toEqual(expect.arrayContaining(ONLY_FULL))
  clock.now = probed + DAY - 1
  expect(store.shouldRefresh('fp')).toBe(false)
  clock.now = probed + DAY
  expect(store.shouldRefresh('fp')).toBe(true)
})

it('a Refresh lists its own catalog again past a failure hold and leaves sibling listings running', async () => {
  const { write, store } = catalog()
  write(FULL, 'discovery')
  write(FULL, 'discovery', 'other-fp')
  void store.refresh('other-fp', 'antigravity', () => new Promise(() => {}))
  // A catalog whose only record is a failed listing.
  await store.refresh('cold-fp', 'antigravity', () =>
    Promise.reject(new Error('agy models failed'))
  )
  expect(store.shouldRefresh('cold-fp')).toBe(false)
  const revision = store.retirementRevision('antigravity')
  store.relistScope('cold-fp')
  store.relistScope('fp')
  expect(store.shouldRefresh('cold-fp')).toBe(true)
  expect(store.shouldRefresh('fp')).toBe(true)
  expect(store.isListing('other-fp')).toBe(true)
  expect(store.retirementRevision('antigravity')).toBe(revision)
})

it("a kept probe copy never replaces a chat's newer menu for the same model", () => {
  const { clock, write, store } = catalog()
  const live = listing([
    ...levels('gemini-4-argon', 'Gemini 4 Argon'),
    'gemini-4-neon-high\tGemini 4 Neon (high)',
    'gemini-4-neon-low\tGemini 4 Neon (low)'
  ])
  const menu = (models: typeof FULL) =>
    models.find((model) => model.id === 'gemini-4-neon')?.efforts.map((effort) => effort.value)
  expect(menu(live)).not.toEqual(menu(FULL))
  write(FULL, 'discovery')
  clock.now += MINUTE
  write(live, 'live')
  clock.now += MINUTE
  write(DEGRADED, 'discovery')
  expect(menu(store.get('fp')?.models ?? [])).toEqual(menu(live))
})

it('a failed listing a day after a short probe leaves no kept row selectable', async () => {
  const { clock, write, store } = catalog()
  const start = clock.now
  write(FULL, 'discovery')
  clock.now += MINUTE
  write(DEGRADED, 'discovery')
  clock.now = start + DAY
  await store.refresh('fp', 'antigravity', () => Promise.reject(new Error('agy models failed')))
  expect(store.observation('fp')?.models.map((model) => model.id)).toEqual(
    DEGRADED.map((model) => model.id)
  )
})

describe('across a restart', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))
  // Each store has its own connection, as a separate process would.
  const opened = async (clock: { now: number }) => {
    const store = new AgentModelCatalogStore({ now: () => clock.now })
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    return store
  }
  const NATIVE = { variable: 'GEMINI_HOME', path: '/home/me/.gemini' }
  const ORCA_HOME = { variable: 'GEMINI_HOME', path: '/orca/agy-home' }
  const native = (home: AgentSessionAccountHome) => 'path' in home && home.path === NATIVE.path
  const probe = (
    store: AgentModelCatalogStore,
    models: typeof FULL,
    fingerprint = 'fp',
    accountHome = NATIVE
  ) =>
    store.recordSuccess(
      fingerprint,
      'antigravity',
      { models, origin: 'probe', accountHome },
      'discovery'
    )
  const ids = (store: AgentModelCatalogStore, fingerprint = 'fp') =>
    store.get(fingerprint)?.models.map((model) => model.id) ?? []

  it('forgetting a home deletes its catalogs on disk before it returns; other homes keep theirs', async () => {
    const clock = { now: 1_000_000 }
    const first = await opened(clock)
    probe(first, FULL)
    probe(first, FULL, 'folder-fp')
    probe(first, FULL, 'orca-fp', ORCA_HOME)
    await first.flushPersistence()
    first.forgetAccountHomes('antigravity', native)
    const second = await opened(clock)
    expect([second.get('fp'), second.get('folder-fp')]).toEqual([null, null])
    expect(ids(second, 'orca-fp')).toEqual(FULL.map((model) => model.id))
    probe(second, DEGRADED)
    await second.flushPersistence()
    const third = await opened(clock)
    expect(ids(third)).toEqual(DEGRADED.map((model) => model.id))
    expect(ids(third, 'orca-fp')).toEqual(FULL.map((model) => model.id))
    // Some SQLite bindings read a TEXT key only up to a NUL, leaving such rows undeletable.
    const db = new SyncDatabase(join(directory, 'agent-model-catalog.db'), { readonly: true })
    const keys = db
      .prepare('SELECT key FROM rows')
      .all()
      .map((row) => String(row.key))
    db.close()
    expect(keys.filter((key) => key.includes('\u0000'))).toEqual([])
  })

  it('forgetting a home fences the chats on it, not the chats on other homes', () => {
    const store = new AgentModelCatalogStore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a chat's catalog source reads only these deps.
    const deps = {
      store,
      getRecord: () => undefined,
      drivesRecord: () => true
    } as unknown as AgentModelCatalogServiceDeps
    const live = createAgentModelCatalogLiveListings(deps, new AbortController().signal)
    const location = { executionHostId: 'local', wslDistro: null, workspaceId: 'w' }
    const chat = (accountHome: typeof NATIVE) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the source reads only these record fields.
      const record = {
        sessionId: 's',
        provider: 'antigravity',
        accountHome,
        location,
        launchDirectory: '/w'
      } as unknown as AgentSessionRecord
      const source = live.captureSource(record)
      source.bind?.(record)
      return source
    }
    const [onNative, onOrca] = [chat(NATIVE), chat(ORCA_HOME)]
    store.forgetAccountHomes('antigravity', native)
    expect([onNative(), onOrca(), chat(NATIVE)()]).toEqual([false, true, true])
  })

  it('a probe listing the same rows again saves when it listed them', async () => {
    const clock = { now: 1_000_000 }
    const start = clock.now
    const before = await opened(clock)
    probe(before, FULL)
    // Saved, as it is half a second later.
    await before.flushPersistence()
    clock.now = start + 20 * 60 * MINUTE
    probe(before, FULL)
    await before.flushPersistence()
    const after = await opened(clock)
    clock.now = start + 25 * 60 * MINUTE
    probe(after, DEGRADED)
    expect(ids(after)).toEqual(expect.arrayContaining(ONLY_FULL))
  })
})

it("a forget that can't be saved throws, and a probe started before it saves nothing", async () => {
  const store = new AgentModelCatalogStore()
  await store.attachPersistence({
    load: async () => [],
    save: () => {},
    flush: async () => {},
    saveNow: () => {
      throw new Error('disk full')
    }
  })
  const accountHome = { variable: 'GEMINI_HOME', path: '/home/me/.gemini' }
  store.recordSuccess(
    'fp',
    'antigravity',
    { models: FULL, origin: 'probe', accountHome },
    'discovery'
  )
  const listed = Promise.withResolvers<{ models: typeof FULL; origin: 'probe' }>()
  const probing = store.refresh(
    'new-fp',
    'antigravity',
    () => listed.promise,
    undefined,
    undefined,
    accountHome
  )
  expect(() => store.forgetAccountHomes('antigravity', () => true)).toThrow('disk full')
  listed.resolve({ models: FULL, origin: 'probe' })
  await probing
  expect([store.get('fp'), store.get('new-fp')]).toEqual([null, null])
})

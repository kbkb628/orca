import { expect, it } from 'vitest'
import { AntigravityAccountService } from './native-account-service'
import {
  reportingCredentialChanges,
  setAntigravityNativeCredentialChangeListener
} from './native-account-host'
import { forgetPreviousAgyLoginCatalog } from './antigravity-login-catalog'
import { credential, harness, refreshedWithoutIdToken } from './native-account-test-fixtures'
import { parseAgyModelListing } from './antigravity-model-listing'
import { agentModelCatalogStore as store } from '../native-chat/agent-model-catalog/agent-model-catalog-store'

const HOST_AGY = { variable: 'GEMINI_HOME', path: '/home/me/.gemini' }
const ORCA_AGY = { variable: 'GEMINI_HOME', path: '/orca/antigravity-agy-home' }

function agy(target: { runtime: 'host' | 'wsl'; wslDistro: string | null }, subject = 'a') {
  const native = harness(credential('a'))
  const reporting = reportingCredentialChanges(native.backend, target, async () => ({
    issuer: 'https://accounts.google.com',
    subject,
    email: null
  }))
  const service = new AntigravityAccountService(
    native.store,
    reporting,
    Date.now,
    native.lookupIdentity
  )
  return { ...native, service }
}
const saveCatalogs = () => {
  for (const [fingerprint, accountHome] of [
    ['host-agy', HOST_AGY],
    ['orca-agy', ORCA_AGY]
  ] as const) {
    store.recordSuccess(
      fingerprint,
      'antigravity',
      {
        models: parseAgyModelListing('gemini-4-neon-high\tGemini 4 Neon (high)'),
        origin: 'probe',
        accountHome
      },
      'discovery'
    )
  }
}
const saved = () => [store.get('host-agy') !== null, store.get('orca-agy') !== null]
setAntigravityNativeCredentialChangeListener(forgetPreviousAgyLoginCatalog)

it("agy signing in to another host account drops that login's catalogs only; the same account or a WSL distro's keeps them", async () => {
  const host = agy({ runtime: 'host', wslDistro: null })
  await host.service.addCurrentAccount()
  host.setNative(credential('b'))
  const { accounts } = await host.service.addCurrentAccount()
  const b = accounts.find((row) => row.subject === 'b')!.id
  saveCatalogs()
  const revision = store.retirementRevision('antigravity')

  await host.service.selectAccount(b)
  host.setNative(credential('b', 2))
  await host.service.listAccounts()
  const wsl = agy({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  await wsl.service.listAccounts()
  wsl.setNative(credential('b'))
  await wsl.service.listAccounts()
  expect(saved()).toEqual([true, true])

  // Outside Orca.
  host.setNative(credential('a'))
  await host.service.listAccounts()
  expect(saved()).toEqual([false, true])
  saveCatalogs()
  await host.service.selectAccount(b)
  expect(saved()).toEqual([false, true])
  // Chats on Orca's own home keep saving what they list.
  expect(store.retirementRevision('antigravity')).toBe(revision)
})

it('a token-only credential retires the catalog only once Google names another account', async () => {
  const same = agy({ runtime: 'host', wslDistro: null }, 'a')
  await same.service.listAccounts()
  saveCatalogs()
  same.setNative(refreshedWithoutIdToken(2, 'refresh-2'))
  await same.service.listAccounts()
  expect(saved()).toEqual([true, true])

  const other = agy({ runtime: 'host', wslDistro: null }, 'b')
  await other.service.listAccounts()
  other.setNative(refreshedWithoutIdToken(2, 'refresh-2'))
  await other.service.listAccounts()
  expect(saved()).toEqual([false, true])
})

it("a switch whose forgetting can't be saved is refused and leaves agy on its account", async () => {
  await store.attachPersistence({
    load: async () => [],
    save: () => {},
    flush: async () => {},
    saveNow: () => {
      throw new Error('disk full')
    }
  })
  const host = agy({ runtime: 'host', wslDistro: null })
  await host.service.addCurrentAccount()
  host.setNative(credential('b'))
  const { accounts } = await host.service.addCurrentAccount()
  host.setNative(credential('a'))
  await host.service.listAccounts()
  saveCatalogs()
  const b = accounts.find((row) => row.subject === 'b')!.id
  await expect(host.service.selectAccount(b)).rejects.toThrow('disk full')
  expect(host.getNative()).toBe(credential('a'))
})

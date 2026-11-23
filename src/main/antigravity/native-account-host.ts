import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import type { AntigravityAccountTarget } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import {
  parseAntigravityNativeCredential,
  type AntigravityCredentialIdentity,
  type AntigravityNativeCredential
} from './native-credential-codec'
import { fetchGoogleIdentity } from './google-userinfo-identity'
import { createAntigravityHostCredentialBackend } from './native-credential-backend'
import { createAntigravityWslCredentialBackend } from './native-wsl-credentials'
import { resolveWslDefaultDistro } from '../wsl/discovery/wsl-default-distro'
import {
  AntigravityAccountService,
  type AntigravityCredentialBackend
} from './native-account-service'
import { isSameAntigravityLogin } from './native-account-usage-reading'
import type { RateLimitRuntimeTarget } from '../../shared/agent-usage/rate-limits/rate-limit-types'
import { ANTIGRAVITY_USAGE_HOST_TARGET } from '../rate-limits/providers/antigravity/antigravity-account-usage'

let service: AntigravityAccountService | null = null
const wslServices = new Map<string, AntigravityAccountService>()
/** `otherLogin`: agy in `target` now holds a confirmed other account than the last one Orca saw
 *  there. The listener may throw to refuse it: a write is not made, a read reports it again. */
export type AntigravityNativeCredentialChange = {
  target: RateLimitRuntimeTarget
  otherLogin: boolean
}

let credentialChangeListener: (change: AntigravityNativeCredentialChange) => void = () => {}

export function setAntigravityNativeCredentialChangeListener(
  listener: (change: AntigravityNativeCredentialChange) => void
): void {
  credentialChangeListener = listener
}

type Login = { credential: AntigravityNativeCredential; subject: Promise<string | null> }

// The first read is a baseline: what agy held before Orca looked is unknown.
// agy's own token refreshes keep the refresh token and must not discard the usage they produce;
// a new refresh token is a fresh sign-in, even to the same account, and must clear a sign-in hold.
export function reportingCredentialChanges(
  backend: AntigravityCredentialBackend,
  target: RateLimitRuntimeTarget,
  lookupIdentity: (
    accessToken: string
  ) => Promise<AntigravityCredentialIdentity> = fetchGoogleIdentity
): AntigravityCredentialBackend {
  let lastSeen: AntigravityNativeCredential | null | undefined
  // Survives a sign-out, so signing in to another account reads as one.
  let lastLogin: Login | undefined
  // A token-only credential names its account once Google confirms it; unconfirmed is no change.
  const login = (credential: AntigravityNativeCredential): Login => ({
    credential,
    subject: credential.identity
      ? Promise.resolve(credential.identity.subject)
      : lookupIdentity(credential.accessToken).then(
          (identity) => identity.subject,
          () => null
        )
  })
  const otherLogin = async (next: Login): Promise<boolean> => {
    if (!lastLogin || isSameAntigravityLogin(lastLogin.credential, next.credential)) {
      return false
    }
    if (lastLogin.credential.authMethod !== next.credential.authMethod) {
      return true
    }
    const [previous, current] = await Promise.all([lastLogin.subject, next.subject])
    return previous !== null && current !== null && previous !== current
  }
  const report = async (next: Login): Promise<void> =>
    credentialChangeListener({ target, otherLogin: await otherLogin(next) })
  return {
    ...backend,
    async read() {
      const current = await backend.read()
      const next =
        current &&
        (current.contents === lastLogin?.credential.contents ? lastLogin : login(current))
      if (
        next &&
        lastSeen !== undefined &&
        (lastSeen === null ||
          lastSeen.refreshToken !== current.refreshToken ||
          !isSameAntigravityLogin(lastSeen, current))
      ) {
        try {
          await report(next)
        } catch (error) {
          console.warn('[antigravity] agy changed accounts; Orca will try to note it again:', error)
          return current
        }
      }
      lastSeen = current
      lastLogin = next ?? lastLogin
      return current
    },
    // Switching agy to another account first forgets what the previous one listed, durably.
    async write(contents, expected) {
      const parsed =
        lastLogin && tryParse(backend.parse ?? parseAntigravityNativeCredential, contents)
      const next = parsed && login(parsed)
      if (next && (await otherLogin(next))) {
        credentialChangeListener({ target, otherLogin: true })
      }
      await backend.write(contents, expected)
      lastLogin = next ?? lastLogin
    }
  }
}

function tryParse(
  parse: (contents: string) => AntigravityNativeCredential,
  contents: string
): AntigravityNativeCredential | null {
  try {
    return parse(contents)
  } catch {
    return null
  }
}

export function getAntigravityAccountVaultPath(wslDistro?: string): string {
  const root = join(getAppEnvironment().getPath('userData'), 'antigravity-accounts')
  // Each distro keeps its own saved accounts, matching its own agy login.
  return wslDistro
    ? join(root, `wsl-${encodeURIComponent(wslDistro.trim().toLowerCase())}`, 'vault')
    : join(root, 'vault')
}

function createService(
  backend: AntigravityCredentialBackend,
  vaultPath: string,
  target: RateLimitRuntimeTarget = ANTIGRAVITY_USAGE_HOST_TARGET
) {
  const reporting = reportingCredentialChanges(backend, target)
  return new AntigravityAccountService(
    createEncryptedAntigravityAccountStore(vaultPath, reporting.parse),
    reporting,
    undefined,
    undefined,
    target
  )
}

async function resolveWslAccountDistro(wslDistro: string | null | undefined): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error('Antigravity accounts in a WSL distro are only available on Windows.')
  }
  const distro = wslDistro?.trim() || (await resolveWslDefaultDistro())
  if (typeof distro !== 'string' || !distro) {
    throw new Error('Orca could not determine the default WSL distro for Antigravity accounts.')
  }
  return distro
}

export async function getAntigravityAccountService(
  target: AntigravityAccountTarget
): Promise<AntigravityAccountService> {
  if (target.runtime === 'wsl') {
    const distro = await resolveWslAccountDistro(target.wslDistro)
    const key = distro.toLowerCase()
    let wslService = wslServices.get(key)
    if (!wslService) {
      wslService = createService(
        createAntigravityWslCredentialBackend(distro),
        getAntigravityAccountVaultPath(distro),
        { runtime: 'wsl', wslDistro: distro }
      )
      wslServices.set(key, wslService)
    }
    return wslService
  }
  if (target.wslDistro) {
    throw new Error('An Antigravity host account target cannot name a WSL distro.')
  }
  service ??= createService(
    createAntigravityHostCredentialBackend(getAppEnvironment().getPath('home')),
    getAntigravityAccountVaultPath()
  )
  return service
}

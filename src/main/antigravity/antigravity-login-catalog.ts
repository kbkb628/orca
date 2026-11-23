import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { isAntigravityHostAccountHome } from './antigravity-host-acp'
import type { AntigravityNativeCredentialChange } from './native-account-host'

/** agy on this machine signed in to another account, through Orca or not: the catalogs listed with
 *  its login are the previous account's (#46905). Orca's own homes (API key, managed server) and a
 *  WSL distro's agy keep theirs. Throws when that can't be saved, so the switch is refused. */
export function forgetPreviousAgyLoginCatalog(change: AntigravityNativeCredentialChange): void {
  if (change.otherLogin && change.target.runtime === 'host') {
    agentModelCatalogStore.forgetAccountHomes('antigravity', isAntigravityHostAccountHome)
  }
}

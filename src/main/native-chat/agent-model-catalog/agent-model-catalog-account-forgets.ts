import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentModelCatalogSuccess } from './agent-model-catalog-entry'

const KEPT_FORGETS = 64

/** Account homes whose catalogs were forgotten, numbered in order, so a listing started under the
 *  previous login (a probe or a chat still running on it) cannot save into the next one's. */
export class AgentModelCatalogAccountForgets {
  private count = 0
  private readonly log: {
    at: number
    agent: string
    matches: (home: AgentSessionAccountHome) => boolean
  }[] = []

  current = (): number => this.count

  forget(agent: string, matches: (home: AgentSessionAccountHome) => boolean): void {
    this.log.push({ at: ++this.count, agent, matches })
    this.log.splice(0, this.log.length - KEPT_FORGETS)
  }

  /** `write` for a listing under `home` starting now: tagged with it, dropped once it's forgotten. */
  writer<Rest extends unknown[], Entry>(
    agent: string,
    home: AgentSessionAccountHome | null | undefined,
    write: (key: string, agent: string, success: AgentModelCatalogSuccess, ...rest: Rest) => Entry
  ): (
    key: string,
    agent: string,
    success: AgentModelCatalogSuccess,
    ...rest: Rest
  ) => Entry | null {
    const since = this.count
    return (key, name, success, ...rest) =>
      this.since(since, agent, home)
        ? null
        : write(key, name, home ? { ...success, accountHome: home } : success, ...rest)
  }

  /** Whether `home` of `agent` was forgotten after `since`; one older than the log counts. */
  since(since: number, agent: string, home: AgentSessionAccountHome | null | undefined): boolean {
    if (!home || since >= this.count) {
      return false
    }
    return (
      since < this.count - KEPT_FORGETS ||
      this.log.some((forgot) => forgot.at > since && forgot.agent === agent && forgot.matches(home))
    )
  }
}

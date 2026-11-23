import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { keepsRicherAgentModelListing } from '../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import type { AgentModelCatalogEntry, AgentModelCatalogListing } from './agent-model-catalog-entry'

/** How long a row outlasts the last listing that showed it, where `keepsRicherAgentModelListing`. */
export const AGENT_MODEL_CATALOG_KEPT_ROW_MS = 24 * 60 * 60 * 1000
/** How soon a probe that lacked rows the catalog still shows lists again. */
export const AGENT_MODEL_CATALOG_SHORT_LISTING_RELIST_MS = 5 * 60 * 1000

/** When `listing` last showed `id`: its own time, or the earlier probe's for a row it kept. */
export function agentModelRowListedAt(
  listing: AgentModelCatalogListing | null,
  id: string
): number | undefined {
  return listing?.models.some((model) => model.id === id)
    ? (listing.keptAt?.[id] ?? listing.at)
    : undefined
}

function lastListedAt(
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null,
  id: string
): number {
  return Math.max(
    agentModelRowListedAt(discovered, id) ?? -Infinity,
    agentModelRowListedAt(live, id) ?? -Infinity
  )
}

/** A probe keeps the previous probe's other rows, each with its own age, until a day old (#46905). */
export function withKeptAgentModelRows(
  agent: string,
  listing: AgentModelCatalogListing,
  previous: AgentModelCatalogListing | null | undefined
): AgentModelCatalogListing {
  if (!keepsRicherAgentModelListing(agent) || !previous) {
    return listing
  }
  const keptAt: Record<string, number> = {}
  const kept = previous.models.flatMap((model) => {
    const at = agentModelRowListedAt(previous, model.id)!
    if (
      listing.models.some((row) => row.id === model.id) ||
      listing.at - at >= AGENT_MODEL_CATALOG_KEPT_ROW_MS
    ) {
      return []
    }
    keptAt[model.id] = at
    return [{ ...model, isDefault: false }]
  })
  return kept.length ? { ...listing, models: [...listing.models, ...kept], keptAt } : listing
}

/** The newer listing's rows, then the older listing's other rows shown within a day of it. */
export function keptAgentModelRows(
  agent: string,
  newer: AgentModelCatalogListing | null,
  older: AgentModelCatalogListing | null
): AgentSessionModelOption[] {
  const rows = newer?.models ?? []
  if (!keepsRicherAgentModelListing(agent) || !newer || !older) {
    return rows
  }
  return [
    ...rows,
    ...older.models.filter(
      (model) =>
        !rows.some((row) => row.id === model.id) &&
        newer.at - agentModelRowListedAt(older, model.id)! < AGENT_MODEL_CATALOG_KEPT_ROW_MS
    )
  ]
}

/** When a read must list again: a day after a shown row was last listed, or soon after a probe
 *  that lacked a shown row. Derived from the listings, so any later write keeps it. */
export function keptAgentModelRowsRelistAt(
  agent: string,
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null,
  rows: readonly AgentSessionModelOption[]
): number | undefined {
  if (!keepsRicherAgentModelListing(agent)) {
    return undefined
  }
  const newest = Math.max(discovered?.at ?? -Infinity, live?.at ?? -Infinity)
  let due = Infinity
  for (const { id } of rows) {
    const probed = agentModelRowListedAt(discovered, id)
    const last = lastListedAt(discovered, live, id)
    if (last < newest) {
      due = Math.min(due, last + AGENT_MODEL_CATALOG_KEPT_ROW_MS)
    }
    if (discovered && probed !== discovered.at) {
      due = Math.min(due, discovered.at + AGENT_MODEL_CATALOG_SHORT_LISTING_RELIST_MS)
    }
  }
  return Number.isFinite(due) ? due : undefined
}

/** The entry without carried rows no listing showed within a day of `now`: a listing that fails
 *  after that day must not leave them selectable. */
export function withoutExpiredKeptRows(
  entry: AgentModelCatalogEntry | null,
  now: number
): AgentModelCatalogEntry | null {
  if (!entry || entry.relistAfter === undefined || now < entry.relistAfter) {
    return entry
  }
  const { discovered, live } = entry
  const newest = Math.max(discovered?.at ?? -Infinity, live?.at ?? -Infinity)
  const models = entry.models.filter(({ id }) => {
    const last = lastListedAt(discovered, live, id)
    return last >= newest || now - last < AGENT_MODEL_CATALOG_KEPT_ROW_MS
  })
  return models.length === entry.models.length ? entry : { ...entry, models }
}

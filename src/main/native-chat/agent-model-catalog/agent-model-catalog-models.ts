import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { structuredModelEfforts } from '../../../shared/agent-session/options/model-catalog/structured-agent-session-discovered-model'
import type {
  AgentModelCatalogListing,
  AgentModelCatalogConfiguredDefault,
  AgentModelCatalogConfiguredChoice
} from './agent-model-catalog-entry'
import { usesModelSpecificAcpEfforts } from '../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'
import { agentModelRowListedAt, keptAgentModelRows } from './agent-model-catalog-kept-rows'

/** Newer listings own membership/menus; configured facts then discovery/live determine defaults. */
export function mergedAgentModelCatalogModels(
  agent: string,
  discovered: AgentModelCatalogListing | null,
  live: AgentModelCatalogListing | null,
  configured: AgentModelCatalogConfiguredDefault | null
): AgentSessionModelOption[] {
  const modelSpecificEfforts = usesModelSpecificAcpEfforts(agent)
  const liveIsNewer = live !== null && (discovered === null || live.at >= discovered.at)
  const newer = liveIsNewer ? live : discovered
  const older = liveIsNewer ? discovered : live
  return keptAgentModelRows(agent, newer, older).map((row) => {
    const listed = discovered?.models.find((entry) => entry.id === row.id)
    const reported = live?.models.find((entry) => entry.id === row.id)
    // Per row: a probe's kept copy is as old as the probe that listed it.
    const liveRowIsNewer =
      reported !== undefined &&
      (listed === undefined ||
        agentModelRowListedAt(live, row.id)! >= agentModelRowListedAt(discovered, row.id)!)
    const model = (liveRowIsNewer ? reported : listed) ?? row
    const olderModel = liveRowIsNewer ? listed : reported
    const olderEfforts = olderModel?.efforts ?? []
    const runsConfigured =
      configured?.modelId === model.id || configured?.sameModelIds?.includes(model.id) === true
    const configuredEffort = runsConfigured ? configured?.effort : undefined
    const offersConfigured = (menu: AgentSessionModelOption['efforts']): boolean =>
      menu.some((choice) => choice.value === configuredEffort)
    // Coarser probe menus must not discard a chat-confirmed effort unless a newer chat menu does.
    const keepsChatMenu =
      !liveRowIsNewer && !offersConfigured(model.efforts) && offersConfigured(olderEfforts)
    // Chat-only levels belong to the menu they came with.
    const {
      efforts: keptEfforts,
      effortsKnown,
      chatEfforts
    } = modelSpecificEfforts
      ? model.effortsKnown === false && olderModel
        ? olderModel
        : model
      : olderModel && model.effortsKnown !== olderModel.effortsKnown
        ? model.effortsKnown === false
          ? olderModel
          : model
        : structuredModelEfforts(model).length > 0 && !keepsChatMenu
          ? model
          : (olderModel ?? model)
    // An unobserved per-model menu is another model's; older builds saved such copies.
    const efforts = modelSpecificEfforts && effortsKnown === false ? [] : keptEfforts
    const defaultEffort = [configuredEffort, listed?.defaultEffort, reported?.defaultEffort].find(
      (effort) => effort !== undefined && efforts.some((choice) => choice.value === effort)
    )
    const observation = [model, olderModel].find(
      (row) => row?.declaredDefaultEffort !== undefined
    )?.declaredDefaultEffort
    const {
      defaultEffort: _own,
      declaredDefaultEffort: _declaration,
      effortsKnown: _known,
      chatEfforts: _newerChatEfforts,
      ...rest
    } = model
    return {
      ...rest,
      ...(chatEfforts && efforts === keptEfforts ? { chatEfforts } : {}),
      // Efforts stay unknown only when neither listing knows this model's menu.
      ...(effortsKnown === false ? { effortsKnown } : {}),
      // Without discovery/configuration, live flags are the only available default evidence.
      isDefault: configured
        ? model.id === configured.modelId
        : discovered
          ? listed?.isDefault === true
          : model.isDefault,
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      // A live menu reports Fast only for its current model; keep what the listing knew.
      ...(model.supportsFastMode === undefined && olderModel?.supportsFastMode !== undefined
        ? { supportsFastMode: olderModel.supportsFastMode }
        : {}),
      ...(model.defaultFastMode === undefined && olderModel?.defaultFastMode !== undefined
        ? { defaultFastMode: olderModel.defaultFastMode }
        : {}),
      ...(observation !== undefined
        ? {
            declaredDefaultEffort:
              observation !== null && efforts.some((choice) => choice.value === observation)
                ? observation
                : null
          }
        : {})
    }
  })
}

/** Only a fresh validated configured observation supplies declaration evidence. */
export function configuredDeclarationModels(
  models: AgentSessionModelOption[],
  choice: AgentModelCatalogConfiguredChoice | null | undefined
): AgentSessionModelOption[] {
  if (typeof choice?.effort !== 'string') {
    return models
  }
  let changed = false
  const observed = models.map((row) => {
    if (
      row.id !== choice.modelId &&
      row.resolvedModel !== choice.modelId &&
      !choice.sameModelIds?.includes(row.id)
    ) {
      return row
    }
    const declaredDefaultEffort =
      row.effortsKnown !== false && row.efforts.some((effort) => effort.value === choice.effort)
        ? choice.effort
        : null
    if (row.declaredDefaultEffort === declaredDefaultEffort) {
      return row
    }
    changed = true
    return { ...row, declaredDefaultEffort }
  })
  return changed ? observed : models
}

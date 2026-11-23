// Deleting a bot's automations from its Activity tab: one admission per row, the delete sent to the
// incarnation that listed it, then a hide until the host's next read stops listing it. Lives with the
// tab (not the Automations section, which an open item unmounts), so an outcome still lands.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import { deleteBotAutomation } from '../automations/hosts/automation-host-client'
import {
  AUTOMATION_HIDE_TTL_MS,
  hiddenAutomationIds,
  nextAutomationHideExpiry,
  pruneAutomationHides,
  type BotAutomationHide
} from './bot-automation-delete-hides'
import {
  botReadAuthorityKey,
  sameBotReadAuthority,
  type BotReadAuthority
} from './bot-read-authority'
import type { useBotActivityAuthorityRead } from './use-bot-activity'

/** What a Delete asked for, captured from the row as shown when it was asked. */
export type BotAutomationDeleteIntent = {
  botKey: string
  id: string
  name: string
  /** The incarnation whose read listed the row. */
  authority: BotReadAuthority
  /** It was asked from the folded list, which keeps it listed until the delete ends. */
  admittedAsTrouble: boolean
}

type DeleteOp = BotAutomationDeleteIntent & { opId: number; opKey: string; generation: number }

export type BotAutomationPending = { opId: number; admittedAsTrouble: boolean }

export type BotAutomationDeletion = {
  /** The current read's incarnation, null until a read lands. */
  authority: BotReadAuthority | null
  botKey: string
  /** Ids hidden under the current incarnation. */
  hidden: ReadonlySet<string>
  /** Ids being deleted under the current incarnation. */
  pending: ReadonlyMap<string, BotAutomationPending>
  /** Every operation not yet ended, whatever its incarnation. */
  pendingOpIds: ReadonlySet<number>
  offline: boolean
  /** Starts the delete; its operation id, or null when it can't start (offline, already deleting, stale). */
  admit: (intent: BotAutomationDeleteIntent) => number | null
}

type DeleteState = {
  key: string
  hides: readonly BotAutomationHide[]
  ops: ReadonlyMap<string, DeleteOp>
}

const NO_HIDES: readonly BotAutomationHide[] = []
const NO_OPS: ReadonlyMap<string, DeleteOp> = new Map()
let nextOpId = 0

export function useBotAutomationDelete(
  bot: BotRef,
  activity: ReturnType<typeof useBotActivityAuthorityRead>,
  offline: boolean
): BotAutomationDeletion {
  const t = useTranslate()
  const key = botRefKey(bot)
  const { read, refresh, refreshSettled } = activity
  const [stored, setState] = useState<DeleteState>({ key, hides: NO_HIDES, ops: NO_OPS })
  // Another bot's state is never shown, even before an effect resets it.
  const state =
    stored.key === key ? stored : { key, hides: NO_HIDES, ops: NO_OPS as typeof stored.ops }
  // Admission is synchronous: two Deletes in one tick admit one.
  const ops = useRef(new Map<string, DeleteOp>())
  const life = useRef({ key, generation: 0, mounted: false })
  const offlineNow = useRef(offline)
  const toldExpired = useRef(new WeakSet<BotAutomationHide>())
  const [tick, setTick] = useState(0)

  useLayoutEffect(() => {
    offlineNow.current = offline
  }, [offline])
  useLayoutEffect(() => {
    life.current = { key, generation: life.current.generation + 1, mounted: true }
    ops.current = new Map()
    return () => {
      life.current = { ...life.current, mounted: false }
    }
  }, [key])

  const update = (opKey: string, change: (state: DeleteState) => DeleteState): void =>
    setState((previous) =>
      change(previous.key === opKey ? previous : { key: opKey, hides: NO_HIDES, ops: NO_OPS })
    )
  const mirrorOps = (botKey: string): void => {
    const snapshot = new Map(ops.current)
    update(botKey, (previous) => ({ ...previous, ops: snapshot }))
  }

  const run = async (op: DeleteOp): Promise<void> => {
    const alive = (): boolean => life.current.mounted && life.current.generation === op.generation
    // Only this operation's own admission; a newer one for the same row stays.
    const release = (): void => {
      if (ops.current.get(op.opKey)?.opId === op.opId) {
        ops.current.delete(op.opKey)
        mirrorOps(op.botKey)
      }
    }
    try {
      if (op.authority.kind === 'environment-unavailable') {
        throw new Error('The automation list was read before its server finished pairing.')
      }
      await deleteBotAutomation(bot, op.id, op.authority)
      if (!alive()) {
        return
      }
      const authority = botReadAuthorityKey(op.authority)
      const hide: BotAutomationHide = {
        authority,
        id: op.id,
        name: op.name,
        expiresAt: Date.now() + AUTOMATION_HIDE_TTL_MS
      }
      update(op.botKey, (previous) => ({
        ...previous,
        hides: [...previous.hides.filter((h) => h.authority !== authority || h.id !== op.id), hide]
      }))
      refresh()
      release()
    } catch (error) {
      console.error('Failed to delete the automation:', error)
      if (!alive()) {
        return
      }
      // The host may have deleted it anyway: one read started after the failure decides.
      const settled = await refreshSettled()
      if (!alive()) {
        return
      }
      const gone =
        settled.ok &&
        sameBotReadAuthority(settled.value.authority, op.authority) &&
        !settled.value.activity.automations.some((row) => row.automation.id === op.id)
      if (!gone) {
        toast.error(
          t('bots.automations.deleteFailed', 'Couldn’t delete {{name}}', { name: op.name })
        )
      }
      release()
    }
  }

  const admit = (intent: BotAutomationDeleteIntent): number | null => {
    if (
      offlineNow.current ||
      !life.current.mounted ||
      intent.botKey !== life.current.key ||
      intent.botKey !== key
    ) {
      return null
    }
    const opKey = `${botReadAuthorityKey(intent.authority)}\u0000${intent.id}`
    if (ops.current.has(opKey)) {
      return null
    }
    const op: DeleteOp = { ...intent, opId: ++nextOpId, opKey, generation: life.current.generation }
    ops.current.set(opKey, op)
    mirrorOps(op.botKey)
    void run(op)
    return op.opId
  }

  // Each read prunes the hides it settles; one timer re-checks the soonest still listed.
  const hides = state.hides
  useEffect(() => {
    if (!read || hides.length === 0) {
      return
    }
    const listed = new Set(read.activity.automations.map((row) => row.automation.id))
    const { kept, expired } = pruneAutomationHides(hides, read.authority, listed, Date.now())
    for (const hide of expired) {
      if (!toldExpired.current.has(hide)) {
        toldExpired.current.add(hide)
        toast.error(
          t('bots.automations.deleteFailed', 'Couldn’t delete {{name}}', { name: hide.name })
        )
      }
    }
    if (kept !== hides) {
      setState((previous) => (previous.key === key ? { ...previous, hides: kept } : previous))
      return
    }
    const soonest = nextAutomationHideExpiry(kept)
    if (soonest === null) {
      return
    }
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, soonest - Date.now()))
    return () => clearTimeout(timer)
  }, [read, hides, key, tick, t])

  const authority = read?.authority ?? null
  const hidden = useMemo(() => hiddenAutomationIds(hides, authority), [hides, authority])
  const authorityKey = authority ? botReadAuthorityKey(authority) : null
  const { pending, pendingOpIds } = useMemo(() => {
    const byId = new Map<string, BotAutomationPending>()
    const ids = new Set<number>()
    for (const op of state.ops.values()) {
      ids.add(op.opId)
      if (botReadAuthorityKey(op.authority) === authorityKey) {
        byId.set(op.id, { opId: op.opId, admittedAsTrouble: op.admittedAsTrouble })
      }
    }
    return { pending: byId, pendingOpIds: ids }
  }, [state.ops, authorityKey])

  return { authority, botKey: key, hidden, pending, pendingOpIds, offline, admit }
}

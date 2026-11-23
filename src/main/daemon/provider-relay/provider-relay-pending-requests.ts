import type {
  ProviderRelayKeepSpec,
  ProviderRelayKeptLine,
  ProviderRelayOutstandingRequest,
  ProviderRelayRecord
} from '../protocol/daemon-provider-relay-protocol'
import { readProviderRelayKeepSpec } from './provider-relay-keep-spec'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseObject(line: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

function rpcId(value: unknown): string | null {
  return typeof value === 'number' || typeof value === 'string'
    ? `j:${JSON.stringify(value)}`
    : null
}

/** Past these the agent's output pauses until answers come in; a held request is never dropped. */
const MAX_PENDING_REQUESTS = 256
const MAX_PENDING_CHARS = 8 * 1024 * 1024
/** Codex resolves a server request elsewhere (another client, a timeout) and says so with this. */
const RESOLVED_METHOD = 'serverRequest/resolved'
/** JSON may escape the slash; the parsed method is the same. */
const RESOLVED_METHOD_ESCAPED = 'serverRequest\\/resolved'

/** Kept lines share the record's memory budget with held requests; past these one is dropped. */
const MAX_KEPT_LINE_CHARS = 1024 * 1024
const MAX_KEPT_CHARS = 2 * 1024 * 1024
/** Client requests awaited for keeping or listing; a client that never gets answers can't grow the map. */
const MAX_AWAITED_REQUESTS = 64

type AwaitedRequest = ProviderRelayOutstandingRequest & { keep: boolean; outstanding: boolean }

/** A client line longer than this is forwarded but not classified, so it can't grow without bound. */
const MAX_CLIENT_LINE_CHARS = 256 * 1024 * 1024
/** JSON may spell a key or method with escapes (`"m\u0065thod"`, `\u002f`); such lines take the slow path. */
const ESCAPED_LETTER = /\\u00[2-7][0-9a-fA-F]/

function mayHideKey(line: string): boolean {
  return line.includes('\\u00') && ESCAPED_LETTER.test(line)
}

/** A held request and the record it was when its answer was seen. */
type AnsweredRequest = { key: string; record: ProviderRelayRecord }

function controlId(value: unknown): string | null {
  return typeof value === 'string' ? `c:${value}` : null
}

/**
 * Agent→client requests still unanswered (JSON-RPC server requests, Claude `control_request`s),
 * kept apart from the spool so an ack of the spool never loses an approval the user still owes.
 * Lines are only parsed when a cheap substring test says they can be a request or its answer.
 */
export class ProviderRelayPendingRequests {
  private readonly pending = new Map<string, ProviderRelayRecord>()
  private pendingChars = 0
  private initializeKey: string | null = null
  private clientLinePartial = ''
  private skippingClientLine = false
  maxClientRequestId: number | null = null
  initializeResult: string | null = null
  private keep: ProviderRelayKeepSpec | null = null
  /** Client requests named by the keep spec, by key, until answered. */
  private readonly awaited = new Map<string, AwaitedRequest>()
  /** `a:<method>` or `l:<marker>` → the latest line for it. */
  private readonly kept = new Map<string, ProviderRelayRecord>()
  private keptChars = 0

  get size(): number {
    return this.pending.size
  }

  /** Insertion order is seq order: a re-sent id is removed before it is added again. */
  records(): ProviderRelayRecord[] {
    return [...this.pending.values()]
  }

  clear(): void {
    this.pending.clear()
    this.pendingChars = 0
    this.kept.clear()
    this.keptChars = 0
    this.awaited.clear()
  }

  /** What `relaySpawn` asked to keep for later attaches. */
  configureKeep(keep: unknown): void {
    this.keep = readProviderRelayKeepSpec(keep)
  }

  /** Kept lines in seq order, sent on attach before held requests. */
  keptRecords(): ProviderRelayRecord[] {
    return [...this.kept.values()].sort((a, b) => a.seq - b.seq)
  }

  /** Which kept seq answers to which name, and requests the agent still owes; empty ones are left out. */
  attachDetails(): {
    kept?: ProviderRelayKeptLine[]
    outstanding?: ProviderRelayOutstandingRequest[]
  } {
    const kept = [...this.kept].map(([name, record]) => ({ seq: record.seq, name }))
    const outstanding = [...this.awaited.values()]
      .filter((request) => request.outstanding)
      .map(({ id, method }) => ({ id, method }))
    return {
      ...(kept.length > 0 ? { kept } : {}),
      ...(outstanding.length > 0 ? { outstanding } : {})
    }
  }

  /** The agent owes an answer to a request that counts as work (an ACP prompt). */
  get working(): boolean {
    for (const request of this.awaited.values()) {
      if (request.outstanding) {
        return true
      }
    }
    return false
  }

  private keepLine(name: string, record: ProviderRelayRecord): void {
    const previous = this.kept.get(name)
    if (previous) {
      this.kept.delete(name)
      this.keptChars -= previous.line.length
    }
    // A line too large to keep drops the stale one: an older state is worse than none.
    if (
      record.line.length > MAX_KEPT_LINE_CHARS ||
      this.keptChars + record.line.length > MAX_KEPT_CHARS
    ) {
      return
    }
    this.kept.set(name, record)
    this.keptChars += record.line.length
  }

  private hold(key: string, record: ProviderRelayRecord): void {
    this.release(key)
    this.pending.set(key, record)
    this.pendingChars += record.line.length
  }

  /** The agent is owed this many answers that it should wait for before saying more. */
  get full(): boolean {
    return (
      this.pending.size >= MAX_PENDING_REQUESTS ||
      this.pendingChars + this.keptChars >= MAX_PENDING_CHARS
    )
  }

  private release(key: string): void {
    const held = this.pending.get(key)
    if (held) {
      this.pending.delete(key)
      this.pendingChars -= held.line.length
    }
  }

  observeAgentLine(record: ProviderRelayRecord): void {
    const { line } = record
    for (const marker of this.keep?.lines ?? []) {
      if (line.includes(marker)) {
        this.keepLine(`l:${marker}`, record)
      }
    }
    const maybeRpcRequest =
      line.includes('"method"') &&
      (line.includes('"id"') ||
        line.includes(RESOLVED_METHOD) ||
        line.includes(RESOLVED_METHOD_ESCAPED))
    const maybeControl = line.includes('control_')
    // Until the initialize answer is seen, any line shaped like an answer is parsed for it.
    const awaitingInitialize = this.initializeKey !== null && this.initializeResult === null
    const maybeAnswer =
      (awaitingInitialize || this.awaited.size > 0) &&
      (line.includes('"result"') || line.includes('"error"'))
    if (!maybeRpcRequest && !maybeControl && !maybeAnswer && !mayHideKey(line)) {
      return
    }
    const message = parseObject(line)
    if (!message) {
      return
    }
    if (message.method === RESOLVED_METHOD) {
      const key = isObject(message.params) ? rpcId(message.params.requestId) : null
      if (key) {
        this.release(key)
      }
      return
    }
    if (typeof message.method === 'string') {
      const key = rpcId(message.id)
      if (key) {
        this.hold(key, record)
      }
      return
    }
    if (message.type === 'control_request') {
      const key = controlId(message.request_id)
      if (key) {
        this.hold(key, record)
      }
      return
    }
    if (message.type === 'control_cancel_request') {
      const key = controlId(message.request_id)
      if (key) {
        this.release(key)
      }
      return
    }
    const answerKey = this.responseKey(message)
    if (awaitingInitialize && answerKey === this.initializeKey) {
      this.initializeResult = line
    }
    const awaited = answerKey === null ? undefined : this.awaited.get(answerKey)
    if (answerKey !== null && awaited !== undefined) {
      this.awaited.delete(answerKey)
      // Only a success is state worth restoring; a refused request leaves the last one standing.
      if (awaited.keep && 'result' in message) {
        this.keepLine(`a:${awaited.method}`, record)
      }
    }
  }

  /**
   * Client writes may split or join lines; only complete lines are classified. Returns the held
   * requests this data answers; the owner releases them once the data has reached the agent.
   */
  observeClientData(data: string): AnsweredRequest[] {
    const answered: AnsweredRequest[] = []
    let start = 0
    let newline = data.indexOf('\n')
    while (newline !== -1) {
      if (!this.skippingClientLine) {
        const key = this.observeClientLine(this.clientLinePartial + data.slice(start, newline))
        const record = key ? this.pending.get(key) : undefined
        if (key && record) {
          answered.push({ key, record })
        }
      }
      this.clientLinePartial = ''
      this.skippingClientLine = false
      start = newline + 1
      newline = data.indexOf('\n', start)
    }
    if (start < data.length && !this.skippingClientLine) {
      this.clientLinePartial += data.slice(start)
      if (this.clientLinePartial.length > MAX_CLIENT_LINE_CHARS) {
        this.clientLinePartial = ''
        this.skippingClientLine = true
      }
    }
    return answered
  }

  /** The answers reached the agent's stdin; a request re-sent under the same id since then stays held. */
  releaseAnswered(answered: AnsweredRequest[]): void {
    for (const { key, record } of answered) {
      if (this.pending.get(key) === record) {
        this.release(key)
      }
    }
  }

  private observeClientLine(line: string): string | null {
    if (!line.includes('"id"') && !line.includes('control_') && !mayHideKey(line)) {
      return null
    }
    const message = parseObject(line)
    if (!message) {
      return null
    }
    if (typeof message.method === 'string') {
      if (typeof message.id === 'number' && Number.isSafeInteger(message.id)) {
        this.maxClientRequestId = Math.max(this.maxClientRequestId ?? message.id, message.id)
      }
      if (message.method === 'initialize' && this.initializeKey === null) {
        this.initializeKey = rpcId(message.id)
      }
      this.await(message.id, message.method)
      return null
    }
    if (message.type === 'control_request') {
      const { request } = message
      if (isObject(request) && request.subtype === 'initialize' && this.initializeKey === null) {
        this.initializeKey = controlId(message.request_id)
      }
      return null
    }
    return this.responseKey(message)
  }

  private await(id: unknown, method: string): void {
    const key = rpcId(id)
    const keep = this.keep?.answers.includes(method) === true
    const outstanding = this.keep?.outstanding.includes(method) === true
    if (!key || (!keep && !outstanding) || (typeof id !== 'number' && typeof id !== 'string')) {
      return
    }
    if (this.awaited.size >= MAX_AWAITED_REQUESTS) {
      const oldest = this.awaited.keys().next().value
      if (oldest !== undefined) {
        this.awaited.delete(oldest)
      }
    }
    this.awaited.set(key, { id, method, keep, outstanding })
  }

  private responseKey(message: JsonObject): string | null {
    if (message.type === 'control_response') {
      const { response } = message
      return isObject(response) ? controlId(response.request_id) : null
    }
    return 'result' in message || 'error' in message ? rpcId(message.id) : null
  }
}

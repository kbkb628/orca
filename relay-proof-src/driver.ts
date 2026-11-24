// Drives the daemon relay RPCs directly: detach/reattach with replay, held request, no orphans, flat RSS/fds.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DaemonClient } from '../src/main/daemon/transport/client/daemon-client'
import { getDaemonSocketPath } from '../src/main/daemon/launch/daemon-spawner'

const repo = resolve(__dirname, '..')
const ownerExecutable = join(repo, 'native/provider-exec/.build', `${process.platform}-${process.arch}`, 'orca-provider-exec')
const marker = `RELAYPROOF${process.pid}`
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-proof-')))
const socketPath = getDaemonSocketPath(dir)
const tokenPath = join(dir, 'daemon.token')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const markerPids = () => {
  try { return execFileSync('pgrep', ['-f', marker]).toString().trim().split('\n').filter(Boolean).map(Number) } catch { return [] }
}
const rssKb = (pid: number) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim())
const fds = (pid: number) => process.platform === 'linux'
  ? readdirSync(`/proc/${pid}/fd`).length
  : execFileSync('lsof', ['-p', String(pid)]).toString().trim().split('\n').length - 1
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) process.exitCode = 1 }

function startDaemon(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(__dirname, 'daemon.cjs'), socketPath, tokenPath], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((ok) => child.stdout!.on('data', (d) => String(d).includes('ready') && ok(child)))
}

/** Reads the stream socket's binary frames itself, to see how relay lines travel on the wire. */
function tapFrames(socket: import('node:net').Socket) {
  const counts = { relayDataFrames: 0, relayJsonEvents: 0 }
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 5) {
      const kind = buffered[0]
      const body = buffered.readUInt32BE(1)
      if (buffered.length < 5 + body) break
      const frame = buffered.subarray(5, 5 + body)
      if (kind === 2) {
        const meta = JSON.parse(frame.toString('utf8', 2, 2 + frame.readUInt16BE(0)))
        if (meta.event === 'relayData') counts.relayDataFrames++
      } else if (kind === 1 && frame.includes('"event":"relayData"')) counts.relayJsonEvents++
      buffered = buffered.subarray(5 + body)
    }
  })
  return counts
}

async function connect() {
  const client = new DaemonClient({ socketPath, tokenPath })
  await client.ensureConnected()
  const events: { seq: number; line: string }[] = []
  const pending: { seq: number; line: string }[] = []
  const ackWanted: number[] = []
  let exit: unknown = null
  // After the hello the stream socket carries only binary frames (binary framing is negotiated by default).
  const frames = tapFrames((client as any).streamSocket)
  client.onEvent((e: any) => {
    if (e?.event === 'relayData') events.push(e.payload)
    if (e?.event === 'relayPending') pending.push(e.payload)
    if (e?.event === 'relayAckWanted') ackWanted.push(e.payload.seq)
    if (e?.event === 'relayExit') exit = e.payload
  })
  return { client, events, pending, ackWanted, frames, exit: () => exit }
}

async function main() {
  let daemon = await startDaemon()
  const c1 = await connect()
  check(c1.client.getDaemonIdentity()?.providerRelay === (process.platform !== 'win32'), 'hello advertises providerRelay')
  const before: any = await c1.client.request('listSessions', undefined)
  const listBefore: any = await c1.client.request('relayList', undefined)
  check(before.liveRelays === 0 && listBefore.relays.length === 0, 'no caller: live relay count and relay list read empty')

  const spawned: any = await c1.client.request('relaySpawn', {
    chatKey: 'proof-chat',
    spec: { command: process.execPath, args: [join(__dirname, 'agent.js'), marker], cwd: dir, ownerExecutable,
      env: { ...process.env, RELAY_PROOF_ENV: 'kept', ELECTRON_RUN_AS_NODE: '1' } as Record<string, string> }
  })
  check(typeof spawned.relayId === 'string', `relaySpawn -> ${JSON.stringify(spawned)}`)
  const { relayId } = spawned
  await c1.client.request('relayAttach', { relayId, fromSeq: 0 })
  await sleep(500)
  const hello = JSON.parse(c1.events.find((e) => e.line.includes('"hello"'))!.line).params
  const live = (await c1.client.request<any>('listSessions', undefined)).liveRelays
  check(live === 1, 'live count includes the relay (blocks idle/replace)')
  await c1.client.request('relayWrite', { relayId, data: JSON.stringify({ id: 7, method: 'tool', params: { seconds: 3 } }) + '\n' })
  await sleep(300)
  const ackedSeq = c1.events[c1.events.length - 1].seq
  await c1.client.request('relayAck', { relayId, seq: ackedSeq })
  c1.client.disconnect()
  console.log(`detached after seq ${ackedSeq}; agent pid ${hello.pid}, bg ${hello.bg}, sub ${hello.sub}`)

  await sleep(4_000)
  const spools = readdirSync(join(dir, 'chat-relay')).filter((n) => n.endsWith('.ndjson'))
  check(spools.length === 1, 'detached output spooled to chat-relay/<relayId>.ndjson')

  const c2 = await connect()
  const list: any = await c2.client.request('relayList', undefined)
  check(list.relays[0]?.pid === spawned.pid && list.relays[0].exit === null, 'relay still running, same pid, after client went away')
  const attach: any = await c2.client.request('relayAttach', { relayId, fromSeq: ackedSeq })
  await sleep(300)
  const seqs = c2.events.map((e) => e.seq)
  check(seqs[0] === ackedSeq + 1 && seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), `replay resumes at ${ackedSeq + 1} with no gap or duplicate (${seqs.length} lines)`)
  check(c2.events.some((e) => e.line.includes('"done"')), 'in-flight tool call (sleep 3; echo done) finished while detached and was replayed')
  check(attach.pending.length === 1 && c2.pending.some((p) => p.line.includes('perm-1') && p.seq === attach.pending[0]), 'held permission request re-delivered from the pending table')
  check(attach.maxClientRequestId === 7, 'highest client request id kept')
  check([hello.pid, hello.bg, hello.sub].every(alive), 'agent, background shell and subagent keep their PIDs')
  check(hello.env === 'kept' && hello.cwd === dir, 'cwd and env reached the agent')
  await c2.client.request('relayAck', { relayId, seq: seqs[seqs.length - 1] })
  c2.client.disconnect()

  const samples: string[] = []
  const first = { rss: rssKb(daemon.pid!), fds: fds(daemon.pid!) }
  const CYCLES = Number(process.env.RELAY_PROOF_CYCLES ?? 100)
  const rssAt: number[] = []
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const c = await connect()
    const r: any = await c.client.request('relayAttach', { relayId, fromSeq: (await c.client.request<any>('relayList', undefined)).relays[0].ackedSeq })
    await sleep(400)
    const last = c.events.at(-1)?.seq ?? r.replayThroughSeq
    await c.client.request('relayAck', { relayId, seq: last })
    c.client.disconnect()
    await sleep(200)
    rssAt[cycle] = rssKb(daemon.pid!)
    if (cycle % 10 === 0) samples.push(`${cycle}:${rssAt[cycle]}KB/${fds(daemon.pid!)}fd`)
  }
  const lastFds = fds(daemon.pid!)
  console.log(`daemon rss/fds every 10 cycles: start ${first.rss}KB/${first.fds}fd ${samples.join(' ')}`)
  // A leak keeps climbing; warm-up levels off. Medians of the windows ending each half damp allocator noise;
  // the second half may add at most 1% of the start.
  const median = (to: number) => rssAt.slice(to - 9, to + 1).sort((a, b) => a - b)[5]
  const half = Math.floor(CYCLES / 2)
  const secondHalfGrowth = median(CYCLES) - median(half)
  console.log(`rss growth: first half ${median(half) - first.rss}KB, second half ${secondHalfGrowth}KB`)
  if (process.env.RELAY_PROOF_RSS_TRACE) console.log(`rss trace: ${rssAt.slice(1).join(' ')}`)
  check(lastFds <= first.fds + 2 && secondHalfGrowth <= first.rss * 0.01, `${CYCLES} attach/detach cycles: daemon fds flat and RSS levels off`)

  const c3 = await connect()
  await c3.client.request('relayAttach', { relayId, fromSeq: (await c3.client.request<any>('relayList', undefined)).relays[0].ackedSeq })
  const lines = 20_000
  const t0 = performance.now()
  await c3.client.request('relayWrite', { relayId, data: JSON.stringify({ id: 8, method: 'flood', params: { lines } }) + '\n' })
  // Batched acks: ack only when the daemon asks (half its memory cap) or once a second.
  let acked = 0
  let lastAck = Date.now()
  let asked = 0
  let acks = 0
  while (!c3.events.some((e) => e.line.includes('"flooded"'))) {
    const last = c3.events.at(-1)?.seq ?? 0
    if (last > acked && (c3.ackWanted.length > asked || Date.now() - lastAck > 1000)) {
      asked = c3.ackWanted.length
      acked = last
      lastAck = Date.now()
      acks++
      c3.client.notify('relayAck', { relayId, seq: last })
    }
    await sleep(5)
  }
  const ms = performance.now() - t0
  console.log(`throughput: ${lines} x 1KB lines in ${ms.toFixed(0)} ms = ${((lines * 1.04) / 1024 / (ms / 1000)).toFixed(1)} MB/s with ${acks} acks, ${c3.ackWanted.length} relayAckWanted`)
  check(c3.ackWanted.length > 0 && acks < lines / 100, 'batched acks: the flood finished acking only on relayAckWanted or once a second')
  check(c3.frames.relayDataFrames >= lines && c3.frames.relayJsonEvents === 0, `relay lines arrive as raw binary DATA frames (${c3.frames.relayDataFrames} frames, ${c3.frames.relayJsonEvents} JSON events)`)

  // An image-sized prompt: over the 16 MiB control line limit, sent as 2M-char writes.
  const prompt = JSON.stringify({ id: 9, method: 'big', params: { data: 'y'.repeat(20 * 1024 * 1024) } }) + '\n'
  for (let at = 0; at < prompt.length; ) {
    const piece = prompt.slice(at, at + 2 * 1024 * 1024)
    try {
      await c3.client.request('relayWrite', { relayId, data: piece })
      at += piece.length
    } catch (error) {
      if (!String(error).includes('input is full')) throw error
      await sleep(20)
    }
    const last = c3.events.at(-1)?.seq ?? 0
    if (last > acked) { acked = last; c3.client.notify('relayAck', { relayId, seq: last }) }
  }
  const bigDeadline = Date.now() + 30_000
  while (Date.now() < bigDeadline && !c3.events.some((e) => e.line.includes('"length":20971520'))) await sleep(20)
  check(c3.events.some((e) => e.line.includes('"length":20971520')), 'a 20 MiB prompt in 2M-char relayWrite chunks reached the agent whole')
  c3.client.disconnect()

  const tree = [hello.pid, hello.bg, hello.sub, spawned.pid]
  console.log(`kill -9 daemon ${daemon.pid}; tree ${tree.join(',')}; marker pids before: ${markerPids().length}`)
  process.kill(daemon.pid!, 'SIGKILL')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && (tree.some(alive) || markerPids().length > 0)) await sleep(200)
  check(!tree.some(alive) && markerPids().length === 0, `no orphans after kill -9 of the daemon (${(15_000 - (deadline - Date.now())) / 1000}s)`)

  daemon = await startDaemon()
  const c4 = await connect()
  const again: any = await c4.client.request('relaySpawn', { chatKey: 'proof-2', spec: { command: '/bin/sh', args: ['-c', `sleep 60; : ${marker}`], cwd: dir, ownerExecutable, env: { PATH: process.env.PATH! } } })
  await sleep(300)
  check(!readdirSync(join(dir, 'chat-relay')).some((n) => spools.includes(n)), 'restarted daemon removed the dead daemon\'s spool')
  c4.client.disconnect()
  process.kill(daemon.pid!, 'SIGTERM')
  await sleep(6_000)
  check(!alive(again.pid) && markerPids().length === 0 && !existsSync(join(dir, 'chat-relay', `${again.relayId}.ndjson`)), 'daemon SIGTERM ends its relays and spools')
}

// A stuck step fails the proof instead of hanging it (and cleans up through the daemon's own exit).
setTimeout(() => { console.log('FAIL proof timed out after 5 minutes'); process.exit(1) }, 300_000).unref()
main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => setTimeout(() => process.exit(), 100))

// Fake chat agent: JSONL on stdio, a background shell, a subagent, a pending permission request.
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const marker = process.argv[2]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const bg = spawn('sh', ['-c', `sleep 300; : ${marker}`], { stdio: 'ignore' })
const sub = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', marker], { stdio: 'ignore' })
out({ method: 'hello', params: { pid: process.pid, bg: bg.pid, sub: sub.pid, cwd: process.cwd(), env: process.env.RELAY_PROOF_ENV } })
out({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { tool: 'rm -rf build' } })
let n = 0
setInterval(() => out({ method: 'tick', params: { n: n++ } }), 100)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'tool') {
    // In-flight tool call that finishes while no app is attached.
    const t = spawn('sh', ['-c', `sleep ${msg.params.seconds}; echo done`])
    let text = ''
    t.stdout.on('data', (d) => (text += d))
    t.on('exit', () => out({ id: msg.id, result: { output: text.trim() } }))
  } else if (msg.method === 'flood') {
    const line = 'x'.repeat(1000)
    let i = 0
    const pump = () => {
      while (i < msg.params.lines) {
        i++
        if (!process.stdout.write(JSON.stringify({ method: 'flood', params: { i, line } }) + '\n')) {
          return process.stdout.once('drain', pump)
        }
      }
      out({ id: msg.id, result: { flooded: i } })
    }
    pump()
  } else if (msg.method === 'big') {
    out({ id: msg.id, result: { length: msg.params.data.length } })
  } else if (msg.id !== undefined && msg.method) {
    out({ id: msg.id, result: { echo: msg.method } })
  }
})
process.stdin.on('end', () => process.exit(0))

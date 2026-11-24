import { startDaemon } from '../src/main/daemon/server/daemon-main'
const [socketPath, tokenPath] = process.argv.slice(2)
void startDaemon({
  socketPath,
  tokenPath,
  spawnSubprocess: () => {
    throw new Error('no PTYs in the relay proof')
  }
}).then((daemon) => {
  console.log('ready')
  console.error('daemon fd limit (ulimit -n inherited from daemon): ' + require('node:child_process').execSync('ulimit -n', { shell: '/bin/sh' }).toString().trim())
  process.on('SIGTERM', () => void daemon.shutdown().then(() => process.exit(0)))
})

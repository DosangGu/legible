/** Real child-process fixture. No vendor commands or GitHub requests are made. */
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startDaemon } from '../server.js'
import { ReadyCommandRunner } from './fixtures.js'

const directory = process.argv[2]!
const port = Number(process.argv[3])
const ready = new ReadyCommandRunner()
void startDaemon({
  version: 'test',
  stateDirectory: directory,
  port,
  runner: {
    async run(command, args) {
      if (command === 'git') await appendFile(join(directory, 'initializations'), 'preflight\n')
      return ready.run(command, args)
    },
  },
})
  .then((runtime) => {
    process.send?.({ ok: true, status: runtime.control!.status() })
    process.once(
      'SIGTERM',
      () =>
        void runtime.app.close().catch(() => {
          process.exitCode = 1
        }),
    )
    process.on('message', (message: unknown) => {
      if (message === 'fail-persistence')
        runtime.services.persistence.close = async () => {
          throw new Error('Fixture disk full')
        }
    })
  })
  .catch((error: NodeJS.ErrnoException) => {
    process.send?.({ ok: false, code: error.code ?? 'failed', message: error.message })
    process.exitCode = 1
    process.disconnect?.()
  })

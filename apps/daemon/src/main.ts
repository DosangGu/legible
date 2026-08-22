import { createRequire } from 'node:module'

import { startDaemon } from './server.js'

const require = createRequire(import.meta.url)
const daemonPackage = require('../package.json') as { version: string }

async function main(): Promise<void> {
  const runtime = await startDaemon({
    version: daemonPackage.version,
    repoPath: process.cwd(),
    logger: true,
  })
  let closing = false

  const close = async (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    runtime.app.log.info({ signal }, 'Shutting down daemon')

    try {
      await runtime.app.close()
    } catch (error) {
      runtime.app.log.error(error, 'Failed to shut down daemon')
      process.exitCode = 1
    }
  }

  process.once('SIGINT', () => void close('SIGINT'))
  process.once('SIGTERM', () => void close('SIGTERM'))
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

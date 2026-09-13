import { createRequire } from 'node:module'

import { startDaemon } from './server.js'
import { isLoopback } from './api/access.js'

const require = createRequire(import.meta.url)
const daemonPackage = require('../package.json') as { version: string }

async function main(): Promise<void> {
  const webOrigin = new URL(process.env.LEGIBLE_WEB_ORIGIN ?? 'http://127.0.0.1:7777')
  if (
    webOrigin.protocol !== 'http:' ||
    !isLoopback(webOrigin.hostname) ||
    webOrigin.username ||
    webOrigin.password ||
    webOrigin.pathname !== '/' ||
    webOrigin.search ||
    webOrigin.hash
  )
    throw new Error('LEGIBLE_WEB_ORIGIN must be a local HTTP origin')
  const runtime = await startDaemon({
    version: daemonPackage.version,
    logger: true,
  })
  // Deliberate terminal-only bootstrap handoff. Never include this token in structured logs.
  console.log(`Open Legible: ${webOrigin.origin}/#token=${runtime.access.bootstrapToken}`)
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

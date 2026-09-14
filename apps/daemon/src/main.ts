import { createRequire } from 'node:module'

import { startDaemon, validateWebOrigin } from './server.js'

const require = createRequire(import.meta.url)
const daemonPackage = require('../package.json') as { version: string }

async function main(): Promise<void> {
  const background = process.argv.includes('--internal-background')
  if (process.platform === 'win32')
    throw new Error('Use Legible inside WSL; native Windows is not supported yet')
  const webOrigin = validateWebOrigin(process.env.LEGIBLE_WEB_ORIGIN ?? 'http://127.0.0.1:7777')
  const starting = startDaemon({
    version: daemonPackage.version,
    logger: true,
    webOrigin,
  })
  let closing: Promise<void> | undefined
  const close = (signal: NodeJS.Signals) => {
    if (closing) return
    // Signals during recovery wait for the initializer while it still owns the port.
    closing = starting.then(
      async (runtime) => {
        runtime.app.log.info({ signal }, 'Shutting down daemon')
        try {
          await runtime.app.close()
        } catch (error) {
          runtime.app.log.error(error, 'Failed to shut down daemon')
          process.exitCode = 1
        }
      },
      () => undefined,
    )
  }

  process.once('SIGINT', () => void close('SIGINT'))
  process.once('SIGTERM', () => void close('SIGTERM'))
  const runtime = await starting
  if (closing) {
    await closing
    notifyParent({ type: 'failed', code: 'startup_interrupted' })
    return
  }
  // Deliberate terminal-only bootstrap handoff. Never include this token in structured logs.
  if (!background) console.log(`Open Legible: ${webOrigin}/#token=${runtime.access.bootstrapToken}`)
  notifyParent({ type: 'ready' })
}

function notifyParent(message: { type: string; code?: string; message?: string }): void {
  if (process.send && process.connected)
    process.send(message, () => {
      if (process.connected) process.disconnect()
    })
}

void main().catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  const message =
    code === 'EADDRINUSE'
      ? 'Port 7777 is already occupied. Use legible to attach, or legible stop before restarting.'
      : error instanceof Error
        ? error.message
        : 'Unable to start Legible'
  console.error(message)
  notifyParent({ type: 'failed', code: code ?? 'startup_failed', message })
  process.exitCode = 1
})

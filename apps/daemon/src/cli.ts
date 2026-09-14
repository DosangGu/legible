#!/usr/bin/env node
import { createRequire } from 'node:module'
import { defaultStateDirectory } from './common/state.js'
import { parseArguments } from './cli/arguments.js'
import { openBrowser } from './cli/browser.js'
import {
  assertCompatible,
  connectDaemon,
  daemonStatus,
  ensureDaemon,
  stopDaemon,
} from './cli/connection.js'
import { DaemonClient, runCommand } from './cli/run.js'

const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version

async function main(): Promise<void> {
  const command = parseArguments(process.argv.slice(2))
  if (command.kind === 'version') {
    console.log(version)
    return
  }
  if (command.kind === 'help') {
    console.log(`Usage:
  legible [--open|--no-open]            Start/attach and open the workspace
  legible pr <number> [--open|--no-open] Open a review from the current repo
  legible add <path>                   Register a checkout (no browser)
  legible status                      Show daemon status without starting it
  legible stop                        Stop an idle daemon

Local interactive runs open a browser. SSH and non-interactive runs print a URL.
Opening a PR never starts an agent. Native Windows: run inside WSL.`)
    return
  }
  if (process.platform === 'win32')
    throw new Error('Use Legible inside WSL; native Windows is not supported yet')
  const directory = defaultStateDirectory()
  await runCommand(command, {
    cwd: process.cwd(),
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    env: process.env,
    ensure: () => ensureDaemon(directory, version),
    status: () => daemonStatus(directory),
    connect: (status) => connectDaemon(directory, status),
    stop: (status) => {
      assertCompatible(status, version)
      return stopDaemon(directory, status)
    },
    client: (origin) => new DaemonClient(origin),
    open: openBrowser,
    output: (message) => console.log(message),
    warn: (message) => console.error(message),
  })
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Legible command failed')
  process.exitCode = 1
})

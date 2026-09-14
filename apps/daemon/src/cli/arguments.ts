export type CliCommand = {
  kind: 'open' | 'add' | 'pr' | 'status' | 'stop' | 'help' | 'version'
  path?: string
  prNumber?: number
  browser: 'auto' | 'open' | 'none'
}

export function parseArguments(args: string[]): CliCommand {
  let browser: CliCommand['browser'] = 'auto'
  const positional: string[] = []
  let literal = false
  for (const arg of args) {
    if (literal) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      literal = true
      continue
    }
    if (arg === '--help' || arg === '-h') return { kind: 'help', browser }
    if (arg === '--version' || arg === '-v') return { kind: 'version', browser }
    if (arg === '--open' || arg === '--no-open') {
      if (browser !== 'auto') throw new Error('Choose only one of --open and --no-open')
      browser = arg === '--open' ? 'open' : 'none'
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else positional.push(arg)
  }
  const [kind, value] = positional
  if (!kind) return { kind: 'open', browser }
  if (
    kind === 'pr' &&
    positional.length === 2 &&
    value &&
    /^[1-9]\d*$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  )
    return { kind, prNumber: Number(value), browser }
  if (kind === 'add' && positional.length === 2 && value && browser === 'auto')
    return { kind, path: value, browser }
  if ((kind === 'status' || kind === 'stop') && positional.length === 1 && browser === 'auto')
    return { kind, browser }
  throw new Error(
    'Usage: legible [--open|--no-open] | pr <number> [--open|--no-open] | add <path> | status | stop',
  )
}

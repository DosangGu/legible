import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export function defaultStateDirectory(): string {
  const configured = process.env.XDG_STATE_HOME
  return join(
    configured && isAbsolute(configured) ? configured : join(homedir(), '.local', 'state'),
    'legible',
  )
}

export async function writeState(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

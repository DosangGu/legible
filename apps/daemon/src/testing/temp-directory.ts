import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function createCanonicalTempDirectory(
  prefix: string,
  parent = tmpdir(),
): Promise<string> {
  return realpath(await mkdtemp(join(parent, prefix)))
}

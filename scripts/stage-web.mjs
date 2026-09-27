import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../apps/web/dist/', import.meta.url))
const target = fileURLToPath(new URL('../apps/daemon/dist/web/', import.meta.url))

if (!(await stat(join(web, 'index.html')).catch(() => undefined))?.isFile())
  throw new Error('Build the web workspace before staging the daemon package')

await mkdir(fileURLToPath(new URL('../apps/daemon/dist/', import.meta.url)), {
  recursive: true,
})
await rm(target, { recursive: true, force: true })
await cp(web, target, { recursive: true })
if (!(await stat(join(target, 'index.html')).catch(() => undefined))?.isFile())
  throw new Error('The staged package is missing the web entry point')

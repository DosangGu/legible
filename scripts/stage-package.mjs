import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const staging = join(root, 'dist', 'package')
const daemon = join(root, 'apps', 'daemon')
const protocol = join(root, 'packages', 'protocol')

async function requireFile(path) {
  if (!(await stat(path).catch(() => undefined))?.isFile())
    throw new Error(`Build Legible before packaging: missing ${path}`)
}

await Promise.all([
  requireFile(join(daemon, 'dist', 'cli.js')),
  requireFile(join(daemon, 'dist', 'main.js')),
  requireFile(join(daemon, 'dist', 'web', 'index.html')),
  requireFile(join(protocol, 'dist', 'index.js')),
])

const daemonManifest = JSON.parse(await readFile(join(daemon, 'package.json'), 'utf8'))
const protocolManifest = JSON.parse(await readFile(join(protocol, 'package.json'), 'utf8'))
await rm(staging, { recursive: true, force: true })
await mkdir(join(staging, 'node_modules', '@legible', 'protocol'), { recursive: true })
await cp(join(daemon, 'dist'), join(staging, 'dist'), { recursive: true })
await cp(join(protocol, 'dist'), join(staging, 'node_modules', '@legible', 'protocol', 'dist'), {
  recursive: true,
})
await cp(
  join(protocol, 'package.json'),
  join(staging, 'node_modules', '@legible', 'protocol', 'package.json'),
)
await cp(join(root, 'README.md'), join(staging, 'README.md'))
await writeFile(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: '@legible/legible',
      version: daemonManifest.version,
      private: true,
      type: 'module',
      engines: { node: '>=24' },
      bin: { legible: './dist/cli.js' },
      main: './dist/main.js',
      files: ['dist'],
      dependencies: {
        ...daemonManifest.dependencies,
        '@legible/protocol': protocolManifest.version,
      },
      bundledDependencies: ['@legible/protocol'],
    },
    null,
    2,
  )}\n`,
)

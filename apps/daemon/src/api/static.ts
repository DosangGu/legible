import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'

const contentTypes: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export function installWeb(app: FastifyInstance, directory: string): void {
  const index = async (_request: unknown, reply: FastifyReply) => {
    try {
      return reply
        .type('text/html')
        .header('Cache-Control', 'no-cache')
        .send(await readFile(resolve(directory, 'index.html')))
    } catch {
      return reply.code(503).send({
        error: {
          code: 'web_build_missing',
          message: 'Build the web app with npm run build, or use the Vite development URL.',
        },
      })
    }
  }
  app.get('/', index)
  app.get('/review/:sessionId', index)
  app.get('/repos/:owner/:name', index)
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const missing = () =>
      reply.code(404).send({ error: { code: 'not_found', message: 'Asset not found' } })
    const input = request.params['*']
    if (input.includes('\0') || input.includes('\\')) return missing()
    try {
      const root = await realpath(resolve(directory, 'assets'))
      const path = await realpath(resolve(root, input))
      const rel = relative(root, path)
      const type = contentTypes[extname(path)]
      if (
        !rel ||
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel) ||
        !type ||
        !(await stat(path)).isFile()
      )
        return missing()
      return reply
        .type(type)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(await readFile(path))
    } catch {
      return missing()
    }
  })
}

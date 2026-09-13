import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'

const cookieName = 'legible_session'

export class BrowserAccess {
  readonly bootstrapToken = randomBytes(32).toString('base64url')
  readonly #cookie = randomBytes(32).toString('base64url')

  install(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
      if (!validHost(request.headers.host) || !validOrigin(request)) {
        return reply.code(403).send({
          error: {
            code: 'origin_forbidden',
            message: 'Only same-origin local connections are accepted',
          },
        })
      }
      const pathname = request.url.split('?')[0] ?? ''
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        reply.header('Cache-Control', 'no-store')
        // Agent MCP credentials have no authority on browser APIs, and vice versa.
        if (request.routeOptions.url === '/api/sessions/:sessionId/mcp') return
        if (request.method === 'POST' && pathname === '/api/auth') return
        if (!this.#authenticated(request))
          return reply.code(401).send({
            error: {
              code: 'browser_auth_required',
              message: 'Open the connection URL printed by the daemon to reconnect',
            },
          })
      }
    })

    app.post<{ Body: { token?: unknown } }>(
      '/api/auth',
      { bodyLimit: 1024 },
      async (request, reply) => {
        if (!sameSecret(request.body?.token, this.bootstrapToken)) {
          return reply.code(401).send({
            error: {
              code: 'browser_auth_required',
              message: 'Invalid connection token. Use the current daemon URL.',
            },
          })
        }
        reply.header(
          'Set-Cookie',
          `${cookieName}=${this.#cookie}; HttpOnly; SameSite=Strict; Path=/api`,
        )
        return reply.code(204).send()
      },
    )
    app.get('/api/auth', async () => ({ authenticated: true }))
  }

  #authenticated(request: FastifyRequest): boolean {
    const cookies = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`))
    return (
      cookies.length === 1 && sameSecret(cookies[0]?.slice(cookieName.length + 1), this.#cookie)
    )
  }
}

export function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase())
}

function validHost(host: string | undefined): boolean {
  if (!host || /[\s/@\\?#]/u.test(host)) return false
  try {
    const url = new URL(`http://${host}`)
    return isLoopback(url.hostname) && url.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function validOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin
  const upgrade = request.headers.upgrade?.toLowerCase() === 'websocket'
  const mcp = request.routeOptions.url === '/api/sessions/:sessionId/mcp'
  if (!origin) return mcp || (!upgrade && ['GET', 'HEAD'].includes(request.method))
  return origin.toLowerCase() === `http://${request.headers.host?.toLowerCase()}`
}

function sameSecret(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || value.length !== expected.length) return false
  const bytes = Buffer.from(value)
  const secret = Buffer.from(expected)
  return bytes.length === secret.length && timingSafeEqual(bytes, secret)
}

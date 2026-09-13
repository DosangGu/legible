import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserAccess } from './access.js'

const apps: FastifyInstance[] = []
const local = { host: 'localhost', origin: 'http://localhost' }
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})
async function setup() {
  const app = Fastify()
  apps.push(app)
  const access = new BrowserAccess()
  access.install(app)
  await app.register(websocket)
  app.get('/api/repos', async () => [])
  app.post('/api/sessions', async () => ({ opened: true }))
  app.get('/api/events', { websocket: true }, (socket) => socket.send('ready'))
  app.post('/api/sessions/:sessionId/mcp', async (request, reply) =>
    request.headers.authorization === 'Bearer agent-only'
      ? { ok: true }
      : reply.code(401).send({ error: 'MCP token required' }),
  )
  await app.ready()
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth',
    headers: local,
    payload: { token: access.bootstrapToken },
  })
  const cookie = String(response.headers['set-cookie']).split(';')[0]!
  return { app, access, cookie, response }
}

describe('Browser access', () => {
  it('exchanges the bootstrap token for a separate HttpOnly cookie', async () => {
    const { app, access, cookie, response } = await setup()
    expect(response.statusCode).toBe(204)
    expect(response.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict; Path=/api')
    expect(cookie).not.toContain(access.bootstrapToken)
    expect(
      (await app.inject({ url: '/api/repos', headers: { ...local, cookie } })).statusCode,
    ).toBe(200)
    expect((await app.inject({ url: '/api/repos', headers: local })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions', headers: local, payload: {} }))
        .statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth',
          headers: local,
          payload: { token: 'wrong' },
        })
      ).statusCode,
    ).toBe(401)
  })

  it('rejects foreign, null, missing write origins and DNS-rebinding hosts', async () => {
    const { app, cookie, access } = await setup()
    for (const headers of [
      { ...local, origin: 'http://evil.test' },
      { ...local, origin: 'null' },
      { host: 'localhost' },
      { host: 'evil.test', origin: 'http://evil.test' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth',
        headers: { ...headers, cookie },
        payload: { token: access.bootstrapToken },
      })
      expect(response.statusCode).toBe(403)
    }
  })

  it('keeps browser and MCP credentials separate', async () => {
    const { app, cookie } = await setup()
    expect(
      (
        await app.inject({
          url: '/api/repos',
          headers: { ...local, authorization: 'Bearer agent-only' },
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/sessions/a/mcp',
          headers: { ...local, cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(401)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/sessions/a/mcp',
          headers: { host: 'localhost', authorization: 'Bearer agent-only' },
          payload: {},
        })
      ).statusCode,
    ).toBe(200)
  })

  it('rejects old cookies after a restart and requires auth for WebSocket upgrades', async () => {
    const first = await setup()
    const second = await setup()
    expect(
      (await second.app.inject({ url: '/api/repos', headers: { ...local, cookie: first.cookie } }))
        .statusCode,
    ).toBe(401)
    await expect(second.app.injectWS('/api/events', { headers: local })).rejects.toThrow()
    await expect(
      second.app.injectWS('/api/events', {
        headers: { ...local, cookie: second.cookie, origin: 'http://evil.test' },
      }),
    ).rejects.toThrow()
    const socket = await second.app.injectWS('/api/events', {
      headers: { ...local, cookie: second.cookie },
    })
    socket.close()
  })
})

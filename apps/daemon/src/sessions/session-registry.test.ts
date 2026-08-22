import type { DaemonEventEnvelope } from '@legible/protocol'
import { describe, expect, it } from 'vitest'

import { EventBus } from '../events/event-bus.js'
import { DuplicateSessionError, SessionNotFoundError, SessionRegistry } from './session-registry.js'
import { reviewSession } from '../testing/fixtures.js'

describe('SessionRegistry', () => {
  it('stores defensive copies and emits lifecycle events', () => {
    const events: DaemonEventEnvelope[] = []
    const bus = new EventBus()
    bus.subscribe((event) => events.push(event))
    const registry = new SessionRegistry(bus)
    const original = reviewSession()

    registry.add(original)
    original.comments.push({
      id: 'outside',
      path: 'src/index.ts',
      line: 1,
      side: 'RIGHT',
      body: 'outside mutation',
      origin: 'human',
      createdAt: '2026-08-21T00:00:00.000Z',
    })
    const fetched = registry.get(original.id)
    fetched?.comments.push(original.comments[0]!)

    expect(registry.get(original.id)?.comments).toEqual([])

    registry.replace(reviewSession({ prNumber: 43 }))
    expect(registry.list().map(({ prNumber }) => prNumber)).toEqual([43])
    expect(registry.remove(original.id)).toBe(true)
    expect(registry.remove(original.id)).toBe(false)
    expect(events.map(({ type }) => type)).toEqual([
      'session.added',
      'session.updated',
      'session.removed',
    ])
  })

  it('rejects duplicate additions and replacement of missing sessions', () => {
    const registry = new SessionRegistry(new EventBus())
    registry.add(reviewSession())

    expect(() => registry.add(reviewSession())).toThrow(DuplicateSessionError)
    expect(() => registry.replace(reviewSession({ id: 'missing' }))).toThrow(SessionNotFoundError)
  })
})

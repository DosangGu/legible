import type { DaemonEventEnvelope } from '@legible/protocol'
import { describe, expect, it, vi } from 'vitest'

import { EventBus } from './event-bus.js'

describe('EventBus', () => {
  it('publishes ordered envelopes and supports idempotent unsubscribe', () => {
    const events: DaemonEventEnvelope[] = []
    const bus = new EventBus({ now: () => new Date('2026-08-21T01:02:03.000Z') })
    const unsubscribe = bus.subscribe((event) => events.push(event))

    bus.publish({ type: 'session.removed', payload: { id: 'one' } })
    unsubscribe()
    unsubscribe()
    bus.publish({ type: 'session.removed', payload: { id: 'two' } })

    expect(events).toEqual([
      {
        type: 'session.removed',
        payload: { id: 'one' },
        sequence: 1,
        emittedAt: '2026-08-21T01:02:03.000Z',
      },
    ])
    expect(bus.sequence).toBe(2)
  })

  it('isolates a failing listener from other subscribers', () => {
    const onListenerError = vi.fn()
    const healthyListener = vi.fn()
    const bus = new EventBus({ onListenerError })
    bus.subscribe(() => {
      throw new Error('listener failed')
    })
    bus.subscribe(healthyListener)

    bus.publish({ type: 'session.removed', payload: { id: 'one' } })

    expect(onListenerError).toHaveBeenCalledOnce()
    expect(healthyListener).toHaveBeenCalledOnce()
  })
})

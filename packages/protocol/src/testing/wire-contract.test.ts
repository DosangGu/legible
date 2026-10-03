import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { wireFixtures } from './wire-fixtures.js'

describe('shared Rust and TypeScript wire contract', () => {
  it('keeps the JSON fixture equal to the type-checked current protocol payloads', () => {
    const shared: unknown = JSON.parse(
      readFileSync(new URL('../../fixtures/wire.json', import.meta.url), 'utf8'),
    )
    expect(shared).toEqual(wireFixtures)
  })
})

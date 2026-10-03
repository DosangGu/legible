import { writeFileSync } from 'node:fs'

import { wireFixtures } from './wire-fixtures.js'

writeFileSync(
  new URL('../../fixtures/wire.json', import.meta.url),
  JSON.stringify(wireFixtures, null, 2) + '\n',
)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConfig } from '../lib.mjs'

test('readConfig defaults keep today\'s two-way behaviour', () => {
  assert.deepEqual(readConfig({}), {
    folder: './shared',
    storage: './data/syncd',
    peerKey: '',
    push: true,
    atomic: false,
    wipeGuard: false,
    settleMs: 0,
    statusFile: null
  })
})

test('readConfig parses every switch', () => {
  const c = readConfig({ PUSH: '0', ATOMIC: '1', WIPE_GUARD: '1', SETTLE_MS: '10000', STATUS_FILE: '/tmp/s.json', PEER_KEY: 'ab' })
  assert.equal(c.push, false)
  assert.equal(c.atomic, true)
  assert.equal(c.wipeGuard, true)
  assert.equal(c.settleMs, 10000)
  assert.equal(c.statusFile, '/tmp/s.json')
  assert.equal(c.peerKey, 'ab')
})

test('readConfig turns an invalid SETTLE_MS into 0', () => {
  assert.equal(readConfig({ SETTLE_MS: 'x' }).settleMs, 0)
})

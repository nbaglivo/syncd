import assert from 'node:assert/strict'
import { test } from 'node:test'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { setTimeout as sleep } from 'node:timers/promises'
import { follow } from '../lib.mjs'
import { tmpDir } from './helpers.mjs'

test('a change that lands during the first pull triggers another pull', async () => {
  const store = new Corestore(await tmpDir())
  const drive = new Hyperdrive(store)
  await drive.ready()
  await drive.put('/a.mp3', Buffer.from('a'))
  let calls = 0
  const run = async () => {
    calls++
    if (calls === 1) await drive.put('/b.mp3', Buffer.from('b'))
  }
  const f = follow(drive, run)
  await sleep(500)
  assert.equal(calls, 2)
  f.stop()
  await f.done.catch(() => {})
  await store.close()
})

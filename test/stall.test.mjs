import assert from 'node:assert/strict'
import { test } from 'node:test'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { pull, openFolder, reclaim } from '../lib.mjs'
import { tmpDir } from './helpers.mjs'

test('a pull whose blob was cleared upstream fails as STALLED instead of hanging', async (t) => {
  const macStore = new Corestore(await tmpDir())
  const phoneStore = new Corestore(await tmpDir())
  t.after(async () => { await macStore.close(); await phoneStore.close() })
  const mac = new Hyperdrive(macStore)
  await mac.ready()
  await mac.put('/a.mp3', Buffer.alloc(200000, 1))
  const s1 = macStore.replicate(true)
  const s2 = phoneStore.replicate(false)
  s1.pipe(s2).pipe(s1)
  const phone = new Hyperdrive(phoneStore, mac.key)
  await phone.ready()
  await phone.update({ wait: true })
  const old = phone.version

  const before = mac.version
  await mac.put('/a.mp3', Buffer.alloc(200000, 2))
  await reclaim(mac, before)
  await phone.update({ wait: true })
  assert.ok(phone.version > old)

  const folder = openFolder(await tmpDir(), { atomic: true })
  const started = Date.now()
  await assert.rejects(
    pull({ drive: phone, version: old, folder, fromVersion: null, wipeGuard: true, stallMs: 1000 }),
    (err) => err.code === 'STALLED'
  )
  assert.ok(Date.now() - started < 5000)
})

test('a pull at the latest version is not cut short by the stall timer', async () => {
  const store = new Corestore(await tmpDir())
  const drive = new Hyperdrive(store)
  await drive.ready()
  await drive.put('/a.mp3', Buffer.alloc(2_000_000, 3))
  const folder = openFolder(await tmpDir(), { atomic: true })
  const r = await pull({ drive, folder, fromVersion: null, wipeGuard: true, stallMs: 1 })
  assert.equal(r.count.add, 1)
  await store.close()
})

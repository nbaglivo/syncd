import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createStatus } from '../lib.mjs'
import { tmpDir } from './helpers.mjs'

const read = async (file) => JSON.parse(await readFile(file, 'utf8'))

test('start writes syncing true and stop writes false', async () => {
  const file = join(await tmpDir(), 'state/status.json')
  const status = createStatus(file)
  await status.start()
  assert.equal((await read(file)).syncing, true)
  await status.stop()
  assert.equal((await read(file)).syncing, false)
})

test('progress rewrites the file only after the throttle', async () => {
  const file = join(await tmpDir(), 'status.json')
  let t = 1_000_000
  const status = createStatus(file, { throttleMs: 30000, now: () => t })
  await status.start()
  const first = (await read(file)).at
  t += 10_000
  await status.progress()
  assert.equal((await read(file)).at, first)
  t += 21_000
  await status.progress()
  const later = await read(file)
  assert.equal(later.syncing, true)
  assert.notEqual(later.at, first)
})

test('a null status file writes nothing', async () => {
  const dir = await tmpDir()
  const status = createStatus(null)
  await status.start()
  await status.progress()
  await status.stop()
  assert.deepEqual(await readdir(dir), [])
})

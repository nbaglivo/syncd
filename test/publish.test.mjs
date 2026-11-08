import assert from 'node:assert/strict'
import { test } from 'node:test'
import Hyperdrive from 'hyperdrive'
import { utimes, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { publish } from '../lib.mjs'
import { tmpStore, tmpFolder } from './helpers.mjs'

async function emptyDrive () {
  const { store } = await tmpStore()
  const drive = new Hyperdrive(store)
  await drive.ready()
  return drive
}

async function age (dir, name, seconds) {
  const t = new Date(Date.now() - seconds * 1000)
  await utimes(join(dir, name), t, t)
}

test('a file still being written is deferred, then published once settled', async () => {
  const { dir, drive: folder } = await tmpFolder({ 'new.mp3': 'partial' })
  const drive = await emptyDrive()
  const first = await publish({ folder, dir, drive, settleMs: 10000 })
  assert.equal(first.deferred, 1)
  assert.equal(await drive.entry('/new.mp3'), null)
  await age(dir, 'new.mp3', 20)
  const second = await publish({ folder, dir, drive, settleMs: 10000 })
  assert.equal(second.deferred, 0)
  assert.equal((await drive.get('/new.mp3')).toString(), 'partial')
})

test('a published file rewritten just now keeps its old content in the drive', async () => {
  const { dir, drive: folder } = await tmpFolder({ 'a.mp3': 'old' })
  await age(dir, 'a.mp3', 20)
  const drive = await emptyDrive()
  await publish({ folder, dir, drive, settleMs: 10000 })
  await writeFile(join(dir, 'a.mp3'), 'half-new')
  const r = await publish({ folder, dir, drive, settleMs: 10000 })
  assert.equal(r.deferred, 1)
  assert.equal((await drive.get('/a.mp3')).toString(), 'old')
})

test('settleMs 0 publishes at once', async () => {
  const { dir, drive: folder } = await tmpFolder({ 'a.mp3': 'a' })
  const drive = await emptyDrive()
  const r = await publish({ folder, dir, drive, settleMs: 0 })
  assert.equal(r.deferred, 0)
  assert.equal((await drive.get('/a.mp3')).toString(), 'a')
})

test('a deleted file is removed from the drive and its blob reclaimed', async () => {
  const { dir, drive: folder } = await tmpFolder({ 'a.mp3': 'aaaa', 'b.mp3': 'b' })
  const drive = await emptyDrive()
  await publish({ folder, dir, drive, settleMs: 0 })
  const blob = (await drive.entry('/a.mp3')).value.blob
  await rm(join(dir, 'a.mp3'))
  const r = await publish({ folder, dir, drive, settleMs: 0 })
  assert.equal(r.count.remove, 1)
  assert.equal(await drive.entry('/a.mp3'), null)
  const blobs = await drive.getBlobs()
  assert.equal(await blobs.core.has(blob.blockOffset), false)
})

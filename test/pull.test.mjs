import assert from 'node:assert/strict'
import { test } from 'node:test'
import Hyperdrive from 'hyperdrive'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openFolder, pull, removeStaleTmp, loadPulled, savePulled } from '../lib.mjs'
import { tmpStore, tmpFolder, tmpDir, listFiles } from './helpers.mjs'

const ARVO = 'Arvo Pärt — Spiegel "live".mp3'

async function macDrive (files) {
  const { store } = await tmpStore()
  const drive = new Hyperdrive(store)
  await drive.ready()
  for (const [k, v] of Object.entries(files)) await drive.put('/' + k, Buffer.from(v))
  return drive
}

async function blobOf (drive, key) {
  return (await drive.entry('/' + key)).value.blob
}

async function hasBlock (drive, blob) {
  const blobs = await drive.getBlobs()
  return blobs.core.has(blob.blockOffset)
}

test('a first full pull over existing test files is allowed and leaves exactly the drive files', async () => {
  const drive = await macDrive({ 'album/01 Intro.mp3': 'intro', [ARVO]: 'arvo' })
  const { dir } = await tmpFolder({ 'old.mp3': 'old' })
  const r = await pull({ drive, folder: openFolder(dir, { atomic: true }), fromVersion: null, wipeGuard: true })
  assert.equal(r.refused, false)
  assert.deepEqual(await listFiles(dir), ['album/01 Intro.mp3', ARVO].sort())
  assert.equal(r.version, drive.version)
})

test('an incremental pull applies one add, one change and one delete', async () => {
  const drive = await macDrive({ 'album/01 Intro.mp3': 'intro', [ARVO]: 'arvo' })
  const { dir } = await tmpFolder()
  const folder = openFolder(dir, { atomic: true })
  const { version } = await pull({ drive, folder, fromVersion: null, wipeGuard: true })
  await drive.put('/album/02.mp3', Buffer.from('two'))
  await drive.put('/album/01 Intro.mp3', Buffer.from('intro, re-encoded'))
  await drive.del('/' + ARVO)
  const r = await pull({ drive, folder, fromVersion: version, wipeGuard: true })
  assert.equal(r.count.add, 1)
  assert.equal(r.count.change, 1)
  assert.equal(r.count.remove, 1)
  assert.deepEqual(await listFiles(dir), ['album/01 Intro.mp3', 'album/02.mp3'])
  assert.equal(await readFile(join(dir, 'album/01 Intro.mp3'), 'utf8'), 'intro, re-encoded')
})

test('deleting every key under a folder removes those files', async () => {
  const drive = await macDrive({ 'album/a.mp3': 'a', 'album/b.mp3': 'b', 'keep.mp3': 'k' })
  const { dir } = await tmpFolder()
  const folder = openFolder(dir, { atomic: true })
  const { version } = await pull({ drive, folder, fromVersion: null, wipeGuard: true })
  await drive.del('/album/a.mp3')
  await drive.del('/album/b.mp3')
  await pull({ drive, folder, fromVersion: version, wipeGuard: true })
  assert.deepEqual(await listFiles(dir), ['keep.mp3'])
})

test('the wipe guard refuses a pull that would leave the folder empty', async () => {
  const drive = await macDrive({ 'a.mp3': 'a' })
  const { dir } = await tmpFolder()
  const folder = openFolder(dir, { atomic: true })
  const { version } = await pull({ drive, folder, fromVersion: null, wipeGuard: true })
  await drive.del('/a.mp3')
  const r = await pull({ drive, folder, fromVersion: version, wipeGuard: true })
  assert.equal(r.refused, true)
  assert.deepEqual(await listFiles(dir), ['a.mp3'])
  const full = await pull({ drive, folder, fromVersion: null, wipeGuard: true })
  assert.equal(full.refused, true)
  assert.deepEqual(await listFiles(dir), ['a.mp3'])
})

test('without the wipe guard an empty drive empties the folder', async () => {
  const drive = await macDrive({ 'a.mp3': 'a' })
  const { dir } = await tmpFolder()
  const folder = openFolder(dir, { atomic: true })
  const { version } = await pull({ drive, folder, fromVersion: null, wipeGuard: false })
  await drive.del('/a.mp3')
  const r = await pull({ drive, folder, fromVersion: version, wipeGuard: false })
  assert.equal(r.refused, false)
  assert.deepEqual(await listFiles(dir), [])
})

test('a pull reclaims the blobs of replaced and deleted files, and keeps current ones', async () => {
  const drive = await macDrive({ 'a.mp3': 'aaaa', 'b.mp3': 'bbbb', 'c.mp3': 'cccc' })
  const { dir } = await tmpFolder()
  const folder = openFolder(dir, { atomic: true })
  const { version } = await pull({ drive, folder, fromVersion: null, wipeGuard: true })
  const oldA = await blobOf(drive, 'a.mp3')
  const oldB = await blobOf(drive, 'b.mp3')
  const keptC = await blobOf(drive, 'c.mp3')
  await drive.put('/a.mp3', Buffer.from('new a'))
  await drive.del('/b.mp3')
  await pull({ drive, folder, fromVersion: version, wipeGuard: true })
  assert.equal(await hasBlock(drive, oldA), false)
  assert.equal(await hasBlock(drive, oldB), false)
  assert.equal(await hasBlock(drive, keptC), true)
  assert.equal(await hasBlock(drive, await blobOf(drive, 'a.mp3')), true)
})

test('an atomic pull writes a 5 MB file whole and leaves no tmp files', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 7)
  const drive = await macDrive({})
  await drive.put('/big.mp3', big)
  const { dir } = await tmpFolder()
  await pull({ drive, folder: openFolder(dir, { atomic: true }), fromVersion: null, wipeGuard: true })
  assert.equal((await stat(join(dir, 'big.mp3'))).size, big.length)
  assert.deepEqual(await listFiles(dir), ['big.mp3'])
})

test('removeStaleTmp deletes only localdrive tmp files', async () => {
  const dir = await tmpDir()
  await mkdir(join(dir, 'a'))
  await writeFile(join(dir, 'a/x.mp3.0.localdrive.tmp'), 'partial')
  await writeFile(join(dir, 'y.mp3'), 'y')
  assert.equal(await removeStaleTmp(dir), 1)
  assert.deepEqual(await listFiles(dir), ['y.mp3'])
})

test('pulled.json round-trips and ignores another drive key', async () => {
  const dir = await tmpDir()
  await savePulled(dir, 'aa', 7)
  assert.equal(await loadPulled(dir, 'aa'), 7)
  assert.equal(await loadPulled(dir, 'bb'), null)
  assert.equal(await loadPulled(await tmpDir(), 'aa'), null)
})

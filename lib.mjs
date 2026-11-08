import Localdrive from 'localdrive'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function readConfig (env) {
  const settleMs = Number.parseInt(env.SETTLE_MS ?? '0', 10)
  return {
    folder: env.FOLDER || './shared',
    storage: env.STORAGE || './data/syncd',
    peerKey: env.PEER_KEY || '',
    push: env.PUSH !== '0',
    atomic: env.ATOMIC === '1',
    wipeGuard: env.WIPE_GUARD === '1',
    settleMs: Number.isFinite(settleMs) && settleMs > 0 ? settleMs : 0,
    statusFile: env.STATUS_FILE || null
  }
}

export function log (...a) { console.log(new Date().toISOString(), ...a) }

export function openFolder (dir, { atomic }) {
  return new Localdrive(dir, { atomic })
}

export async function removeStaleTmp (dir) {
  let removed = 0
  async function walk (d) {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.endsWith('.localdrive.tmp')) {
        await rm(p, { force: true })
        removed++
      }
    }
  }
  await walk(dir)
  return removed
}

async function changedKeys (drive, fromVersion) {
  const keys = new Set()
  for await (const { left, right } of drive.diff(fromVersion, '/')) {
    const key = (left || right).key
    keys.add(key)
  }
  return [...keys]
}

export async function reclaim (drive, fromVersion) {
  if (!fromVersion) return 0
  const blobs = await drive.getBlobs()
  let cleared = 0
  for await (const { left, right } of drive.diff(fromVersion, '/')) {
    const old = right?.value?.blob
    if (!old) continue
    const now = left?.value?.blob
    if (now && now.blockOffset === old.blockOffset && now.byteOffset === old.byteOffset) continue
    await blobs.clear(old)
    cleared++
  }
  return cleared
}

async function countFiles (folder) {
  let n = 0
  for await (const _ of folder.list('/')) n++
  return n
}

export async function pull ({ drive, folder, fromVersion, wipeGuard, onDownload }) {
  await drive.ready()
  const snap = drive.checkout(drive.version)
  await snap.ready()
  const version = snap.version
  const blobs = await drive.getBlobs()
  const ondownload = () => onDownload?.()
  if (onDownload && blobs) blobs.core.on('download', ondownload)
  try {
    let opts = {}
    if (fromVersion !== null) {
      const keys = []
      for (const key of await changedKeys(snap, fromVersion)) {
        if ((await snap.entry(key)) || (await folder.entry(key))) keys.push(key)
      }
      if (keys.length === 0) return { version, count: { add: 0, change: 0, remove: 0 }, refused: false }
      opts = { entries: keys }
    }
    if (wipeGuard) {
      const files = await countFiles(folder)
      const dry = snap.mirror(folder, { ...opts, dryRun: true })
      await dry.done()
      if (files > 0 && files - dry.count.remove + dry.count.add === 0) {
        log(`pull refused: would leave ${folder.root} empty`)
        return { version, count: { add: 0, change: 0, remove: 0 }, refused: true }
      }
    }
    const m = snap.mirror(folder, opts)
    await m.done()
    await reclaim(snap, fromVersion ?? 0)
    const { add, change, remove } = m.count
    return { version, count: { add, change, remove }, refused: false }
  } finally {
    if (onDownload && blobs) blobs.core.off('download', ondownload)
    await snap.close()
  }
}

export async function loadPulled (storage, key) {
  try {
    const data = JSON.parse(await readFile(join(storage, 'pulled.json'), 'utf8'))
    return data.key === key && Number.isInteger(data.version) ? data.version : null
  } catch {
    return null
  }
}

export async function savePulled (storage, key, version) {
  await writeAtomic(join(storage, 'pulled.json'), JSON.stringify({ key, version }) + '\n')
}

async function writeAtomic (file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}

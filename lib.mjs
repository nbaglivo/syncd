import Localdrive from 'localdrive'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
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

// A pull mirrors one snapshot. If the publisher has moved on and cleared the
// blocks that snapshot still needs, nobody can serve them and reads wait
// forever: after `stallMs` without a downloaded block while the drive is ahead
// of the snapshot, give up with code STALLED (the caller restarts the pull).
export async function pull ({ drive, version: at, folder, fromVersion, wipeGuard, onDownload, stallMs = 60000 }) {
  await drive.ready()
  const snap = drive.checkout(at ?? drive.version)
  await snap.ready()
  const version = snap.version
  const blobs = await drive.getBlobs()
  let last = Date.now()
  const ondownload = () => {
    last = Date.now()
    onDownload?.()
  }
  drive.core.on('download', ondownload)
  blobs?.core.on('download', ondownload)
  let timer
  const stalled = new Promise((resolve, reject) => {
    timer = setInterval(() => {
      if (drive.version > version && Date.now() - last > stallMs) {
        const err = new Error(`pull stalled: no data for ${Math.round(stallMs / 1000)} s and the drive moved past version ${version}`)
        err.code = 'STALLED'
        reject(err)
      }
    }, Math.max(10, Math.min(1000, stallMs / 4)))
  })
  let ok = false
  try {
    const r = await Promise.race([mirrorSnapshot({ snap, version, folder, fromVersion, wipeGuard }), stalled])
    ok = true
    return r
  } finally {
    clearInterval(timer)
    drive.core.off('download', ondownload)
    blobs?.core.off('download', ondownload)
    if (ok) await snap.close()
    else snap.close().catch(() => {})
  }
}

async function mirrorSnapshot ({ snap, version, folder, fromVersion, wipeGuard }) {
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

// Decides which files a publish looks at. Unsettled files (modified less than
// settleMs ago) wait. Files whose size and mtime match what the last publish
// saw (`seen`) are skipped: comparing them would read the whole file and its
// copy in the drive, i.e. the whole library on every change.
export function settledFilter (dir, settleMs, now, seen = null) {
  const deferred = new Set()
  const skipped = new Set()
  const pending = new Map()
  const filter = (key) => {
    let st
    try {
      st = statSync(join(dir, key))
    } catch {
      return true
    }
    if (!st.isFile()) return true
    if (settleMs && st.mtimeMs > now - settleMs) {
      deferred.add(key)
      return false
    }
    const sig = `${st.size}:${st.mtimeMs}`
    if (seen && seen.get(key) === sig) {
      skipped.add(key)
      return false
    }
    pending.set(key, sig)
    return true
  }
  return { filter, deferred: () => deferred.size, skipped: () => skipped.size, pending }
}

export async function publish ({ folder, dir, drive, settleMs, now = Date.now(), seen = null }) {
  await drive.ready()
  const before = drive.version
  const { filter, deferred, skipped, pending } = settledFilter(dir, settleMs, now, seen)
  const m = folder.mirror(drive, { filter })
  const removed = []
  try {
    for await (const op of m) if (op.op === 'remove') removed.push(op.key)
  } finally {
    await reclaim(drive, before)
  }
  if (seen) {
    for (const [key, sig] of pending) seen.set(key, sig)
    for (const key of removed) seen.delete(key)
  }
  const { add, change, remove } = m.count
  return { count: { add, change, remove }, deferred: deferred(), skipped: skipped() }
}

export function createStatus (file, { throttleMs = 30000, now = Date.now } = {}) {
  let lastWrite = -Infinity
  let writing = Promise.resolve()
  const write = (syncing) => {
    const t = now()
    lastWrite = t
    writing = writing
      .then(() => writeAtomic(file, JSON.stringify({ syncing, at: new Date(t).toISOString() }) + '\n'))
      .catch((err) => log('status file:', err.message))
    return writing
  }
  if (!file) return { start: async () => {}, progress: async () => {}, stop: async () => {} }
  return {
    start: () => write(true),
    progress: () => (now() - lastWrite >= throttleMs ? write(true) : writing),
    stop: () => write(false)
  }
}

// Pull now and whenever the drive advances. The watcher is created first: it
// only reports versions newer than when it was opened, so one opened after a
// long first pull would miss what arrived during it.
export function follow (drive, run) {
  const watcher = drive.watch('/')
  const done = (async () => {
    await run()
    for await (const _ of watcher) await run()
  })()
  return { done, stop: () => watcher.destroy() }
}

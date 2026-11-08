import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import debounce from 'debounceify'
import b4a from 'b4a'
import fs from 'fs'
import {
  readConfig, log, openFolder, removeStaleTmp, publish, pull,
  loadPulled, savePulled, createStatus
} from './lib.mjs'

// ---- config (set via env, see README) ----
const config   = readConfig(process.env)
const FOLDER   = config.folder
const STORAGE  = config.storage
const PEER_KEY = config.peerKey      // the OTHER machine's drive key (hex)

process.on('unhandledRejection', err => {
  log('fatal:', err?.stack ?? err)
  process.exit(1)
})

if (!config.push && !PEER_KEY) {
  log('nothing to do: PUSH=0 and no PEER_KEY')
  process.exit(1)
}

fs.mkdirSync(FOLDER, { recursive: true })
if (config.atomic) {
  const n = await removeStaleTmp(FOLDER)
  if (n) log('removed', n, 'stale tmp files')
}
const status = createStatus(config.statusFile)
await status.stop()

const store  = new Corestore(STORAGE)
const folder = openFolder(FOLDER, { atomic: config.atomic })

const swarm = new Hyperswarm()
swarm.on('connection', (socket, info) => {
  const id = b4a.toString(info.publicKey, 'hex').slice(0, 8)
  log('peer connected', id)
  socket.on('close', () => log('peer disconnected', id))
  socket.on('error', err => log('peer error', id, err.message))
  store.replicate(socket)
})

// my outbox — a drive I write to. Namespacing keeps its key stable across
// restarts as long as STORAGE persists, so PEER_KEY stays valid forever.
let mine = null
if (config.push) {
  mine = new Hyperdrive(store.namespace('mine'))
  await mine.ready()
  swarm.join(mine.discoveryKey, { server: true, client: true })   // seed my drive
}

// push: local folder -> my drive (files still being written wait SETTLE_MS)
let settleTimer = null
const push = debounce(async () => {
  try {
    const r = await publish({ folder, dir: FOLDER, drive: mine, settleMs: config.settleMs })
    if (changed(r.count)) log(`push +${r.count.add} ~${r.count.change} -${r.count.remove}`)
    if (r.deferred) {
      log('push deferred', r.deferred, 'unsettled files')
      clearTimeout(settleTimer)
      settleTimer = setTimeout(() => push(), config.settleMs)
    }
  } catch (err) {
    log('push failed:', err.message)
  }
})

if (PEER_KEY) {
  const theirs = new Hyperdrive(store, b4a.from(PEER_KEY, 'hex'))
  await theirs.ready()
  const keyHex = b4a.toString(theirs.key, 'hex')
  let fromVersion = await loadPulled(STORAGE, keyHex)

  const done = theirs.findingPeers()
  swarm.join(theirs.discoveryKey, { server: true, client: true })
  swarm.flush().then(done, done)

  // pull: their drive -> local folder, only what changed since the last pull
  const runPull = debounce(async () => {
    try {
      await status.start()
      const r = await pull({
        drive: theirs,
        folder,
        fromVersion,
        wipeGuard: config.wipeGuard,
        onDownload: () => status.progress()
      })
      if (!r.refused) {
        fromVersion = r.version
        await savePulled(STORAGE, keyHex, r.version)
      }
      if (changed(r.count)) log(`pull +${r.count.add} ~${r.count.change} -${r.count.remove}`)
    } catch (err) {
      log('pull failed:', err.message)
    } finally {
      await status.stop()
    }
  })

  await theirs.update()
  await runPull()
  // keep pulling forever whenever their drive advances
  ;(async () => { for await (const _ of theirs.watch('/')) await runPull() })()
    .catch(err => log('watch failed:', err.message))
} else {
  await swarm.flush()
}

if (mine) {
  await push()                                         // initial push
  fs.watch(FOLDER, { recursive: true }, () => push())  // keep pushing on change
}

log('syncd up · folder=' + FOLDER + (mine ? '' : ' · pull only'))
if (mine) {
  console.log('MY DRIVE KEY (paste into the other machine\'s PEER_KEY):')
  console.log(mine.key.toString('hex'))
}

function changed (c) { return c.add || c.remove || c.change }

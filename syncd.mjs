import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import Localdrive from 'localdrive'
import debounce from 'debounceify'
import b4a from 'b4a'
import fs from 'fs'

// ---- config (set via env) ----
const FOLDER   = process.env.FOLDER   || './shared'
const STORAGE  = process.env.STORAGE  || './data/syncd'
const PEER_KEY = process.env.PEER_KEY || ''      // the OTHER machine's drive key (hex)

const store  = new Corestore(STORAGE)
const folder = new Localdrive(FOLDER)

// my outbox — a drive I write to. Namespacing keeps its key stable across
// restarts as long as STORAGE persists, so PEER_KEY stays valid forever.
const mine = new Hyperdrive(store.namespace('mine'))
await mine.ready()

const swarm = new Hyperswarm()
swarm.on('connection', socket => store.replicate(socket))
swarm.join(mine.discoveryKey, { server: true, client: true })   // seed my drive

// push: local folder -> my drive
const push = debounce(async () => {
  const m = folder.mirror(mine)
  await m.done()
  if (changed(m)) log('push', m.count)
})

if (PEER_KEY) {
  const theirs = new Hyperdrive(store, b4a.from(PEER_KEY, 'hex'))
  await theirs.ready()

  const done = theirs.findingPeers()
  swarm.join(theirs.discoveryKey, { server: true, client: true })
  swarm.flush().then(done, done)

  // pull: their drive -> local folder
  const pull = debounce(async () => {
    const m = theirs.mirror(folder)
    await m.done()
    if (changed(m)) log('pull', m.count)
  })

  await theirs.update()
  await pull()
  // keep pulling forever whenever their drive advances
  ;(async () => { for await (const _ of theirs.watch('/')) await pull() })()
} else {
  await swarm.flush()
}

await push()                                       // initial push
fs.watch(FOLDER, { recursive: true }, () => push())  // keep pushing on change

log('syncd up · folder=' + FOLDER)
console.log('MY DRIVE KEY (paste into the other machine\'s PEER_KEY):')
console.log(mine.key.toString('hex'))

function changed (m) { return m.count.add || m.count.remove || m.count.change }
function log (...a) { console.log(new Date().toISOString(), ...a) }


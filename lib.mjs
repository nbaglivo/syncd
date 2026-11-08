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

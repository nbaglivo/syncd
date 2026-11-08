# syncd

Two-way folder sync between two machines with no servers, just P2P. How cool is that?

## Usage

```sh
FOLDER=./shared STORAGE=./data/syncd node syncd.mjs
```

On first run (no `PEER_KEY`) it prints its own drive key:

```
MY DRIVE KEY (paste into the other machine's PEER_KEY):
<hex key>
```

Give that key to the other machine as its `PEER_KEY`, and get its key in
return for this machine's `PEER_KEY`. Then run on both sides:

```sh
FOLDER=./shared STORAGE=./data/syncd PEER_KEY=<their hex key> node syncd.mjs
```

## Env vars

- `FOLDER` — local folder to sync (default `./shared`)
- `STORAGE` — corestore storage path (default `./data/syncd`)
- `PEER_KEY` — the other machine's drive key, hex-encoded (empty until you
  have it)

Changes to `FOLDER` are pushed automatically; changes to the peer's drive are
pulled automatically. Keep `STORAGE` persistent across restarts so your drive
key doesn't change.

## One-way mode

To mirror one machine's folder onto another (publisher → receiver), with
nothing flowing back:

- **Publisher:** run without `PEER_KEY`. It only publishes its folder.
- **Receiver:** run with the publisher's key and `PUSH=0 ATOMIC=1 WIPE_GUARD=1`.
  It only pulls, and deletes what the publisher deleted.

```sh
# publisher
FOLDER=~/Phone/Music STORAGE=./data/syncd SETTLE_MS=10000 node syncd.mjs
# receiver
FOLDER=~/Music STORAGE=./data/syncd PEER_KEY=<publisher key> \
  PUSH=0 ATOMIC=1 WIPE_GUARD=1 STATUS_FILE=./status.json node syncd.mjs
```

## Switches (all off by default)

- `PUSH=0` — don't publish this folder (no own drive, no key printed). Needs
  `PEER_KEY`.
- `ATOMIC=1` — write pulled files under `<name>.N.localdrive.tmp` and rename
  them when complete; leftover tmp files are removed at start.
- `WIPE_GUARD=1` — refuse a pull that would leave the folder with no files
  (e.g. the publisher's folder is empty or missing). Logged as `pull refused`.
- `SETTLE_MS=<ms>` — don't publish a file modified less than this long ago;
  it is published once it stops changing.
- `STATUS_FILE=<path>` — write `{"syncing": true|false, "at": ISO}` around
  every pull, refreshed at most every 30 s while blocks are downloading.

Pulls are incremental: the receiver remembers the last version it mirrored in
`STORAGE/pulled.json` and only looks at keys changed since. Deleted and
replaced files have their old blocks cleared on both sides, so storage
doesn't grow with history; each side still keeps one copy of the current
files in `STORAGE` on top of the folder itself.

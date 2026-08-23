# syncd

Two-way folder sync between two machines over Hyperswarm, using a Hyperdrive
per machine as the replicated store.

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

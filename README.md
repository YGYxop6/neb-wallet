# NEB web wallet

A non-custodial wallet for the NEB chain that runs in the browser. Keys are
created and encrypted on the device, transactions are signed locally, and the
server only answers two questions: *what does this address hold* and *please
relay this already signed transaction*.

```
browser                                    argonpool.com
├ key generated with the platform CSPRNG    ├ /wallet/         static files, no session
├ sealed with PBKDF2-SHA256 + AES-GCM       ├ /api/wallet/a/   read-only index (SQLite)
├ kept in localStorage, never uploaded      ├ /api/wallet/tx/  read-only lookup
├ transaction signed locally                └ /api/wallet/broadcast  relay + rate limit
└ only signed bytes leave the page
```

A compromised server cannot move coins: no interface accepts a private key, and
a signed transaction cannot be altered without invalidating the signature. The
residual risk is a tampered bundle, which is why the build is reproducible and
the page prints the SHA-256 of the script it is running.

## What it does

- create a wallet (32 byte Ed25519 secret) or import the 64 hex key that
  `neb-wallet` exports
- password encryption with PBKDF2-SHA256 (600k) and AES-GCM-256
- receive (address + QR), send (coin selection, change, fee), history
- watch-only mode: balance and history for any address, no key, no sending
- auto-lock after five idle minutes, on tab hide, or on demand
- Chinese and English

## How the chain is spoken

| piece | rule |
|---|---|
| key | Ed25519 |
| address | bech32m of `BLAKE3(public key)`, prefix `neb` |
| txid | `BLAKE3("txid" ‖ encoding without witnesses)`, coinbase commits its witness |
| signature | `BLAKE3("sighash" ‖ chain id ‖ txid ‖ input index ‖ spent amount ‖ spent lock)` |
| varint | Bitcoin **CompactSize**, not LEB128 |
| coinbase | spendable after 100 blocks |

The varint detail matters: `neb-work` uses CompactSize, so an encoder written
from the prose spec as LEB128 looks correct until a transaction carries more
than 252 inputs or outputs — which is exactly what coin consolidation does.

## Build

```sh
npm ci
npm run build          # dist/app.js + dist/index.html, prints the SHA-256
npm test               # vectors captured from the reference implementation
npm run test:payment   # coin selection and signing
```

`npm test` checks the address, txid, sighash and signature against values taken
from `neb-wallet` and from a Rust program built against `neb-chain::tx`. Both
must match byte for byte, so the browser copy cannot drift from consensus.

## Verify the deployment

The page shows the hash of the script it is executing, computed in the browser
from the bytes it just downloaded:

```
代码指纹 8796aca3d7ce8741…
```

Compare it with `sha256sum dist/app.js` after a clean `npm run build`. If they
differ, the server is serving something the source does not produce — stop and
do not type a password.

## Indexer

The node indexes blocks by hash and has no address index (`neb-wallet balance`
rescans the chain on every call). `indexer/indexer.py` walks the chain once and
keeps `lock → unspent outputs` in SQLite. It is read-only, listens on
127.0.0.1, and never sees a key.

```sh
python3 indexer/indexer.py --db index.db --port 8083
```

## Licence

MIT.

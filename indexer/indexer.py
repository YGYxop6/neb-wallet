"""Read-only address index for NEB, so a browser wallet can ask for its coins.

The node indexes blocks by hash and knows nothing about addresses; `neb-wallet
balance` scans the whole chain every time. This service walks the chain once,
keeps `lock -> unspent outputs` in SQLite, and answers three questions over
HTTP: what an address holds, what a transaction was, and may I relay this
signed transaction.

It never sees a private key and never needs the wallet password: everything it
handles is already public chain data, plus a signed transaction the browser
sends for relaying.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import threading
from contextlib import closing
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

RPC = os.environ.get("NEB_RPC", "http://127.0.0.1:8432/")
DB = os.environ.get("NEB_INDEX_DB", "/opt/nebpool/wallet/index.db")
MATURITY = 100          # coinbase outputs spendable after 100 blocks
POLL = 5.0              # seconds between tip checks
MAX_BLOCKS_PER_RUN = 2000

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
BECH32M_CONST = 0x2BC830A3
GENERATOR = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]


# ---------------------------------------------------------------- bech32m

def _polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            chk ^= GENERATOR[i] if ((top >> i) & 1) else 0
    return chk


def _hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _checksum(hrp, data):
    mod = _polymod(_hrp_expand(hrp) + data + [0] * 6) ^ BECH32M_CONST
    return [(mod >> 5 * (5 - i)) & 31 for i in range(6)]


def decode_address(address: str, hrp: str = "neb") -> str:
    """Return the 32 byte lock of a neb1 address as hex."""
    a = address.strip().lower()
    pos = a.rfind("1")
    if pos < 1:
        raise ValueError("missing separator")
    if a[:pos] != hrp:
        raise ValueError("wrong address prefix")
    words = []
    for c in a[pos + 1:]:
        v = CHARSET.find(c)
        if v < 0:
            raise ValueError("bad character %r" % c)
        words.append(v)
    if len(words) < 7:
        raise ValueError("address too short")
    payload, check = words[:-6], words[-6:]
    if check != _checksum(hrp, payload):
        raise ValueError("bad checksum")
    acc = bits = 0
    out = bytearray()
    for w in payload:
        acc = (acc << 5) | w
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if bits >= 5:
        raise ValueError("bad padding")
    if len(out) != 32:
        raise ValueError("payload is not 32 bytes")
    return out.hex()


# ---------------------------------------------------------------- rpc

def rpc(method: str, params=None, timeout: float = 15.0):
    body = json.dumps({"method": method, "params": params or []}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        doc = json.loads(r.read())
    if doc.get("error"):
        raise RuntimeError("rpc %s: %s" % (method, doc["error"]))
    return doc.get("result")


# ---------------------------------------------------------------- decoding

def read_varint(buf: bytes, at: int):
    """CompactSize: under 0xfd one byte, else a marker and 2/4/8 little endian bytes."""
    if at >= len(buf):
        raise ValueError("truncated varint")
    first = buf[at]
    if first < 0xFD:
        return first, at + 1
    if first == 0xFD:
        return int.from_bytes(buf[at + 1:at + 3], "little"), at + 3
    if first == 0xFE:
        return int.from_bytes(buf[at + 1:at + 5], "little"), at + 5
    return int.from_bytes(buf[at + 1:at + 9], "little"), at + 9


def decode_tx(buf: bytes, at: int):
    """Return (tx, next offset). Shape only: the chain already validated it."""
    start = at
    version = buf[at]
    at += 1
    n_in, at = read_varint(buf, at)
    inputs = []
    for _ in range(n_in):
        prev_txid = buf[at:at + 32].hex()
        at += 32
        prev_index = int.from_bytes(buf[at:at + 4], "little")
        at += 4
        wlen, at = read_varint(buf, at)
        witness = buf[at:at + wlen]
        at += wlen
        inputs.append((prev_txid, prev_index, witness))
    n_out, at = read_varint(buf, at)
    outputs = []
    for _ in range(n_out):
        amount = int.from_bytes(buf[at:at + 8], "little")
        at += 8
        lock_type = buf[at]
        at += 1
        lock_data = buf[at:at + 32].hex()
        at += 32
        outputs.append((amount, lock_type, lock_data))
    return {"version": version, "inputs": inputs, "outputs": outputs,
            "bytes": at - start}, at


def parse_block(raw: bytes):
    """header (80) | varint tx_count | txs | varint share_count | 40B records."""
    if len(raw) < 80:
        raise ValueError("short block")
    header = raw[:80]
    time_le = int.from_bytes(header[68:72], "little")
    at = 80
    n_tx, at = read_varint(raw, at)
    txs = []
    for _ in range(n_tx):
        tx, at = decode_tx(raw, at)
        txs.append(tx)
    n_shares, at = read_varint(raw, at)
    shares = n_shares * 40
    if at + shares > len(raw):
        raise ValueError("share records out of range")
    return {"time": time_le, "txs": txs, "shares": n_shares}


# ---------------------------------------------------------------- store

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS blocks (
  height INTEGER PRIMARY KEY, hash TEXT NOT NULL, time INTEGER NOT NULL,
  txs INTEGER NOT NULL, shares INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS txs (
  txid TEXT PRIMARY KEY, height INTEGER NOT NULL, pos INTEGER NOT NULL,
  time INTEGER NOT NULL, outputs INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS utxos (
  txid TEXT NOT NULL, vout INTEGER NOT NULL, lock TEXT NOT NULL,
  amount INTEGER NOT NULL, height INTEGER NOT NULL, coinbase INTEGER NOT NULL,
  spent_height INTEGER, spent_by TEXT,
  PRIMARY KEY (txid, vout));
CREATE INDEX IF NOT EXISTS utxos_by_lock ON utxos(lock, spent_height);
CREATE INDEX IF NOT EXISTS utxos_spent ON utxos(spent_height);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


class Index:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with closing(self.connect()) as db:
            db.executescript(SCHEMA)

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.execute("PRAGMA synchronous=NORMAL")
        return db

    def tip(self) -> int:
        with closing(self.connect()) as db:
            row = db.execute("SELECT MAX(height) FROM blocks").fetchone()
            return int(row[0]) if row and row[0] is not None else -1

    def add_block(self, height: int, block_hash: str, block: dict) -> None:
        with self.lock, self.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO blocks(height, hash, time, txs, shares) VALUES (?,?,?,?,?)",
                (height, block_hash, block["time"], len(block["txs"]), block["shares"]),
            )
            for pos, tx in enumerate(block["txs"]):
                txid = txid_of(tx)
                db.execute(
                    "INSERT OR REPLACE INTO txs(txid, height, pos, time, outputs) VALUES (?,?,?,?,?)",
                    (txid, height, pos, block["time"], len(tx["outputs"])),
                )
                coinbase = 1 if is_coinbase(tx) else 0
                for vout, (amount, lock_type, lock_data) in enumerate(tx["outputs"]):
                    if lock_type != 1:
                        continue                      # only single key locks are addressable
                    db.execute(
                        "INSERT OR REPLACE INTO utxos(txid, vout, lock, amount, height, coinbase,"
                        " spent_height, spent_by) VALUES (?,?,?,?,?,?,NULL,NULL)",
                        (txid, vout, lock_data, amount, height, coinbase),
                    )
                for prev_txid, prev_index, _witness in tx["inputs"]:
                    if prev_txid == "00" * 32:
                        continue                      # coinbase has no previous output
                    db.execute(
                        "UPDATE utxos SET spent_height=?, spent_by=? WHERE txid=? AND vout=?"
                        " AND spent_height IS NULL",
                        (height, txid, prev_txid, prev_index),
                    )
            db.commit()

    def address(self, lock: str, tip: int) -> dict:
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT txid, vout, amount, height, coinbase, spent_height, spent_by FROM utxos"
                " WHERE lock=? ORDER BY height DESC", (lock,)).fetchall()
            history = db.execute(
                "SELECT u.spent_by, b.height, b.time, u.amount FROM utxos u"
                " LEFT JOIN blocks b ON b.height = u.spent_height"
                " WHERE u.spent_by IS NOT NULL AND u.lock=?"
                " ORDER BY u.spent_height DESC LIMIT 50", (lock,)).fetchall()
        utxos = []
        balance = 0
        immature = 0
        for txid, vout, amount, height, coinbase, spent_height, spent_by in rows:
            if spent_height is not None:
                continue
            mature = not coinbase or (tip - height) >= MATURITY
            if mature:
                balance += amount
            else:
                immature += amount
            utxos.append({"txid": txid, "vout": vout, "amount": amount,
                          "height": height, "coinbase": bool(coinbase),
                          "mature": mature,
                          "confirmations": tip - height + 1})
        return {"lock": lock, "balance": balance, "immature": immature,
                "utxos": utxos,
                "history": self.history(lock, tip),
                "spends": [{"txid": t, "height": h, "time": ts, "amount": a}
                           for t, h, ts, a in history if t]}

    def history(self, lock: str, tip: int, limit: int = 60) -> list:
        """One row per transaction that touched this address.

        The first version listed unspent coins as 收款 and spent coins as 发送, which
        showed a 1 NEB coin as "sent 1 NEB" when 0.1 left the wallet, and hid every
        coin that had already been spent (the purchase itself disappeared). Aggregate
        by txid instead: outputs to me minus inputs from me is what actually moved.
        """
        with closing(self.connect()) as db:
            rows = db.execute(
                "SELECT txid, amount, height, spent_height, spent_by FROM utxos WHERE lock=?",
                (lock,)).fetchall()
            heights = {h: (hsh, t) for h, hsh, t in
                       db.execute("SELECT height, hash, time FROM blocks").fetchall()}
        mine_out: dict[str, int] = {}
        spend_of: dict[str, int] = {}
        tx_height: dict[str, int] = {}
        for txid, amount, height, spent_height, spent_by in rows:
            mine_out[txid] = mine_out.get(txid, 0) + amount
            tx_height[txid] = height
            if spent_by:
                spend_of[spent_by] = spend_of.get(spent_by, 0) + amount
                tx_height.setdefault(spent_by, spent_height)
        out = []
        for txid in set(mine_out) | set(spend_of):
            got = mine_out.get(txid, 0)
            spent = spend_of.get(txid, 0)
            height = tx_height.get(txid)
            hsh, ts = heights.get(height, ("", 0))
            with closing(self.connect()) as db:
                total_out = db.execute("SELECT COALESCE(SUM(amount),0) FROM utxos WHERE txid=?",
                                       (txid,)).fetchone()[0]
                total_in = db.execute("SELECT COALESCE(SUM(amount),0) FROM utxos WHERE spent_by=?",
                                      (txid,)).fetchone()[0]
            # what actually left the address: outputs that are not change coming back
            # only meaningful when this address is one of the spenders; a batch payout
            # to 200 people would otherwise read as "you sent 173 NEB"
            paid = max(0, total_out - got) if spent else 0
            fee = max(0, total_in - total_out)
            out.append({
                "txid": txid,
                "height": height,
                "block": hsh,
                "time": ts,
                "received": got,
                "spent": spent,
                "paid": paid,
                "fee": fee,
                "net": got - spent,
                "self": bool(spent and paid == 0),
                "confirmations": (tip - height + 1) if height is not None else 0,
            })
        out.sort(key=lambda r: (-(r["height"] or 0), r["txid"]))
        return out[:limit]

    def recently_spent(self, lock: str) -> list:
        with closing(self.connect()) as db:
            return db.execute(
                "SELECT spent_by, amount FROM utxos WHERE spent_by IS NOT NULL AND lock=?"
                " ORDER BY spent_height DESC LIMIT 20", (lock,)).fetchall()

    def tx(self, txid: str) -> dict | None:
        with closing(self.connect()) as db:
            row = db.execute("SELECT height, pos, time FROM txs WHERE txid=?", (txid,)).fetchone()
            if not row:
                return None
            outs = db.execute("SELECT vout, amount, lock, spent_height FROM utxos WHERE txid=?"
                              " ORDER BY vout", (txid,)).fetchall()
        return {"txid": txid, "height": row[0], "time": row[2],
                "outputs": [{"vout": v, "amount": a, "lock": l, "spent": s is not None}
                            for v, a, l, s in outs]}

    def stats(self) -> dict:
        with closing(self.connect()) as db:
            blocks = db.execute("SELECT COUNT(*), MAX(height) FROM blocks").fetchone()
            utxos = db.execute("SELECT COUNT(*) FROM utxos WHERE spent_height IS NULL").fetchone()[0]
        return {"blocks": blocks[0], "height": blocks[1], "utxos": utxos}


def is_coinbase(tx: dict) -> bool:
    return len(tx["inputs"]) == 1 and tx["inputs"][0][0] == "00" * 32


def _varint(n: int) -> bytes:
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return bytes([0xFD]) + n.to_bytes(2, "little")
    if n <= 0xFFFF_FFFF:
        return bytes([0xFE]) + n.to_bytes(4, "little")
    return bytes([0xFF]) + n.to_bytes(8, "little")


def encode_tx(tx: dict, with_witness: bool) -> bytes:
    buf = bytearray([tx["version"]])
    buf += _varint(len(tx["inputs"]))
    for prev_txid, prev_index, witness in tx["inputs"]:
        buf += bytes.fromhex(prev_txid) + prev_index.to_bytes(4, "little")
        if with_witness:
            buf += _varint(len(witness)) + witness
    buf += _varint(len(tx["outputs"]))
    for amount, lock_type, lock_data in tx["outputs"]:
        buf += amount.to_bytes(8, "little") + bytes([lock_type]) + bytes.fromhex(lock_data)
    return bytes(buf)


def txid_of(tx: dict) -> str:
    """H("txid", encoding); the coinbase commits its witness, others do not."""
    import blake3

    hasher = blake3.blake3()
    hasher.update(b"txid")
    hasher.update(encode_tx(tx, with_witness=is_coinbase(tx)))
    return hasher.digest().hex()


# ---------------------------------------------------------------- sync

class Syncer(threading.Thread):
    def __init__(self, index: Index):
        super().__init__(daemon=True)
        self.index = index
        self.stop = threading.Event()
        self.error = None

    def run(self):
        while not self.stop.is_set():
            try:
                height = int(rpc("getblockcount"))
                have = self.index.tip()
                missing = list(range(have + 1, height + 1))[:MAX_BLOCKS_PER_RUN]
                for h in missing:
                    block_hash = rpc("getblockhash", [h])
                    raw = bytes.fromhex(rpc("getblock", [block_hash]))
                    self.index.add_block(h, block_hash, parse_block(raw))
                if missing:
                    print("indexed to %d" % missing[-1], flush=True)
                self.error = None
            except Exception as exc:                   # keep the loop alive
                self.error = str(exc)
                print("sync error: %s" % exc, file=sys.stderr, flush=True)
            self.stop.wait(POLL)


# ---------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    index: Index = None
    minter = None

    def log_message(self, fmt, *args):
        pass

    def _json(self, code: int, doc: dict):
        body = json.dumps(doc).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            tip = int(rpc("getblockcount"))
        except Exception:
            tip = self.index.tip()
        if path.startswith("/api/wallet/a/"):
            address = unquote(path[len("/api/wallet/a/"):])
            try:
                lock = decode_address(address)
            except ValueError as exc:
                return self._json(400, {"error": str(exc)})
            doc = self.index.address(lock, tip)
            doc["address"] = address
            doc["tip"] = tip
            return self._json(200, doc)
        if path.startswith("/api/wallet/tx/"):
            doc = self.index.tx(unquote(path[len("/api/wallet/tx/"):]))
            return self._json(200, doc) if doc else self._json(404, {"error": "not found"})
        if path == "/api/wallet/stats":
            doc = self.index.stats()
            doc["tip"] = tip
            return self._json(200, doc)
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/wallet/broadcast":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= 200_000:
            return self._json(400, {"error": "bad length"})
        try:
            doc = json.loads(self.rfile.read(length))
            raw = doc["hex"].strip().lower()
            if not raw or len(raw) % 2 or any(c not in "0123456789abcdef" for c in raw):
                raise ValueError("bad hex")
            txid = rpc("sendrawtransaction", [raw])
            return self._json(200, {"txid": txid})
        except Exception as exc:
            return self._json(400, {"error": str(exc)})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DB)
    ap.add_argument("--listen", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8083)
    ap.add_argument("--sync-only", action="store_true")
    args = ap.parse_args()

    index = Index(args.db)
    syncer = Syncer(index)
    syncer.start()
    if args.sync_only:
        while True:
            time.sleep(POLL)
    Handler.index = index
    server = ThreadingHTTPServer((args.listen, args.port), Handler)
    print("wallet index on %s:%d, db %s" % (args.listen, args.port, args.db), flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

// NEB wallet primitives, in plain JavaScript so they can run in a page that has
// no server behind it. The rules come from the node: keys are Ed25519, an address
// is bech32m of BLAKE3(public key), and a signature covers
// H("sighash", chain id | txid | input index | spent amount | spent lock).
//
// Everything here is deterministic and side-effect free: no network, no storage.
// The UI layer is responsible for keeping `secret` out of anywhere it can leak.

import { blake3 } from "@noble/hashes/blake3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/** One coin in base units. */
export const COIN = 100_000_000n;

/** Lock type of a single Ed25519 key: lock_data = BLAKE3(public key). */
export const LOCK_SINGLE = 1;

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const HRP = "neb";

// ---------------------------------------------------------------- hashing

/** H(tag, parts...) = BLAKE3 over the tag bytes then each part, no separators. */
export function h(tag, parts) {
  const tagBytes = typeof tag === "string" ? new TextEncoder().encode(tag) : tag;
  const total = parts.reduce((n, p) => n + p.length, tagBytes.length);
  const buf = new Uint8Array(total);
  buf.set(tagBytes, 0);
  let at = tagBytes.length;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return blake3(buf);
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex) {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2) throw new Error("not hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ---------------------------------------------------------------- keys

/** 32 random bytes. Uses the platform CSPRNG; refuses to run without one. */
export function newSecret() {
  const c = globalThis.crypto;
  if (!c || !c.getRandomValues) throw new Error("no secure random source");
  const s = new Uint8Array(32);
  c.getRandomValues(s);
  return s;
}

export function publicKeyOf(secret) {
  return ed25519.getPublicKey(secret);
}

export function lockOf(publicKey) {
  return blake3(publicKey);
}

// ---------------------------------------------------------------- bech32m

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
    chk >>>= 0;
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function toWords(bytes) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}

function fromWords(words) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff)) throw new Error("bad padding");
  return Uint8Array.from(out);
}

function checksum(hrp, words) {
  const values = hrpExpand(hrp).concat(words, [0, 0, 0, 0, 0, 0]);
  const mod = (polymod(values) ^ BECH32M_CONST) >>> 0;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}

/** bech32m of a 32 byte lock, the 62 character `neb1...` form. */
export function encodeAddress(lock, hrp = HRP) {
  if (lock.length !== 32) throw new Error("lock must be 32 bytes");
  const words = toWords(lock);
  const check = checksum(hrp, words);
  return hrp + "1" + words.concat(check).map((w) => CHARSET[w]).join("");
}

/** Reverse of encodeAddress: validates the m-checksum and returns the lock. */
export function decodeAddress(address, hrp = HRP) {
  const a = address.trim().toLowerCase();
  if (a !== address.trim() && a.toUpperCase() !== address.trim()) throw new Error("mixed case address");
  const pos = a.lastIndexOf("1");
  if (pos < 1) throw new Error("missing separator");
  if (a.slice(0, pos) !== hrp) throw new Error("wrong address prefix");
  const words = [];
  for (const c of a.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error("bad character " + c);
    words.push(v);
  }
  if (words.length < 7) throw new Error("address too short");
  const payload = words.slice(0, -6);
  const check = words.slice(-6);
  const want = checksum(hrp, payload);
  for (let i = 0; i < 6; i++) if (check[i] !== want[i]) throw new Error("bad checksum");
  const lock = fromWords(payload);
  if (lock.length !== 32) throw new Error("payload is not 32 bytes");
  return lock;
}

export function addressOf(publicKey, hrp = HRP) {
  return encodeAddress(lockOf(publicKey), hrp);
}

// ---------------------------------------------------------------- serialisation

/**
 * The node's varint is Bitcoin's CompactSize, not LEB128: below 0xfd the value
 * is one byte, otherwise a 0xfd/0xfe/0xff marker followed by a little endian
 * 2/4/8 byte number. Getting this wrong only shows up past 252 inputs or
 * outputs, which is exactly when a wallet consolidates coins.
 */
export function varint(n) {
  const v = BigInt(n);
  if (v < 0n) throw new Error("negative varint");
  if (v < 0xfdn) return Uint8Array.of(Number(v));
  if (v <= 0xffffn) {
    const out = new Uint8Array(3);
    out[0] = 0xfd;
    new DataView(out.buffer).setUint16(1, Number(v), true);
    return out;
  }
  if (v <= 0xffffffffn) {
    const out = new Uint8Array(5);
    out[0] = 0xfe;
    new DataView(out.buffer).setUint32(1, Number(v), true);
    return out;
  }
  const out = new Uint8Array(9);
  out[0] = 0xff;
  new DataView(out.buffer).setBigUint64(1, v, true);
  return out;
}

/** Reads a CompactSize varint, returning [value, next offset]. */
export function readVarint(buf, at = 0) {
  const first = buf[at];
  if (first < 0xfd) return [BigInt(first), at + 1];
  const view = new DataView(buf.buffer, buf.byteOffset + at + 1);
  if (first === 0xfd) return [BigInt(view.getUint16(0, true)), at + 3];
  if (first === 0xfe) return [BigInt(view.getUint32(0, true)), at + 5];
  return [view.getBigUint64(0, true), at + 9];
}

function u32(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(n), true);
  return out;
}

function u64(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A transaction is `{ version, inputs: [{prevTxid, prevIndex, witness}], outputs:
 * [{amount, lockType, lockData}] }`. The txid commits to the serialisation
 * without witnesses, so a witness can be re-encoded without changing the id.
 */
export function encodeTx(tx, { witnesses = true } = {}) {
  const parts = [Uint8Array.of(tx.version ?? 1), varint(tx.inputs.length)];
  for (const i of tx.inputs) {
    parts.push(i.prevTxid, u32(i.prevIndex));
    if (witnesses) {
      const w = i.witness ?? new Uint8Array(0);
      parts.push(varint(w.length), w);
    }
  }
  parts.push(varint(tx.outputs.length));
  for (const o of tx.outputs) {
    parts.push(u64(o.amount), Uint8Array.of(o.lockType), o.lockData);
  }
  return concat(parts);
}

export function txid(tx) {
  return h("txid", [encodeTx(tx, { witnesses: false })]);
}

/** What one input signs: binds chain, tx, input position and the exact coin spent. */
export function sighash(tx, chainId, inputIndex, spent) {
  return h("sighash", [
    chainId,
    txid(tx),
    u32(inputIndex),
    u64(spent.amount),
    Uint8Array.of(spent.lockType),
    spent.lockData,
  ]);
}

/** Fills in the witness of one input: public key (32) then signature (64). */
export function signInput(tx, secret, chainId, inputIndex, spent) {
  const publicKey = publicKeyOf(secret);
  const digest = sighash(tx, chainId, inputIndex, spent);
  const signature = ed25519.sign(digest, secret);
  tx.inputs[inputIndex].witness = concat([publicKey, signature]);
  return tx;
}

/** The node's rule: lock_data must equal BLAKE3(witness[:32]) and the signature must verify. */
export function checkWitness(tx, chainId, inputIndex, spent) {
  const w = tx.inputs[inputIndex].witness ?? new Uint8Array(0);
  if (w.length !== 96) return false;
  const publicKey = w.slice(0, 32);
  const signature = w.slice(32);
  const expected = spent.lockType === LOCK_SINGLE ? lockOf(publicKey) : null;
  if (!expected) return false;
  for (let i = 0; i < 32; i++) if (expected[i] !== spent.lockData[i]) return false;
  return ed25519.verify(signature, sighash(tx, chainId, inputIndex, spent), publicKey);
}

// ---------------------------------------------------------------- fees

/** Fee of a transaction: inputs minus outputs, given the coins being spent. */
export function feeOf(spent, outputs) {
  const inSum = spent.reduce((n, s) => n + BigInt(s.amount), 0n);
  const outSum = outputs.reduce((n, o) => n + BigInt(o.amount), 0n);
  return inSum - outSum;
}

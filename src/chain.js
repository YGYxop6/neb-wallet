// Talking to the chain: the read-only index for balances and history, and the
// relay for an already signed transaction. Coin selection and the transaction
// itself are built here so the UI only has to render numbers.

import {
  LOCK_SINGLE, addressOf, decodeAddress, encodeTx, fromHex, lockOf, publicKeyOf,
  signInput, toHex, txid,
} from "./neb.js";

const API = "/api/wallet";

export async function fetchAddress(address) {
  const r = await fetch(`${API}/a/${encodeURIComponent(address)}`, { cache: "no-store" });
  const doc = await r.json();
  if (!r.ok) throw new Error(doc.error || `http ${r.status}`);
  return doc;
}

export async function fetchTx(txid) {
  const r = await fetch(`${API}/tx/${encodeURIComponent(txid)}`, { cache: "no-store" });
  if (r.status === 404) return null;
  const doc = await r.json();
  if (!r.ok) throw new Error(doc.error || `http ${r.status}`);
  return doc;
}

export async function broadcast(hex) {
  const r = await fetch(`${API}/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hex }),
  });
  const doc = await r.json();
  if (!r.ok) throw new Error(doc.error || `http ${r.status}`);
  return doc.txid;
}

/** "1.2345" -> 123450000n, refusing more precision than a coin carries. */
export function parseAmount(text) {
  const clean = String(text).trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") throw new Error("bad amount");
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > 8) throw new Error("at most 8 decimals");
  return BigInt(whole || "0") * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
}

export function formatAmount(base) {
  const v = BigInt(base);
  const whole = v / 100_000_000n;
  const frac = (v % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Which coins to spend: largest first, so a payment usually takes one input.
 * Only mature coins are eligible (a coinbase pays after 100 blocks).
 */
export function selectCoins(utxos, need) {
  const usable = utxos.filter((u) => u.mature).sort((a, b) => b.amount - a.amount);
  const picked = [];
  let total = 0n;
  for (const u of usable) {
    picked.push(u);
    total += BigInt(u.amount);
    if (total >= need) return { picked, total };
  }
  return { picked, total, short: need - total };
}

/**
 * Builds and signs a payment. Inputs are (txid, vout) pairs; the change comes
 * back to `changeLock`, which is the sender's own lock.
 */
export function buildPayment({ utxos, changeLock, toLock, amount, fee, secret }) {
  const need = amount + fee;
  const { picked, total, short } = selectCoins(utxos, need);
  if (short !== undefined) {
    return { error: "insufficient", available: total, need };
  }
  const outputs = [{ amount, lockType: LOCK_SINGLE, lockData: toLock }];
  const change = total - need;
  if (change > 0n) {
    outputs.push({ amount: change, lockType: LOCK_SINGLE, lockData: changeLock });
  }
  const tx = {
    version: 1,
    inputs: picked.map((u) => ({
      prevTxid: fromHex(u.txid), prevIndex: u.vout, witness: new Uint8Array(0),
    })),
    outputs,
  };
  // The signature binds the exact coin spent, so each input signs its own
  // amount, not just the output being paid.
  picked.forEach((u, i) => {
    signInput(tx, secret, CHAIN_ID, i, {
      amount: BigInt(u.amount),
      lockType: LOCK_SINGLE,
      lockData: changeLock,
    });
  });
  return {
    hex: toHex(encodeTx(tx)),
    inputs: picked.length,
    change,
    fee,
    txid: toHex(txid(tx)),
  };
}

/** The mainnet id from the node's genesis (spec/node.md section 4.1). */
export const CHAIN_ID = fromHex(
  "da2f5af7bb4c5e2bcc8d558b2f4f01d4c88557a943e6cff9cd035638fe9439ae",
);

export function lockOfAddress(address) {
  return decodeAddress(address);
}

export { addressOf, lockOf, publicKeyOf };

// Vectors captured from the reference implementation: `neb-wallet` for the
// address and a Rust program built against `neb-chain::tx` for the txid and
// sighash. If these pass, the browser copy agreebyte for byte with the node.

import {
  COIN, addressOf, checkWitness, decodeAddress, encodeAddress, fromHex, lockOf,
  publicKeyOf, signInput, sighash, toHex, txid, encodeTx, feeOf, varint, readVarint,
} from "../src/neb.js";

let failures = 0;
function eq(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n     got  ${got}\n     want ${want}`}`);
}

const secret = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const pubkey = publicKeyOf(secret);
const lock = lockOf(pubkey);
const chainId = fromHex("da2f5af7bb4c5e2bcc8d558b2f4f01d4c88557a943e6cff9cd035638fe9439ae");

eq("public key", toHex(pubkey), "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
eq("lock", toHex(lock), "98ba85304ac639f0f55daab01ad6d592be44a125d9b3b65e1efca5b96960baec");
eq("address", addressOf(pubkey), "neb1nzag2vz2cculpa2a42cp44k4j2lyfgf9mxemvhs7ljjmj6tqhtkqp57mpr");
eq("address round trip", toHex(decodeAddress(addressOf(pubkey))), toHex(lock));

const tx = {
  version: 1,
  inputs: [{ prevTxid: new Uint8Array(32).fill(7), prevIndex: 0, witness: new Uint8Array(0) }],
  outputs: [{ amount: 10_000_000n, lockType: 1, lockData: lock }],
};

eq("txid", toHex(txid(tx)), "be14b735c45e59b836f95c79e6ee4bab7f7d08b9f8705fbb3c75841d48fd9ad5");

const spent = { amount: 50_000_000n, lockType: 1, lockData: lock };
const digest = sighash(tx, chainId, 0, spent);
eq("sighash", toHex(digest), "f0f55548b25551a4959199b8f59bf1394910c1a0584dd9571638b5cb389bee47");

signInput(tx, secret, chainId, 0, spent);
eq(
  "witness (pubkey | signature)",
  toHex(tx.inputs[0].witness),
  "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8" +
    "f82fd89646d14795b729a4426bbc51255652e0feeb41c87eb08477c74942ba46b2" +
    "7d1ac514d604fa91d54f209dc11f9c68a44cb681d6550a7500c469e5456005",
);
eq("witness verifies", checkWitness(tx, chainId, 0, spent), true);
eq("txid unchanged by the witness", toHex(txid(tx)),
   "be14b735c45e59b836f95c79e6ee4bab7f7d08b9f8705fbb3c75841d48fd9ad5");
eq("fee", feeOf([spent], tx.outputs).toString(), String(50_000_000 - 10_000_000));

// a tampered amount must fail: the signature binds the spent coin, not just the id
const other = { amount: 60_000_000n, lockType: 1, lockData: lock };
eq("tampered coin rejected", checkWitness(tx, chainId, 0, other), false);
// and a wrong chain (replay to another network) must fail too
eq("wrong chain rejected", checkWitness(tx, new Uint8Array(32).fill(9), 0, spent), false);

// a multi-input transaction: two coins in, one out plus change
const tx2 = {
  version: 1,
  inputs: [
    { prevTxid: new Uint8Array(32).fill(1), prevIndex: 0, witness: new Uint8Array(0) },
    { prevTxid: new Uint8Array(32).fill(2), prevIndex: 3, witness: new Uint8Array(0) },
  ],
  outputs: [
    { amount: 30_000_000n, lockType: 1, lockData: lock },
    { amount: 19_900_000n, lockType: 1, lockData: lock },
  ],
};
signInput(tx2, secret, chainId, 0, { amount: 20_000_000n, lockType: 1, lockData: lock });
signInput(tx2, secret, chainId, 1, { amount: 30_000_000n, lockType: 1, lockData: lock });
eq("multi input verifies", 
   checkWitness(tx2, chainId, 0, { amount: 20_000_000n, lockType: 1, lockData: lock }) &&
   checkWitness(tx2, chainId, 1, { amount: 30_000_000n, lockType: 1, lockData: lock }), true);
eq("multi input size", encodeTx(tx2).length > 2 * 96, true);
eq("coin constant", COIN.toString(), "100000000");

// CompactSize, as neb-codec writes it: this is where a LEB128 encoder differs
eq("varint 0", toHex(varint(0)), "00");
eq("varint 252", toHex(varint(252)), "fc");
eq("varint 253", toHex(varint(253)), "fdfd00");
eq("varint 300 (an output count past 252)", toHex(varint(300)), "fd2c01");
eq("varint 70000", toHex(varint(70000)), "fe70110100");
eq("varint round trip 300", String(readVarint(varint(300))[0]), "300");

console.log(failures ? `\n${failures} FAILED` : "\nall vectors pass");
process.exit(failures ? 1 : 0);

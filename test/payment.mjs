// Build a payment from made-up coins and check it against the node's own rules.
import { CHAIN_ID, buildPayment, formatAmount, parseAmount } from "../src/chain.js";
import { addressOf, checkWitness, decodeAddress, encodeTx, fromHex, lockOf, publicKeyOf, toHex, txid } from "../src/neb.js";

let bad = 0;
const eq = (n, a, b) => { const ok = a === b; if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : ` got ${a} want ${b}`}`); };

eq("parse 1.5", parseAmount("1.5").toString(), "150000000");
eq("parse 0.00000001", parseAmount("0.00000001").toString(), "1");
eq("format 150000000", formatAmount(150000000n), "1.5");
eq("format 1", formatAmount(1n), "0.00000001");

const secret = fromHex("11".repeat(32));
const myAddress = addressOf(publicKeyOf(secret));
const myLock = lockOf(publicKeyOf(secret));
const other = fromHex("22".repeat(32));
const otherLock = decodeAddress(addressOf(publicKeyOf(other)));

const utxos = [
  { txid: "aa".repeat(32), vout: 0, amount: 500_000_000, mature: true },
  { txid: "bb".repeat(32), vout: 1, amount: 300_000_000, mature: true },
  { txid: "cc".repeat(32), vout: 0, amount: 900_000_000, mature: false },
];

// 4 NEB to someone else, 0.001 fee: one 5 NEB coin covers it, change comes back
const pay = buildPayment({ utxos, changeLock: myLock, toLock: otherLock, amount: 400_000_000n, fee: 100_000n, secret });
eq("one input used", pay.inputs, 1);
eq("change", pay.change.toString(), "99900000");
console.log("     hex length", pay.hex.length, "txid", pay.txid.slice(0, 16) + "…");

const tx = {
  version: 1,
  inputs: [{ prevTxid: fromHex("aa".repeat(32)), prevIndex: 0, witness: new Uint8Array(0) }],
  outputs: [
    { amount: 400_000_000n, lockType: 1, lockData: otherLock },
    { amount: 99_900_000n, lockType: 1, lockData: myLock },
  ],
};
// re-sign the same shape to check the signature the builder produced
import { signInput } from "../src/neb.js";
signInput(tx, secret, CHAIN_ID, 0, { amount: 500_000_000n, lockType: 1, lockData: myLock });
eq("signed payment verifies", checkWitness(tx, CHAIN_ID, 0, { amount: 500_000_000n, lockType: 1, lockData: myLock }), true);
eq("builder hex matches hand built", toHex(encodeTx(tx)), pay.hex);
eq("txid matches", toHex(txid(tx)), pay.txid);

// spending more than the mature coins hold must be refused, ignoring immature ones
const short = buildPayment({ utxos, changeLock: myLock, toLock: otherLock, amount: 900_000_000n, fee: 100_000n, secret });
eq("immature coins are not spent", short.error, "insufficient");
eq("available excludes immature", formatAmount(short.available), "8");

// two inputs when one is not enough
const two = buildPayment({ utxos, changeLock: myLock, toLock: otherLock, amount: 750_000_000n, fee: 100_000n, secret });
eq("two inputs", two.inputs, 2);
eq("change after two", formatAmount(two.change), "0.499");

eq("my address is a neb1 string", myAddress.startsWith("neb1"), true);
console.log(bad ? `\n${bad} FAILED` : "\npayment vectors pass");
process.exit(bad ? 1 : 0);

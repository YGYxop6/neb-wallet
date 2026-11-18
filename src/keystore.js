// The wallet file lives in the browser and nowhere else. A password is stretched
// with PBKDF2-SHA256 and the 32 byte secret is sealed with AES-GCM, so what sits
// in local storage is useless without the password. Nothing here ever sends the
// secret anywhere: the only outbound calls are the read-only index and the relay
// of an already signed transaction.

import { addressOf, publicKeyOf } from "./neb.js";

const ITERATIONS = 600_000;
const STORE_KEY = "neb.wallet.v1";
const WATCH_KEY = "neb.watch.v1";

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(password, salt, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export class Keystore {
  /** @param {Storage} store */
  constructor(store = globalThis.localStorage) {
    this.store = store;
  }

  raw() {
    const text = this.store.getItem(STORE_KEY);
    return text ? JSON.parse(text) : null;
  }

  hasWallet() {
    return Boolean(this.raw());
  }

  /** Address of the stored wallet, without unlocking it. */
  address() {
    const doc = this.raw();
    return doc ? doc.address : null;
  }

  async create(password, secret) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, secret));
    const doc = {
      v: 1,
      kdf: "PBKDF2-SHA256",
      iter: ITERATIONS,
      cipher: "AES-GCM",
      salt: b64(salt),
      iv: b64(iv),
      ct: b64(ct),
      address: addressOf(publicKeyOf(secret)),
      created: Date.now(),
    };
    this.store.setItem(STORE_KEY, JSON.stringify(doc));
    this.store.removeItem(WATCH_KEY);
    return doc.address;
  }

  /** @returns {Uint8Array} the 32 byte secret, only after a correct password. */
  async unlock(password) {
    const doc = this.raw();
    if (!doc) throw new Error("no wallet");
    const key = await deriveKey(password, unb64(doc.salt), doc.iter);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(doc.iv) }, key, unb64(doc.ct),
    );
    const secret = new Uint8Array(plain);
    if (addressOf(publicKeyOf(secret)) !== doc.address) throw new Error("key does not match address");
    return secret;
  }

  async changePassword(oldPassword, newPassword) {
    const secret = await this.unlock(oldPassword);
    return this.create(newPassword, secret);
  }

  remove() {
    this.store.removeItem(STORE_KEY);
  }

  // -- watch only: an address with no key, for checking a balance ----------
  setWatch(address) {
    this.store.setItem(WATCH_KEY, JSON.stringify({ address }));
  }

  watch() {
    const text = this.store.getItem(WATCH_KEY);
    return text ? JSON.parse(text).address : null;
  }

  clearWatch() {
    this.store.removeItem(WATCH_KEY);
  }
}

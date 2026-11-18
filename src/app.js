// Wallet UI. Everything sensitive stays in this file's memory: the secret is
// only decrypted while unlocked, and is dropped when the page is locked, hidden
// or idle. Nothing here can move coins without a password typed by the user.

import { Keystore } from "./keystore.js";
import {
  CHAIN_ID, buildPayment, broadcast, fetchAddress, fetchTx, formatAmount,
  lockOfAddress, parseAmount,
} from "./chain.js";
import { addressOf, decodeAddress, fromHex, publicKeyOf, toHex } from "./neb.js";
import qrcode from "qrcode-generator";

const $ = (id) => document.getElementById(id);
const store = new Keystore();
const IDLE_MS = 5 * 60 * 1000;

const I18N = {
  zh: {
    nav_pool: "矿池", nav_miners: "矿工", nav_blocks: "出块", nav_wallet: "钱包",
    mainnet: "mainnet", search_ph: "搜索地址 neb1…", search_btn: "查询",
    w_kick: "NEB · 非托管钱包", w_h1: "钱包只在你的浏览器里",
    w_p1: "私钥在你的设备上生成并加密保存，永远不会发到服务器。服务器只提供余额查询和交易广播，就算它被完全攻破，也动不了你的币。",
    w_create: "创建新钱包", w_import: "导入私钥", w_watch: "只看地址",
    w_note: "创建后会给你一串私钥（64 位十六进制），它同时也是恢复钱包的唯一凭据。抄下来离线保存，丢了谁也找不回来。",
    c_kick: "创建钱包", c_h1: "设一个密码",
    c_p1: "密码只用来在本机加密私钥，不上传。忘记密码只能用私钥重新导入。",
    f_password: "密码", f_password2: "再输一次", c_go: "生成钱包", f_back: "返回",
    i_kick: "导入钱包", i_h1: "粘贴私钥",
    i_p1: "64 位十六进制的 Ed25519 私钥，和官方 neb-wallet 导出的一致。私钥只在这台设备的这个页面里使用。",
    f_secret: "私钥", i_go: "导入",
    wt_kick: "观察地址", wt_h1: "只看余额，不碰私钥",
    wt_p1: "输入任何一个 neb1 地址，可以看余额和历史，但不能发送。",
    f_address: "地址", wt_go: "查看",
    u_kick: "已锁定", u_h1: "输入密码解锁", u_go: "解锁", u_forget: "删除本机钱包",
    a_kick: "我的钱包", a_lock: "锁定", a_forget: "删除", a_copy: "复制地址",
    a_avail: "可用余额", a_immature: "待成熟", a_height: "区块高度",
    t_send: "发送", t_receive: "接收", t_history: "历史",
    f_to: "收款地址", f_amount: "金额 (NEB)", f_fee: "手续费 (NEB)",
    s_max: "全部发送", s_go: "签名并发送",
    s_note: "交易在这台设备上签名，服务器只负责转发。签名前会显示收款地址和金额，请核对后再确认。",
    r_kick: "收款地址", r_copy: "复制地址",
    h_h: "交易记录", h_refresh: "刷新", h_empty: "还没有交易",
    h_block: "区块", h_height: "高度", h_tx: "交易", h_detail: "交易详情", h_dir: "方向", h_fee_short: "手续费",
    a_key: "私钥", ex_title: "导出私钥", ex_copy: "复制私钥",
    key_pass_title: "输入钱包密码", key_pass_label: "密码", key_pass_ok: "查看私钥",
    key_pass_bad: "密码不正确",
    ex_warn: "这串字符谁拿到都能把币转走。只抄在纸上，不要截图、不要发聊天工具。",
    h_close: "关闭", h_self: "转账", h_conf: "确认", h_none: "—",
    foot_note: "私钥从不上传 · 服务器只提供余额查询与交易广播",
    foot_src: "源代码", foot_pool: "矿池",
    err_pass_short: "密码至少 8 位", err_pass_mismatch: "两次输入的密码不一样",
    err_secret: "私钥必须是 64 位十六进制", err_addr: "地址格式不对",
    err_amount: "金额不对", err_fee: "手续费不对",
    err_insufficient: "可用余额不足", err_locked: "已锁定，请重新解锁",
    backup_title: "钱包已创建，立即备份私钥",
    backup_body: "这串私钥是你资产的唯一凭据。抄在纸上离线保存，不要截图、不要发到聊天工具。服务器上没有副本，丢了无法恢复。",
    reveal: "显示私钥", reveal_confirm: "再次输入密码以显示私钥",
    copied: "已复制", confirm_send: "确认发送这笔交易？", cf_ok: "确认发送", cf_no: "取消",
    cf_inputs: "输入数", cf_delete: "删除钱包",
    sent: "已广播", pending: "待确认", confirmed: "已确认",
    in: "收款", out: "发送", watch_only: "观察模式（不能发送）",
    send_disabled_watch: "观察模式不能发送", no_wallet: "本机还没有钱包",
    build: "代码指纹",
  },
  en: {
    nav_pool: "pool", nav_miners: "miners", nav_blocks: "blocks", nav_wallet: "wallet",
    mainnet: "mainnet", search_ph: "search a neb1 address…", search_btn: "look up",
    w_kick: "NEB · non-custodial wallet", w_h1: "Your wallet stays in your browser",
    w_p1: "The key is generated on your device and stored encrypted. It is never sent to the server, so even a fully compromised server cannot move your coins.",
    w_create: "Create wallet", w_import: "Import key", w_watch: "Watch an address",
    w_note: "You will get a private key (64 hex characters). It is the only way to restore this wallet: write it down offline. Nobody can recover it for you.",
    c_kick: "Create wallet", c_h1: "Choose a password",
    c_p1: "The password only encrypts the key on this device and is never uploaded. Without it you must re-import the key.",
    f_password: "Password", f_password2: "Repeat", c_go: "Create", f_back: "Back",
    i_kick: "Import wallet", i_h1: "Paste the key",
    i_p1: "A 64 character hex Ed25519 secret, the same format neb-wallet exports. It is used only in this page on this device.",
    f_secret: "Private key", i_go: "Import",
    wt_kick: "Watch", wt_h1: "Balance only, no key",
    wt_p1: "Enter any neb1 address to see its balance and history. Sending is disabled.",
    f_address: "Address", wt_go: "Look up",
    u_kick: "Locked", u_h1: "Enter password", u_go: "Unlock", u_forget: "Delete local wallet",
    a_kick: "My wallet", a_lock: "Lock", a_forget: "Delete", a_copy: "Copy address",
    a_avail: "Available", a_immature: "Immature", a_height: "Block height",
    t_send: "Send", t_receive: "Receive", t_history: "History",
    f_to: "To", f_amount: "Amount (NEB)", f_fee: "Fee (NEB)",
    s_max: "Send all", s_go: "Sign and send",
    s_note: "The transaction is signed on this device; the server only relays it. Check the address and amount before confirming.",
    r_kick: "Your address", r_copy: "Copy address",
    h_h: "Transactions", h_refresh: "Refresh", h_empty: "No transactions yet",
    h_block: "block", h_height: "height", h_tx: "txid", h_detail: "Transaction", h_dir: "direction", h_fee_short: "fee",
    a_key: "Key", ex_title: "Export private key", ex_copy: "Copy key",
    key_pass_title: "Wallet password", key_pass_label: "password", key_pass_ok: "Show key",
    key_pass_bad: "Wrong password",
    ex_warn: "Anyone holding this string can move your coins. Write it on paper only — never a screenshot or a chat.",
    h_close: "Close", h_self: "Transfer", h_conf: "confirmations", h_none: "—",
    foot_note: "Keys never leave the browser · the server only reads balances and relays transactions",
    foot_src: "Source", foot_pool: "Pool",
    err_pass_short: "Password must be at least 8 characters", err_pass_mismatch: "Passwords do not match",
    err_secret: "The key must be 64 hex characters", err_addr: "That is not a valid address",
    err_amount: "Bad amount", err_fee: "Bad fee",
    err_insufficient: "Not enough spendable coins", err_locked: "Locked, unlock again",
    backup_title: "Wallet created — back up the key now",
    backup_body: "This key is the only proof of ownership. Write it on paper, offline. No screenshot, no chat apps. There is no copy on the server and no way to recover it.",
    reveal: "Show key", reveal_confirm: "Enter the password again to show the key",
    copied: "Copied", confirm_send: "Send this transaction?", cf_ok: "Sign & send", cf_no: "Cancel",
    cf_inputs: "inputs", cf_delete: "Remove wallet",
    sent: "Broadcast", pending: "Pending", confirmed: "Confirmed",
    in: "Received", out: "Sent", watch_only: "Watch mode (cannot send)",
    send_disabled_watch: "Watch mode cannot send", no_wallet: "No wallet on this device",
    build: "build",
  },
};

// the pool page and this one share the choice, so switching on either sticks
let lang = localStorage.getItem("nebpool-lang") || "zh";
const t = (k) => (I18N[lang] && I18N[lang][k]) || k;

const state = {
  secret: null,
  address: null,
  watchOnly: false,
  data: null,
  idleAt: 0,
  poll: 0,
  pending: JSON.parse(localStorage.getItem("neb.pending") || "[]"),
};

// ------------------------------------------------------------------ views
const VIEWS = ["view-welcome", "view-create", "view-import", "view-watch",
  "view-unlock", "view-wallet"];

function show(view) {
  for (const id of VIEWS) $(id).classList.toggle("hidden", id !== view);
  if (view !== "view-wallet") stopPoll();
}

function applyLang() {
  document.documentElement.lang = lang === "zh" ? "zh" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (I18N[lang][key]) el.textContent = I18N[lang][key];
  }
  document.querySelectorAll(".lang button").forEach((b) => {
    b.classList.toggle("on", b.dataset.lang === lang);
  });
  document.querySelector('meta[name="theme-color"]').content = "#0a0a0a";
  renderBalance();
  renderHistory();
  renderHint();
}

function home() {
  if (state.watchOnly) return openWallet();
  if (store.hasWallet()) {
    $("u-addr").textContent = store.address();
    show("view-unlock");
    $("u-pass").focus();
  } else if (store.watch()) {
    state.watchOnly = true;
    state.address = store.watch();
    return openWallet();
  } else {
    show("view-welcome");
  }
}

// ------------------------------------------------------------------ wallet
function openWallet() {
  show("view-wallet");
  $("a-addr").textContent = state.address;
  $("r-addr").textContent = state.address;
  $("a-forget").classList.toggle("hidden", state.watchOnly);
  $("a-lock").classList.toggle("hidden", state.watchOnly);
  $("s-go").disabled = state.watchOnly;
  renderQr();
  renderHint();
  loadData();
  startPoll();
}

function startPoll() {
  stopPoll();
  state.poll = setInterval(loadData, 12000);
}

function stopPoll() {
  if (state.poll) clearInterval(state.poll);
  state.poll = 0;
}

function renderQr() {
  try {
    const qr = qrcode(0, "M");
    qr.addData(state.address);
    qr.make();
    $("r-qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch (err) {
    $("r-qr").textContent = "QR error";
  }
}

async function loadData() {
  if (!state.address) return;
  try {
    state.data = await fetchAddress(state.address);
    renderBalance();
    renderHistory();
    renderHint();
    await refreshPending();
  } catch (err) {
    // keep the last figures on a hiccup, the page is not the source of truth
  }
}

function setNumber(id, value) {
  // text nodes only: a balance is a number, but nothing here should ever be
  // able to inject markup, so no innerHTML on values that come from the network
  const el = $(id);
  if (!el) return;
  el.textContent = value;
  if (value !== "–") {
    const unit = document.createElement("small");
    unit.textContent = "NEB";
    el.appendChild(unit);
  }
}

function renderBalance() {
  const d = state.data;
  if (!d) {
    setNumber("a-bal", "–");
    setNumber("a-imm", "–");
    $("a-height").textContent = "–";
    return;
  }
  setNumber("a-bal", formatAmount(d.balance));
  setNumber("a-imm", formatAmount(d.immature));
  $("a-height").textContent = String(d.tip);
}

function renderHint() {
  const el = $("s-hint");
  if (!el) return;
  if (state.watchOnly) { el.textContent = t("send_disabled_watch"); return; }
  const d = state.data;
  el.textContent = d ? `${t("a_avail")} ${formatAmount(d.balance)} NEB` : "";
}

function shortHash(s, head = 10, tail = 6) {
  return s && s.length > head + tail ? s.slice(0, head) + "…" + s.slice(-tail) : (s || t("h_none"));
}

function renderHistory() {
  const list = $("h-list");
  if (!list) return;
  const d = state.data;
  const rows = [];
  const known = new Set(((d && d.history) || []).map((r) => r.txid));
  for (const p of state.pending) {
    if (known.has(p.txid)) continue;      // it landed, the index has it now
    const amount = Number(p.amount || 0);
    rows.push({ dir: "out", amount, pending: true, txid: p.txid, ts: p.ts, height: null, block: "" });
  }
  for (const h of ((d && d.history) || [])) {
    // amount is what left/entered the wallet, never the size of the coin that was
    // spent: a 0.1 payment out of a 1 NEB coin is 0.1, not 1.
    const dir = h.paid > 0 ? "out" : h.received > 0 && h.spent === 0 ? "in" : h.self ? "self" : h.net >= 0 ? "in" : "out";
    const amount = dir === "out" ? h.paid : dir === "in" ? (h.spent ? Math.max(0, h.net) : h.received) : 0;
    rows.push({
      dir, amount, fee: h.fee || 0,
      txid: h.txid, ts: (h.time || 0) * 1000, height: h.height, block: h.block || "",
      conf: h.confirmations, net: h.net,
    });
  }
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  list.textContent = "";
  $("h-empty").classList.toggle("hidden", rows.length > 0);

  for (const r of rows.slice(0, 200)) {
    const div = document.createElement("div");
    div.className = "item click";
    const sign = r.dir === "in" ? "+" : r.dir === "out" ? "−" : "";
    const amt = document.createElement("span");
    amt.className = r.dir === "in" ? "in" : r.dir === "out" ? "out" : "muted";
    amt.textContent = r.dir === "self"
      ? `${t("h_fee_short")} ${formatAmount(r.fee || 0)} NEB`
      : `${sign}${formatAmount(r.amount)} NEB`;
    const dir = document.createElement("span");
    dir.className = "muted";
    dir.textContent = r.pending ? t("pending") : r.dir === "in" ? t("in") : r.dir === "out" ? t("out") : t("h_self");
    div.append(amt, dir);

    if (r.height !== null && r.height !== undefined) {
      const hh = document.createElement("span");
      hh.className = "muted mono";
      hh.textContent = `#${r.height}`;
      div.appendChild(hh);
      const bl = document.createElement("span");
      bl.className = "muted mono";
      bl.textContent = shortHash(r.block);
      bl.title = r.block || "";
      div.appendChild(bl);
    }
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = r.ts ? new Date(r.ts).toLocaleString(lang === "zh" ? "zh-CN" : "en-US") : "";
    when.title = r.txid;
    div.appendChild(when);
    div.onclick = () => showTx(r);
    list.appendChild(div);
  }
}

async function showTx(r) {
  const rows = [
    [t("h_dir"), r.pending ? t("pending") : r.dir === "in" ? t("in") : r.dir === "out" ? t("out") : t("h_self")],
    [t("f_amount"), `${r.dir === "in" ? "+" : r.dir === "out" ? "−" : ""}${formatAmount(r.amount)} NEB`],
  ];
  if (r.fee && r.dir !== "in") rows.push([t("f_fee"), formatAmount(r.fee) + " NEB"]);
  rows.push(
    [t("h_height"), r.height === null || r.height === undefined ? t("h_none") : String(r.height)],
    [t("h_conf"), r.conf === undefined ? t("h_none") : String(r.conf)],
    [t("h_block"), r.block || t("h_none"), true],
    [t("h_tx"), r.txid, true],
  );
  await askConfirm({ title: t("h_detail"), rows, ok: t("h_close"), single: true });
}

async function refreshPending() {
  if (!state.pending.length) return;
  const keep = [];
  for (const p of state.pending) {
    try {
      const doc = await fetchTx(p.txid);
      if (!doc) keep.push(p);              // still in the mempool or not yet indexed
    } catch (err) {
      keep.push(p);
    }
  }
  if (keep.length !== state.pending.length) {
    state.pending = keep;
    localStorage.setItem("neb.pending", JSON.stringify(keep));
  }
}

// ------------------------------------------------------------------ actions
function fail(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 6000);
}

function ok(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.remove("hidden", "err");
  el.classList.add("ok");
}

async function copy(text) {
  // navigator.clipboard can stay pending when the page is not focused or the
  // click is not an activation (automation, some in-app browsers), and that
  // used to leave the button stuck. Race it, then fall back to a selection.
  try {
    const writing = navigator.clipboard.writeText(text);
    await Promise.race([
      writing,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 600)),
    ]);
    return true;
  } catch (err) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch (err2) {
      return false;
    }
  }
}

function lockNow() {
  state.secret = null;
  state.data = null;
  stopPoll();
  home();
}

async function doCreate() {
  const pass = $("c-pass").value;
  const pass2 = $("c-pass2").value;
  if (pass.length < 8) return fail("c-err", t("err_pass_short"));
  if (pass !== pass2) return fail("c-err", t("err_pass_mismatch"));
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const address = await store.create(pass, secret);
  state.secret = secret;
  state.address = address;
  state.watchOnly = false;
  await showBackup(secret, address);
}

function showBackup(secret, address) {
  const key = toHex(secret);
  const view = $("view-create");
  view.textContent = "";
  const box = document.createElement("div");
  box.className = "card";
  const heading = document.createElement("h2");
  heading.textContent = t("backup_title");
  const warning = document.createElement("p");
  warning.className = "warn";
  warning.textContent = t("backup_body");
  const field = (label, value) => {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const l = document.createElement("label");
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "addr";
    v.textContent = value;
    wrap.append(l, v);
    return wrap;
  };
  const keyField = field(t("f_secret"), key);
  keyField.querySelector(".addr").style.color = "var(--g)";
  const row = document.createElement("div");
  row.className = "row";
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn";
  copyBtn.textContent = t("r_copy");
  copyBtn.onclick = () => copy(address);
  const copyKey = document.createElement("button");
  copyKey.className = "btn";
  copyKey.textContent = t("reveal");
  copyKey.onclick = () => copy(key);
  const done = document.createElement("button");
  done.className = "btn primary";
  done.textContent = "→";
  done.onclick = () => { view.textContent = ""; openWallet(); };
  row.append(copyBtn, copyKey, done);
  box.append(heading, warning, field(t("f_address"), address), keyField, row);
  view.appendChild(box);
}

async function doImport() {
  const raw = $("i-secret").value.trim().toLowerCase().replace(/^0x/, "");
  const pass = $("i-pass").value;
  const pass2 = $("i-pass2").value;
  if (!/^[0-9a-f]{64}$/.test(raw)) return fail("i-err", t("err_secret"));
  if (pass.length < 8) return fail("i-err", t("err_pass_short"));
  if (pass !== pass2) return fail("i-err", t("err_pass_mismatch"));
  const secret = fromHex(raw);
  const address = await store.create(pass, secret);
  state.secret = secret;
  state.address = address;
  state.watchOnly = false;
  $("i-secret").value = "";
  $("i-pass").value = "";
  $("i-pass2").value = "";
  openWallet();
}

function doWatch() {
  const address = $("wt-addr").value.trim();
  try {
    decodeAddress(address);
  } catch (err) {
    return fail("wt-err", t("err_addr"));
  }
  store.setWatch(address);
  state.watchOnly = true;
  state.address = address;
  openWallet();
}

async function doUnlock() {
  const pass = $("u-pass").value;
  try {
    state.secret = await store.unlock(pass);
    state.address = store.address();
    state.watchOnly = false;
    $("u-pass").value = "";
    touchIdle();
    openWallet();
  } catch (err) {
    fail("u-err", lang === "zh" ? "密码不对" : "Wrong password");
  }
}

// window.confirm() is blocked outright in some in-app browsers and shows the user a
// raw string on the one screen that has to be read carefully. Same check, better shape.
function askConfirm({ title, rows = [], text = "", ok = t("cf_ok"), single = false, copy: copyWhat = null }) {
  return new Promise((resolve) => {
    const box = $("cf");
    $("cf-t").textContent = title;
    const body = $("cf-b");
    body.textContent = "";
    if (text) {
      const p = document.createElement("div");
      p.textContent = text;
      body.appendChild(p);
    }
    rows.forEach(([k, v, mono]) => {
      const row = document.createElement("div");
      row.className = "cf-row";
      const ka = document.createElement("span");
      ka.textContent = k;
      const vb = document.createElement("b");
      vb.textContent = v;
      if (mono) { vb.classList.add("cf-mono"); row.classList.add("stack"); }
      row.append(ka, vb);
      body.appendChild(row);
    });
    $("cf-no").textContent = t("cf_no");
    $("cf-no").style.display = single ? "none" : "";   // [hidden] loses to .btn{display:inline-flex}
    const cb = $("cf-copy");
    cb.style.display = copyWhat ? "" : "none";
    if (copyWhat) {
      cb.textContent = copyWhat.label;
      cb.onclick = () => { copy(copyWhat.value); cb.textContent = t("copied"); };
    }
    $("cf-yes").textContent = ok;
    box.hidden = false;
    const close = (answer) => {
      box.hidden = true;
      $("cf-yes").onclick = null;
      $("cf-no").onclick = null;
      resolve(answer);
    };
    $("cf-yes").onclick = () => close(true);
    $("cf-no").onclick = () => close(false);
  });
}

function askInput({ title, label, ok, error = "" }) {
  return new Promise((resolve) => {
    const box = $("cf");
    $("cf-t").textContent = title;
    const body = $("cf-b");
    body.textContent = "";
    const row = document.createElement("div");
    row.className = "cf-row stack";
    const ka = document.createElement("span");
    ka.textContent = label;
    row.appendChild(ka);
    body.appendChild(row);
    const wrap = $("cf-in");
    wrap.hidden = false;
    const input = $("cf-input");
    input.value = "";
    input.type = "password";
    $("cf-err").textContent = error;
    $("cf-no").style.display = "";
    $("cf-no").textContent = t("cf_no");
    $("cf-yes").textContent = ok;
    $("cf-copy").style.display = "none";
    box.hidden = false;
    setTimeout(() => input.focus(), 30);
    const done = (value) => {
      box.hidden = true;
      wrap.hidden = true;
      $("cf-yes").onclick = null;
      $("cf-no").onclick = null;
      input.onkeydown = null;
      resolve(value);
    };
    $("cf-yes").onclick = () => done(input.value);
    $("cf-no").onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === "Enter") done(input.value); };
  });
}

function showKey(secret) {
  askConfirm({
    title: t("ex_title"),
    text: t("ex_warn"),
    rows: [[t("f_address"), state.address, true],
           [t("f_secret"), toHex(secret), true]],
    ok: t("h_close"), single: true,
    copy: { label: t("ex_copy"), value: toHex(secret) },
  });
}

async function doSend() {
  if (!state.secret) return fail("s-msg", t("err_locked"));
  let toLock;
  try {
    toLock = lockOfAddress($("s-to").value.trim());
  } catch (err) {
    return fail("s-msg", t("err_addr"));
  }
  let amount;
  let fee;
  try { amount = parseAmount($("s-amount").value); } catch (err) { return fail("s-msg", t("err_amount")); }
  try { fee = parseAmount($("s-fee").value || "0.0001"); } catch (err) { return fail("s-msg", t("err_fee")); }
  if (amount <= 0n) return fail("s-msg", t("err_amount"));

  const d = state.data || (await fetchAddress(state.address));
  const changeLock = decodeAddress(state.address);
  const built = buildPayment({
    utxos: d.utxos || [], changeLock, toLock, amount, fee, secret: state.secret,
  });
  if (built.error === "insufficient") {
    return fail("s-msg", `${t("err_insufficient")} (${formatAmount(built.available)} / ${formatAmount(built.need)} NEB)`);
  }
  const short = state.address.slice(0, 14) + "…" + state.address.slice(-6);
  const to = $("s-to").value.trim();
  const go = await askConfirm({
    title: t("confirm_send"),
    rows: [
      [t("f_to"), to, true],
      [t("f_amount"), formatAmount(amount) + " NEB"],
      [t("f_fee"), formatAmount(fee) + " NEB"],
      [t("cf_inputs"), String(built.inputs)],
      [t("a_kick"), short, true],
    ],
  });
  if (!go) return;
  try {
    $("s-go").disabled = true;
    const id = await broadcast(built.hex);
    state.pending.push({ txid: id, amount: String(amount), ts: Date.now() });
    localStorage.setItem("neb.pending", JSON.stringify(state.pending));
    ok("s-msg", `${t("sent")}: ${id}`);
    $("s-amount").value = "";
    $("s-to").value = "";
    renderHistory();
    setTimeout(loadData, 3000);
  } catch (err) {
    fail("s-msg", String(err.message || err));
  } finally {
    $("s-go").disabled = false;
  }
}

// ------------------------------------------------------------------ idle lock
function touchIdle() {
  state.idleAt = Date.now();
}

function checkIdle() {
  if (!state.secret) return;
  if (Date.now() - state.idleAt > IDLE_MS) lockNow();
}

// ------------------------------------------------------------------ wiring
function init() {
  applyLang();
  document.querySelectorAll(".lang button").forEach((b) => {
    b.onclick = () => { lang = b.dataset.lang; localStorage.setItem("nebpool-lang", lang); applyLang(); };
  });
  // the header is the pool's, so its search box has to work here too
  const runSearch = () => {
    const q = $("q").value.trim();
    if (q) location.href = "/?q=" + encodeURIComponent(q);
  };
  $("qbtn").onclick = runSearch;
  $("q").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

  $("go-create").onclick = () => show("view-create");
  $("go-import").onclick = () => show("view-import");
  $("go-watch").onclick = () => show("view-watch");
  $("c-back").onclick = home;
  $("i-back").onclick = home;
  $("wt-back").onclick = home;
  $("c-go").onclick = doCreate;
  $("i-go").onclick = doImport;
  $("wt-go").onclick = doWatch;
  $("u-go").onclick = doUnlock;
  $("u-pass").onkeydown = (e) => { if (e.key === "Enter") doUnlock(); };

  $("a-key").onclick = async () => {
    if (!state.secret) return;
    // the key is the wallet: prove you are the owner before it is on screen,
    // even though the session is already unlocked
    let pass = await askInput({ title: t("key_pass_title"), label: t("key_pass_label"), ok: t("key_pass_ok") });
    while (pass !== null) {
      let secret = null;
      try { secret = await store.unlock(pass); } catch (err) { secret = null; }
      if (secret) { showKey(secret); return; }
      pass = await askInput({ title: t("key_pass_title"), label: t("key_pass_label"),
                              ok: t("key_pass_ok"), error: t("key_pass_bad") });
    }
  };
  $("a-copy").onclick = () => {
    const b = $("a-copy");
    const was = b.dataset.label || b.textContent;
    b.dataset.label = was;
    b.textContent = t("copied");
    setTimeout(() => { b.textContent = b.dataset.label; }, 1400);
    copy(state.address);
  };
  $("a-lock").onclick = lockNow;
  $("a-forget").onclick = async () => {
    const msg = lang === "zh"
      ? "删除后本机不再保存这个钱包，只能靠私钥重新导入。确定？"
      : "This removes the wallet from this browser. You will need the key to restore it. Continue?";
    const goDel = await askConfirm({ title: t("cf_delete"), text: msg, ok: t("cf_delete") });
    if (!goDel) return;
    store.remove();
    lockNow();
  };
  $("u-forget").onclick = $("a-forget").onclick;

  $("tab-send").onclick = () => switchTab("send");
  $("tab-receive").onclick = () => switchTab("receive");
  $("tab-history").onclick = () => switchTab("history");
  $("s-go").onclick = doSend;
  $("s-max").onclick = () => {
    const d = state.data;
    if (!d) return;
    const fee = (() => { try { return parseAmount($("s-fee").value || "0.0001"); } catch { return 0n; } })();
    const all = BigInt(d.balance) - fee;
    $("s-amount").value = all > 0n ? formatAmount(all) : "0";
  };
  $("r-copy").onclick = () => copy(state.address);
  $("h-refresh").onclick = loadData;

  for (const ev of ["mousemove", "keydown", "click", "touchstart"]) {
    document.addEventListener(ev, touchIdle, { passive: true });
  }
  setInterval(checkIdle, 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.secret) lockNow();
  });

  showBuildHash();
  home();
}

function switchTab(which) {
  const map = { send: "pane-send", receive: "pane-receive", history: "pane-history" };
  for (const [k, id] of Object.entries(map)) {
    $(id).classList.toggle("hidden", k !== which);
    $("tab-" + k).classList.toggle("on", k === which);
  }
}

/** The page shows the SHA-256 of the exact script it is running, so a user can
 *  compare it with the published build without trusting what we say. */
async function showBuildHash() {
  try {
    const buf = await (await fetch("/wallet/app.js", { cache: "no-store" })).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    $("build-hash").textContent = `${t("build")} ${hex.slice(0, 16)}…`;
    $("build-hash").title = hex;
  } catch (err) {
    $("build-hash").textContent = "";
  }
}

init();

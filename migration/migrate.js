// The wallet moved from argonpool.com/wallet to wallet.argonpool.com so that
// nothing on the pool pages shares a browser origin with it. Re-importing a key
// on every user is not acceptable, so this page hands the encrypted keystore to
// the new origin through the URL fragment: a fragment is never sent to a server,
// and the blob is ciphertext that only the user's password opens.
(function () {
  var NEW = "https://wallet.argonpool.com/";
  var WALLET = "neb.wallet.v1";
  var WATCH = "neb.watch.v1";
  var PENDING = "neb.pending";
  var LANG = "nebpool-lang";

  var en = localStorage.getItem(LANG) === "en";
  var T = en
    ? {
        h: "The wallet has moved",
        b1: "It now lives at wallet.argonpool.com — same site, separate origin, so a problem on the pool pages cannot reach it.",
        b2: "Nothing else changes: same key, same balance, same password. Your key never leaves this browser.",
        go: "Continue",
        cd: function (n) { return "Continuing in " + n + "s…"; },
        fh: "Could not move the wallet",
        fp: "Go back to argonpool.com/wallet and try again, or import your 64-character key on the new address.",
        fa: "Open wallet.argonpool.com",
        esc: "Can't reach the new address? Keep using the old page",
      }
    : {
        h: "钱包已搬到新地址",
        b1: "新地址是 wallet.argonpool.com —— 同一个网站、独立源，矿池页面上的任何问题都碰不到它。",
        b2: "其他都不变：同一个私钥、同样的余额、原来的密码。密钥不会离开这个浏览器。",
        go: "继续",
        cd: function (n) { return n + " 秒后自动继续…"; },
        fh: "钱包没能搬过来",
        fp: "请回到 argonpool.com/wallet 再试一次，或者在新地址用你的 64 位私钥重新导入。",
        fa: "前往 wallet.argonpool.com",
        esc: "打不开新地址？用旧页面继续",
      };

  function q(name) {
    return new URLSearchParams(location.search).get(name);
  }

  // came back from the new origin after it confirmed the copy landed
  if (q("done") === "1") {
    [WALLET, WATCH, PENDING].forEach(function (k) { localStorage.removeItem(k); });
    location.replace(NEW);
    return;
  }

  if (q("failed") === "1") {
    document.getElementById("f-h").textContent = T.fh;
    document.getElementById("f-p").textContent = T.fp;
    document.getElementById("f-a").textContent = T.fa;
    document.getElementById("card").className = "hide";
    document.getElementById("fail").className = "";
    return;
  }

  var payload = {
    w: localStorage.getItem(WALLET),
    k: localStorage.getItem(WATCH),
    p: localStorage.getItem(PENDING),
    l: localStorage.getItem(LANG),
  };

  // nothing to carry over: a watch-only visitor or a fresh browser
  if (!payload.w && !payload.k) {
    location.replace(NEW);
    return;
  }

  var b64;
  try {
    b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (err) {
    location.replace(NEW);
    return;
  }

  var target = NEW + "#migrate=" + b64;
  var left = 5;
  var timer = null;

  function go() {
    if (timer) clearInterval(timer);
    location.replace(target);
  }

  document.getElementById("t-h").textContent = T.h;
  document.getElementById("t-b1").textContent = T.b1;
  document.getElementById("t-b2").textContent = T.b2;
  document.getElementById("go").textContent = T.go;
  // some networks (a fake-ip proxy is the usual suspect) cannot reach a domain
  // they have never seen, and being locked out of a wallet is worse than being
  // left on the old origin, so keep a door open
  document.getElementById("esc").textContent = T.esc;
  document.getElementById("cd").textContent = T.cd(left);
  document.getElementById("card").className = "";
  document.getElementById("go").addEventListener("click", go);

  // a redirect nobody asked for looks like an attack, so say what is happening and
  // give the way out; the countdown keeps people who ignore it from getting stuck
  timer = setInterval(function () {
    left -= 1;
    if (left <= 0) {
      go();
      return;
    }
    document.getElementById("cd").textContent = T.cd(left);
  }, 1000);
})();

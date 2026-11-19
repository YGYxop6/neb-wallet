// The wallet moved from argonpool.com/wallet to wallet.argonpool.com so that
// nothing on the pool pages shares a browser origin with it. Re-importing a key
// on every user is not acceptable, so this page hands the encrypted keystore to
// the new origin through the URL fragment: a fragment is never sent to a server,
// and the blob is ciphertext that only the user's password opens.
//
// It also checks the new origin before travelling. A proxy running fake-ip DNS
// hands back a dead connection for a hostname it has never seen, and landing
// someone on ERR_CONNECTION_CLOSED with no way back is worse than not moving them
// at all, so an unreachable origin keeps the visitor here instead of stranding them.
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
        check: "Checking the new address…",
        cd: function (n) { return "Continuing in " + n + "s…"; },
        uh: "Cannot reach the new address",
        up: "Your key is still in this browser and nothing has been moved. This is usually a proxy or DNS problem on your side — retry, or keep using the page here.",
        retry: "Retry",
        esc: "Keep using the old page",
        escNote: "If you already moved your wallet, the old page will look empty — that is expected.",
        fh: "Could not move the wallet",
        fp: "Go back to argonpool.com/wallet and try again, or import your 64-character key on the new address.",
        fa: "Open wallet.argonpool.com",
      }
    : {
        h: "钱包已搬到新地址",
        b1: "新地址是 wallet.argonpool.com —— 同一个网站、独立源，矿池页面上的任何问题都碰不到它。",
        b2: "其他都不变：同一个私钥、同样的余额、原来的密码。密钥不会离开这个浏览器。",
        go: "继续",
        check: "正在检查新地址…",
        cd: function (n) { return n + " 秒后自动继续…"; },
        uh: "新地址连不上",
        up: "你的密钥还在这个浏览器里，什么都没动。通常是本机代理或 DNS 的问题 —— 可以重试，或者先在这里继续用。",
        retry: "重试",
        esc: "用旧页面继续",
        escNote: "如果你之前已经迁移过，旧页面看起来是空的，这是正常的。",
        fh: "钱包没能搬过来",
        fp: "请回到 argonpool.com/wallet 再试一次，或者在新地址用你的 64 位私钥重新导入。",
        fa: "前往 wallet.argonpool.com",
      };

  function q(name) {
    return new URLSearchParams(location.search).get(name);
  }
  function $(id) { return document.getElementById(id); }

  // came back from the new origin after it confirmed the copy landed
  if (q("done") === "1") {
    [WALLET, WATCH, PENDING].forEach(function (k) { localStorage.removeItem(k); });
    location.replace(NEW);
    return;
  }

  if (q("failed") === "1") {
    $("f-h").textContent = T.fh;
    $("f-p").textContent = T.fp;
    $("f-a").textContent = T.fa;
    $("card").className = "hide";
    $("fail").className = "";
    return;
  }

  var payload = {
    w: localStorage.getItem(WALLET),
    k: localStorage.getItem(WATCH),
    p: localStorage.getItem(PENDING),
    l: localStorage.getItem(LANG),
  };
  var hasKey = !!(payload.w || payload.k);

  var b64 = "";
  if (hasKey) {
    try {
      b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (err) {
      b64 = "";
    }
  }

  // probe URL, overridable for testing
  var probeUrl = q("probe") || NEW + "ping.txt";
  var probeState = null; // null = pending, true = reachable, false = not

  function probe(cb) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      cb(false);
    }, 2500);
    fetch(probeUrl, { mode: "no-cors", cache: "no-store" })
      .then(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cb(true);
      })
      .catch(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cb(false);
      });
  }

  function showUnreachable() {
    $("card").className = "hide";
    $("say").className = "";
    $("say-h").textContent = T.uh;
    $("say-p").textContent = T.up;
    $("retry").textContent = T.retry;
    $("retry").onclick = function () {
      $("say").className = "hide";
      $("card").className = "";
      start();
    };
    $("esc2").textContent = T.esc;
    $("esc-note").textContent = hasKey ? T.escNote : "";
    if (!hasKey) $("esc-wrap").className = "hide";
    // a hit here is the only way to find out how many visitors a broken proxy
    // costs us; it carries nothing but a timestamp
    try { fetch("/wallet/no-route?t=" + Date.now(), { cache: "no-store" }).catch(function () {}); } catch (err) {}
  }

  var target = NEW + (b64 ? "#migrate=" + b64 : "");
  var timer = null;

  function go() {
    if (timer) clearInterval(timer);
    if (probeState === false) { showUnreachable(); return; }
    location.replace(target);
  }

  function start() {
    if (!hasKey) {
      // nothing to carry over: a watch-only visitor or a fresh browser
      $("card").className = "hide";
      $("cd").textContent = T.check;
      probe(function (ok) {
        probeState = ok;
        if (ok) location.replace(NEW);
        else showUnreachable();
      });
      return;
    }

    $("t-h").textContent = T.h;
    $("t-b1").textContent = T.b1;
    $("t-b2").textContent = T.b2;
    $("go").textContent = T.go;
    $("esc").textContent = T.esc;
    $("cd").textContent = T.check;
    $("card").className = "";
    $("go").onclick = go;

    var left = 5;
    probe(function (ok) {
      probeState = ok;
      if (!ok) { showUnreachable(); return; }
      $("cd").textContent = T.cd(left);
      timer = setInterval(function () {
        left -= 1;
        if (left <= 0) { go(); return; }
        $("cd").textContent = T.cd(left);
      }, 1000);
    });
  }

  start();
})();

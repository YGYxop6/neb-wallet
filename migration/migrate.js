// The wallet lives at wallet.argonpool.com now, but every ad, bookmark and post
// still points at /wallet/. This page is the door between the two and it must
// never stand in the way: a visitor without a key is sent straight through, and a
// visitor whose network cannot reach the new origin gets the same wallet served
// from here instead of a message. The only thing worth a pause is a stored key,
// because that is the one case where moving it is the point.
(function () {
  var NEW = "https://wallet.argonpool.com/";
  var LOCAL = "/wallet/legacy.html";
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
        opening: "Opening the wallet…",
        cd: function (n) { return "Continuing in " + n + "s…"; },
        esc: "Open the page here instead",
        fh: "Could not move the wallet",
        fp: "Go back to argonpool.com/wallet and try again, or import your 64-character key on the new address.",
        fa: "Open wallet.argonpool.com",
      }
    : {
        h: "钱包已搬到新地址",
        b1: "新地址是 wallet.argonpool.com —— 同一个网站、独立源，矿池页面上的任何问题都碰不到它。",
        b2: "其他都不变：同一个私钥、同样的余额、原来的密码。密钥不会离开这个浏览器。",
        go: "继续",
        opening: "正在打开钱包…",
        cd: function (n) { return n + " 秒后自动继续…"; },
        esc: "在这里打开钱包",
        fh: "钱包没能搬过来",
        fp: "请回到 argonpool.com/wallet 再试一次，或者在新地址用你的 64 位私钥重新导入。",
        fa: "前往 wallet.argonpool.com",
      };

  function q(name) {
    try { return new URLSearchParams(location.search).get(name); } catch (err) { return null; }
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

  var probeUrl = q("probe") || NEW + "ping.txt";

  // Is the new origin actually there? A proxy that has never seen the hostname can
  // answer with a dead connection, and that costs one second here instead of
  // dropping the visitor on an error page with no way back.
  function probe(ms, cb) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      cb(false);
    }, ms);
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

  function here() {
    location.replace(LOCAL);
  }

  // No key on this browser: nothing to carry, nothing to warn about. Ad traffic
  // lands here and should see a wallet, not a notice.
  if (!hasKey) {
    $("card").className = "hide";
    $("say").className = "";
    $("say-p").textContent = T.opening;
    probe(1200, function (ok) {
      if (ok) location.replace(NEW);
      else here();
    });
    return;
  }

  var target = NEW + (b64 ? "#migrate=" + b64 : "");
  var timer = null;
  var left = 3;

  function go() {
    if (timer) clearInterval(timer);
    location.replace(target);
  }

  $("t-h").textContent = T.h;
  $("t-b1").textContent = T.b1;
  $("t-b2").textContent = T.b2;
  $("go").textContent = T.go;
  $("esc").textContent = T.esc;
  $("cd").textContent = T.opening;
  $("card").className = "";
  $("go").onclick = go;

  probe(2500, function (ok) {
    // unreachable: the key stays where it is and the same wallet opens from here,
    // so a broken network costs nothing
    if (!ok) { here(); return; }
    $("cd").textContent = T.cd(left);
    timer = setInterval(function () {
      left -= 1;
      if (left <= 0) { go(); return; }
      $("cd").textContent = T.cd(left);
    }, 1000);
  });
})();

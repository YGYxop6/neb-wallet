#!/usr/bin/env python3
"""RackNerd 自愈看护 —— 检查 systemd 修不了的那类故障。

设计目的（不是重复 systemd 的 Restart=）：
  * 端口被孤儿/重复进程占着，导致 systemd 管理的单元无限崩溃循环
    （2026-08-31 ~ 09-13 的 frps 实例：崩溃 192026 次，11 天无人发现）
  * 单元在重启循环里偷偷烧 CPU / 刷日志
  * 单元彻底 failed / 停止
  * 磁盘、内存见底
只在状态「变化」时发 TG 告警，避免刷屏。

用法:
  watchdog.py            # 正常巡检一次（给 systemd timer 调）
  watchdog.py --dry-run  # 只打印，不发 TG
  watchdog.py --test-alert  # 发一条测试告警，验证 TG 通不通
  watchdog.py --status   # 打印当前状态文件
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE, "state.json")
LOG_FILE = os.path.join(BASE, "watchdog.log")

# 被看护的单元: (scope, unit, 期望监听的端口 or None)
WATCH_UNITS = [
    ("system", "frps.service", 7000),
    ("system", "prl-bot.service", None),
    ("system", "docker.service", None),
    ("user", "hermes-gateway.service", None),
    ("system", "neb-node.service", 3440),
    ("system", "nebpool.service", None),
]

# 进程特征 -> 名字。用于发现「systemd 之外还有一份同名进程在跑」
WATCH_PROCS = [
    ("frps", r"/usr/local/bin/frps"),
    ("hermes-gateway", r"hermes_cli\.main gateway"),
    ("prl-bot", r"prl_bot\.py"),
    ("neb-node", r"/opt/neb-node/neb-node"),
    ("nebpool", r"/opt/nebpool/pool\.py"),
]

ARGNODE_COOKIE = "/root/ab/rt-main/rpc.cookie"
ARGNODE_RPC = "http://127.0.0.1:9332"
CHAIN_ALERT_MIN = 30    # 高度一动不动超过这么久 -> 告警
CHAIN_RESTART_MIN = 45  # 再不动 -> 自动重启节点

DISK_LIMIT_PCT = 85
MEM_MIN_MB = 150
RESTART_DELTA_LIMIT = 0  # 任何新增重启都算异常

TOKEN_CONF = "/root/.config/systemd/user/hermes-gateway.service.d/telegram.conf"


def log(msg: str) -> None:
    line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def run(cmd: list[str], timeout: int = 15, env: dict | None = None) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return (p.stdout or "") + (p.stderr or "")
    except Exception as exc:  # noqa: BLE001
        return f"__ERR__ {exc}"


def user_scope_env() -> dict:
    """从 system 级 unit 里调 `systemctl --user` 必须补上这两个变量。

    否则会静默拿不到用户级单元（ActiveState=None），把「查不到」误报成「服务挂了」
    —— 实测过：不补就会每 2 分钟发一次假告警。
    """
    env = dict(os.environ)
    runtime = f"/run/user/{os.getuid()}"
    env.setdefault("XDG_RUNTIME_DIR", runtime)
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={runtime}/bus")
    return env


def load_telegram_creds() -> tuple[str, str]:
    """从 gateway 的 drop-in 里读 token / chat id —— 不复制密钥、不打印。"""
    token = chat = ""
    try:
        with open(TOKEN_CONF, encoding="utf-8") as fh:
            text = fh.read()
        m = re.search(r'TELEGRAM_BOT_TOKEN=([^"\s]+)', text)
        if m:
            token = m.group(1)
        m = re.search(r'TELEGRAM_ALLOWED_USERS=([^"\s,]+)', text)
        if m:
            chat = m.group(1)
    except OSError:
        pass
    if not chat:
        for path in ("/root/.hermes/.env",):
            try:
                with open(path, encoding="utf-8") as fh:
                    m = re.search(r"^TELEGRAM_HOME_CHANNEL=([^\"'\s]+)", fh.read(), re.M)
                if m:
                    chat = m.group(1)
                    break
            except OSError:
                continue
    return token, chat


def send_telegram(text: str) -> bool:
    token, chat = load_telegram_creds()
    if not token or not chat:
        log("TG 发送失败: 取不到 token 或 chat id")
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode(
        {"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true"}
    ).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=20) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as exc:
        log(f"TG 发送 HTTPError {exc.code}: {exc.read()[:200]!r}")
    except Exception as exc:  # noqa: BLE001
        log(f"TG 发送异常: {exc}")
    return False


def unit_facts(scope: str, unit: str) -> dict:
    sysctl = ["systemctl"] + (["--user"] if scope == "user" else [])
    env = user_scope_env() if scope == "user" else None
    shown = run(sysctl + ["show", unit, "-p", "ActiveState", "-p", "SubState",
                          "-p", "NRestarts", "-p", "MainPID", "-p", "ActiveEnterTimestamp"], env=env)
    facts: dict = {"scope": scope, "unit": unit}
    for line in shown.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            facts[k.strip()] = v.strip()
    facts["LoadState"] = facts["loadstate"] = run(sysctl + ["show", unit, "-p", "LoadState"], env=env).split("=")[-1].strip()
    return facts


def port_owner(port: int) -> tuple[int | None, str]:
    """返回占用端口的 PID 和进程名。"""
    out = run(["ss", "-tlnp", f"sport = :{port}"])
    if "__ERR__" in out or not out.strip():
        return None, ""
    m = re.search(r'users:\(\("([^"]+)",pid=(\d+)', out)
    if m:
        return int(m.group(2)), m.group(1)
    return None, ""


def procs_matching(pattern: str) -> list[tuple[int, int]]:
    """[(pid, ppid), ...]"""
    out = run(["ps", "-eo", "pid=,ppid=,args="])
    hits = []
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        pid_s, ppid_s, args = parts
        if re.search(pattern, args) and "watchdog.py" not in args:
            try:
                hits.append((int(pid_s), int(ppid_s)))
            except ValueError:
                continue
    return hits


def node_rpc(method: str, params: list | None = None):
    """直连节点 RPC（cookie 每次读，节点重启会换 cookie）。"""
    try:
        with open(ARGNODE_COOKIE, encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError:
        return None
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                       "params": params or []}).encode()
    req = urllib.request.Request(
        ARGNODE_RPC, data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode()).get("result")
    except Exception:  # noqa: BLE001
        return None


def check_chain(problems: list, detail: dict) -> dict:
    """高度有没有前进。卡住 30 分钟告警，45 分钟自动重启节点。

    卡住时不能每 2 分钟喊一次：告警文案里不要放分钟数，否则去重失效。
    """
    now = time.time()
    prev = prev_state()
    out = {
        "chain_height": prev.get("chain_height"),
        "chain_since": prev.get("chain_since"),
        "chain_restarted": bool(prev.get("chain_restarted")),
    }
    info = node_rpc("getblockchaininfo")
    if not isinstance(info, dict) or "blocks" not in info:
        problems.append("⛓ 节点 RPC 无响应（getblockchaininfo 失败）")
        detail["chain"] = {"rpc": "down"}
        return out

    height = int(info.get("blocks") or 0)
    detail["chain"] = {"height": height, "best": str(info.get("bestblockhash", ""))[:16]}
    last = prev.get("chain_height")
    since = float(prev.get("chain_since") or now)

    if last is None or height > int(last):
        since = now
        out["chain_restarted"] = False
    else:
        stuck_min = (now - since) / 60.0
        detail["chain"]["stalled_min"] = round(stuck_min, 1)
        if stuck_min >= CHAIN_ALERT_MIN:
            extra = ""
            if stuck_min >= CHAIN_RESTART_MIN and not out["chain_restarted"]:
                run(["systemctl", "restart", "argnode.service"])
                out["chain_restarted"] = True
                extra = "，已自动重启节点"
                log(f"链卡在高度 {height} 已 {stuck_min:.0f} 分钟，重启 argnode")
            problems.append(
                f"⛓ 区块高度卡在 <b>{height}</b> 超过 {CHAIN_ALERT_MIN} 分钟{extra}"
                " —— 邻居可能全断了，池子会一直发过期模板"
            )

    out["chain_height"], out["chain_since"] = height, since
    return out


POOL_BLOCKS = "/root/ab/pool-data/blocks.jsonl"


def check_pool_blocks(problems: list, detail: dict) -> dict:
    """本池出块数量变化 -> 立刻发 TG（出块和出块失败都算）。"""
    prev = prev_state()
    try:
        rows = [json.loads(l) for l in open(POOL_BLOCKS, encoding="utf-8") if l.strip()]
    except (OSError, json.JSONDecodeError):
        rows = []
    count = len(rows)
    failed = sum(1 for r in rows if not r.get("ok", True))
    detail["pool_blocks"] = {"count": count, "failed": failed}

    prev_count = int(prev.get("pool_block_count") or 0)
    if count > prev_count:
        new = rows[prev_count:]
        for r in new:
            h = r.get("h", "?")
            reward = r.get("reward", 0)
            try:
                reward_s = f"{float(reward) / 1e8:.4f} ARG"
            except (TypeError, ValueError):
                reward_s = f"{reward}"
            if r.get("ok", True):
                send_telegram(
                    f"🎉 <b>本池出块</b>\n高度 <b>{h}</b>\n"
                    f"奖励 {reward_s}（已扣 {r.get('fee', 0)} 池费）\n"
                    f"出块矿工 <code>{str(r.get('worker', ''))[:20]}…</code>\n"
                    "100 块确认后计入余额，下次整点支付。"
                )
                log(f"出块通知: height {h} ok")
            else:
                problems.append(f"🧱 出块 <b>{h}</b> 被节点拒绝，奖励没进账")
                log(f"出块失败: height {h}")
    return {"pool_block_count": count}


def collect() -> dict:
    problems: list[str] = []
    detail: dict = {"units": {}, "disk": {}, "mem": {}}

    for scope, unit, port in WATCH_UNITS:
        f = unit_facts(scope, unit)
        detail["units"][f"{scope}:{unit}"] = {
            "active": f.get("ActiveState"),
            "sub": f.get("SubState"),
            "nrestarts": f.get("NRestarts"),
            "mainpid": f.get("MainPID"),
        }
        if f.get("loadstate") == "not-found":
            continue  # 这台机器上没装，不算故障
        # 「查不到」既不是正常也不是挂了 —— 必须单独报出来，否则会被误当成服务宕机
        if f.get("ActiveState") in (None, "", "unknown") or f.get("loadstate") in (None, "", "unknown"):
            problems.append(
                f"❓ 无法查询 <b>{unit}</b> 的状态（systemd 实例不可达）"
                f" —— 这是看护自身的问题，不是服务挂了"
            )
            continue
        if f.get("ActiveState") != "active":
            problems.append(
                f"❌ <b>{unit}</b> 不是 active（{f.get('ActiveState')}/{f.get('SubState')}）"
            )
        elif f.get("SubState") not in ("running", "exited"):
            problems.append(f"⚠️ <b>{unit}</b> 子状态异常：{f.get('SubState')}")

        # 端口归属：这才是能抓住「孤儿进程占端口导致无限崩溃循环」的检查。
        # 关键点：即使单元正在 auto-restart（ActiveState != active）也必须查，
        # 否则只会报「不是 active」这种症状，永远说不出根因。
        if port:
            owner_pid, owner_name = port_owner(port)
            main_pid = int(f.get("MainPID") or 0)
            if owner_pid is None:
                problems.append(
                    f"❌ <b>{unit}</b> 期望监听 <code>{port}</code>，但该端口没人监听"
                )
            elif main_pid and owner_pid == main_pid:
                pass  # 端口属于单元自己的主进程，正常
            elif main_pid:
                problems.append(
                    f"🚨 <b>{unit}</b> 的端口 <code>{port}</code> 被<b>别的进程</b>占着："
                    f"PID {owner_pid} ({owner_name})，而单元自己的 MainPID 是 {main_pid}"
                    f" —— 这是无限崩溃循环的根因，systemd 的 Restart= 修不好它"
                )
            else:
                problems.append(
                    f"🚨 <b>{unit}</b> 当前没有主进程（正在重启中），而端口 <code>{port}</code> "
                    f"被 PID {owner_pid} ({owner_name}) 占着 —— 单元每起一次就撞一次"
                    f"（大概率是 setsid/手工启动的孤儿进程），systemd 的 Restart= 修不好它"
                )

    # 重启计数增量：systemd 会悄悄一直重启，只靠 is-active 看不出来
    prev_units = prev_state().get("detail", {}).get("units", {}) or {}
    for scope, unit, _ in WATCH_UNITS:
        key = f"{scope}:{unit}"
        cur = detail["units"][key].get("nrestarts")
        try:
            cur_i = int(cur) if cur not in (None, "") else None
        except ValueError:
            cur_i = None
        detail["units"][key]["nrestarts_int"] = cur_i
        before = (prev_units.get(key) or {}).get("nrestarts_int")
        if cur_i is not None and isinstance(before, int) and cur_i > before:
            problems.append(
                f"🔁 <b>{unit}</b> 自上次巡检又重启了 {cur_i - before} 次（累计 {cur_i}）"
                f" —— 它在重启循环里烧 CPU、刷日志"
            )

    # systemd 之外的同名进程
    for name, pattern in WATCH_PROCS:
        hits = procs_matching(pattern)
        if len(hits) > 1:
            detail.setdefault("stray", {})[name] = hits
            problems.append(
                f"🚨 检测到 <b>{name}</b> 有 {len(hits)} 个实例在跑（PID {[p for p, _ in hits]}）"
                f" —— 可能有一份是 systemd 之外的孤儿"
            )

    du = shutil.disk_usage("/")
    pct = round(du.used / du.total * 100, 1)
    detail["disk"] = {"pct": pct, "free_gb": round(du.free / 2**30, 1)}
    if pct >= DISK_LIMIT_PCT:
        problems.append(f"💾 根分区已用 <b>{pct}%</b>（剩 {detail['disk']['free_gb']}G）")

    mem = {}
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if ":" in line:
                    k, v = line.split(":", 1)
                    mem[k.strip()] = int(v.strip().split()[0])
        avail_mb = mem.get("MemAvailable", 0) // 1024
        detail["mem"] = {"available_mb": avail_mb}
        if avail_mb < MEM_MIN_MB:
            problems.append(f"🧠 可用内存只剩 <b>{avail_mb}MB</b>")
    except OSError:
        pass

    # argnode/argpool removed: the ARG pool is gone, nothing to watch there
    check_web_integrity(problems, detail)
    check_indexer(problems, detail)
    chain = {"chain_height": None, "chain_since": None, "chain_restarted": False}
    pool_state = check_pool_blocks(problems, detail)
    return {"problems": problems, "detail": detail, "ts": time.time(), **chain, **pool_state}


WEB_FILES = [
    # the pool pages
    "/var/www/argonpool/index.html",
    "/var/www/argonpool/miners.html",
    "/var/www/argonpool/app-shell.js",
    "/var/www/argonpool/app-miners.js",
    # what /wallet/ serves now: a forwarder that hands the keystore to the new origin
    "/var/www/argonpool/wallet/index.html",
    "/var/www/argonpool/wallet/migrate.js",
    # and the wallet itself, on its own origin
    "/var/www/argonpool-wallet/index.html",
    "/var/www/argonpool-wallet/app.js",
]
WEB_MANIFEST = "/root/watchdog/web.sha256"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def check_web_integrity(problems: list, detail: dict) -> dict:
    """The private key never leaves the browser, so the cheapest way to steal it is
    to change the JavaScript we serve. Hash every page file against a sealed
    manifest and shout when one moves without a deploy."""
    sealed = {}
    try:
        with open(WEB_MANIFEST, encoding="utf-8") as fh:
            for line in fh:
                h, _, p = line.strip().partition("  ")
                if h and p:
                    sealed[p] = h
    except OSError:
        sealed = {}

    current = {}
    for p in WEB_FILES:
        try:
            current[p] = sha256_file(p)
        except OSError:
            problems.append(f"🔐 网页文件不见了：<code>{p}</code>")

    if not sealed:                     # first run: seal what is on disk now
        with open(WEB_MANIFEST, "w", encoding="utf-8") as fh:
            for p, h in sorted(current.items()):
                fh.write(f"{h}  {p}" + chr(10))
        detail["web"] = {"sealed": len(current), "changed": 0}
        return detail["web"]

    changed = [p for p, h in current.items() if sealed.get(p) and sealed[p] != h]
    if changed:
        names = "、".join(f"<code>{p.rsplit('/', 1)[-1]}</code>" for p in changed)
        problems.append(
            f"🔐 <b>网页文件被改动</b>：{names} —— 如果不是你刚部署，"
            "按服务器被入侵处理（钱包私钥只在前端，改 JS 就能偷）"
        )
    detail["web"] = {"sealed": len(current), "changed": len(changed)}
    return detail["web"]


def check_indexer(problems: list, detail: dict) -> dict:
    """The wallet shows what the index knows. If the index falls behind the chain,
    balances and confirmations are stale and nobody notices until a user complains."""
    def get(url):
        with urllib.request.urlopen(url, timeout=6) as fh:
            return json.load(fh)

    try:
        idx = get("http://127.0.0.1:8083/api/wallet/stats")
        node = get("http://127.0.0.1:8081/api/stats")
    except Exception as exc:                      # noqa: BLE001
        problems.append(f"🔎 钱包索引查询失败：{exc}")
        return {}

    tip = idx.get("tip") or 0
    height = node.get("height") or 0
    lag = height - tip
    detail["index"] = {"tip": tip, "node": height, "lag": lag}
    if height and lag > 5:
        problems.append(
            f"🔎 钱包索引落后主链 <b>{lag}</b> 块（索引 {tip} / 节点 {height}）"
            " —— 用户会看到过期的余额和确认数"
        )
    return detail["index"]


def prev_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(result: dict) -> None:
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def fmt_report(result: dict, recovered_from: bool) -> str:
    head = "✅ <b>RackNerd 看护：已恢复正常</b>" if recovered_from else "🚨 <b>RackNerd 看护告警</b>"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    body = "\n".join(f"• {p}" for p in result["problems"])
    d = result["detail"]
    units = "、".join(
        f"{k.split(':')[1].replace('.service','')}={v.get('active')}"
        for k, v in d.get("units", {}).items()
        if v.get("active") not in (None, "")
    )
    tail = (
        f"\n\n<b>巡检时间</b> {now}"
        f"\n<b>磁盘</b> {d.get('disk', {}).get('pct')}%（剩 {d.get('disk', {}).get('free_gb')}G）"
        f"\n<b>内存可用</b> {d.get('mem', {}).get('available_mb')}MB"
        f"\n<b>单元</b> {units}"
    )
    return head + "\n" + body + tail


def main() -> int:
    args = set(sys.argv[1:])
    if "--status" in args:
        print(json.dumps(prev_state(), ensure_ascii=False, indent=2))
        return 0

    result = collect()
    bad_now = bool(result["problems"])
    prev = prev_state()
    bad_before = bool(prev.get("problems"))

    if "--dry-run" in args:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if "--test-alert" in args:
        ok = send_telegram(
            "🧪 <b>RackNerd 看护 · 测试消息</b>\n"
            "如果你看到这条，说明巡检告警通道是通的。\n"
            "目前检查项：frps / prl-bot / docker / hermes-gateway 的存活、"
            "端口归属、孤儿进程、磁盘、内存。"
        )
        log(f"test-alert sent={ok}")
        return 0 if ok else 1

    log(f"巡检: problems={len(result['problems'])}")

    if bad_now and not bad_before:
        sent = send_telegram(fmt_report(result, recovered_from=False))
        log(f"发送告警 sent={sent}")
    elif bad_now and bad_before:
        # 仍在故障中：只在故障集合变化时再提醒
        if sorted(result["problems"]) != sorted(prev.get("problems", [])):
            sent = send_telegram(fmt_report(result, recovered_from=False))
            log(f"故障集合有变化，重发告警 sent={sent}")
    elif not bad_now and bad_before:
        send_telegram(fmt_report(result, recovered_from=True))
        log("发送恢复通知")

    save_state(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())

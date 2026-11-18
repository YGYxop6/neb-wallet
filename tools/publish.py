"""Publish the wallet repo through the GitHub REST API.

`git push` keeps dying on this network ("unexpected disconnect while reading
sideband packet") while plain HTTPS requests work, so the same commit is built
from blobs, a tree and a commit object instead of a packfile.
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

OWNER = "YGYxop6"
REPO = "neb-wallet"
TOKEN = os.environ["GH_TOKEN"]
API = "https://api.github.com"

MESSAGE = os.environ.get("GH_MESSAGE") or """NEB web wallet: non-custodial browser wallet with a read-only address index

Keys are generated and sealed in the browser (PBKDF2-SHA256 600k + AES-GCM-256)
and never leave it. The server serves static files, answers balance queries from
a local SQLite index, and relays signed transactions; there is no endpoint that
accepts a private key.

Vectors captured from neb-wallet and from neb-chain::tx (Rust) pin the address,
txid, sighash and signature byte for byte, including the CompactSize varint the
node uses (LEB128 looks identical until a transaction has more than 252 inputs,
which is exactly what coin consolidation produces).

The page, the pool page and the miners page share one header, one language key
and one search box; a GitHub workflow rebuilds the bundle and prints its hash so
anyone can compare it with the fingerprint shown in the footer."""


def call(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}",
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise SystemExit(f"{method} {path} -> {e.code} {detail}")


def ensure_branch() -> str:
    """An empty repository refuses blob uploads, so seed it with the README first."""
    try:
        ref = call("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/main")
        return ref["object"]["sha"]
    except SystemExit:
        pass
    raw = open("README.md", "rb").read()
    doc = call("PUT", f"/repos/{OWNER}/{REPO}/contents/README.md",
               {"message": "seed", "content": base64.b64encode(raw).decode()})
    print("seeded main with a placeholder README")
    return doc["commit"]["sha"]


def main() -> int:
    parent = ensure_branch()
    files = subprocess.run(["git", "ls-files"], capture_output=True, text=True,
                           check=True).stdout.split()
    if not files:
        raise SystemExit("no files to publish")

    tree = []
    for path in files:
        raw = open(path, "rb").read()
        blob = call("POST", f"/repos/{OWNER}/{REPO}/git/blobs",
                    {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
        tree.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"  blob {blob['sha'][:8]} {len(raw):>7} {path}")

    root = call("POST", f"/repos/{OWNER}/{REPO}/git/trees", {"tree": tree})
    commit = call("POST", f"/repos/{OWNER}/{REPO}/git/commits",
                  {"message": MESSAGE, "tree": root["sha"], "parents": [parent]})
    call("PATCH", f"/repos/{OWNER}/{REPO}/git/refs/heads/main",
         {"sha": commit["sha"], "force": True})

    print("commit", commit["sha"][:12], "->", f"https://github.com/{OWNER}/{REPO}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

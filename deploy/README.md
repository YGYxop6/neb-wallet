# Server-side files

Copies of what actually runs on the VPS, kept here so a lost laptop does not
mean a lost configuration.

| file | lives at | what it does |
|---|---|---|
| `argonpool.conf` | `/etc/nginx/conf.d/argonpool.conf` | pool vhost: TLS, CSP, API proxies; `/wallet/` is only a forwarder now |
| `wallet-argonpool.conf` | `/etc/nginx/conf.d/wallet-argonpool.conf` | the wallet's own origin, nothing but the wallet and its API |
| `watchdog.py` | `/root/watchdog/watchdog.py` | every 2 min: service/port/disk checks, web file hashes, index lag, Telegram alerts |
| `seal-web.sh` | `/root/watchdog/seal-web.sh` | re-seals the six web files after a deploy, otherwise the watchdog alerts |

After changing a web file on the server, run `seal-web.sh`, or the watchdog will
report the page as tampered within two minutes.

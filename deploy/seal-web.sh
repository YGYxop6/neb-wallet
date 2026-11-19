#!/bin/sh
# Run this *after* a deliberate deploy of the site. Any change to these files
# that skips this script is what the watchdog alerts on within two minutes.
set -e
out=/root/watchdog/web.sha256
tmp=$out.tmp
: > "$tmp"
for p in /var/www/argonpool/wallet/index.html /var/www/argonpool/wallet/app.js \
         /var/www/argonpool/index.html /var/www/argonpool/miners.html; do
  [ -f "$p" ] && sha256sum "$p" >> "$tmp"
done
mv "$tmp" "$out"
cat "$out"

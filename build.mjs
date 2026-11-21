// Bundles the wallet into two files and prints their hashes. Anyone can run
// `npm ci && npm run build` and compare the result with what the server serves:
// same input, same bytes, same hash.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";

const out = "dist";
await mkdir(out, { recursive: true });

await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "iife",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  outfile: `${out}/app.js`,
});

await copyFile("index.html", `${out}/index.html`);

// The same wallet is served from two origins: /wallet/ on the pool host while
// the migration is still running, and the root of wallet.argonpool.com. Only the
// asset path and the nav targets differ, so derive the second copy here instead of
// hand-editing two HTML files that can drift apart.
const rootHtml = (await readFile("index.html", "utf8"))
  .replace('src="/wallet/app.js"', 'src="app.js"')
  .replaceAll('href="/"', 'href="https://argonpool.com/"')
  .replaceAll('href="/pools.html"', 'href="https://argonpool.com/pools.html"')
  .replaceAll('href="/address.html"', 'href="https://argonpool.com/address.html"')
  .replaceAll('href="/price.html"', 'href="https://argonpool.com/price.html"')
  .replaceAll('href="/donate.html"', 'href="https://argonpool.com/donate.html"')
  .replace('href="/wallet/" class="on"', 'href="/" class="on"');
await writeFile(`${out}/index-wallet.html`, rootHtml);

const js = await readFile(`${out}/app.js`);
const hash = createHash("sha256").update(js).digest("hex");
const size = (js.length / 1024).toFixed(1);
console.log(`dist/app.js  ${size} KB`);
console.log(`sha256       ${hash}`);
await writeFile(`${out}/BUILD.txt`, `app.js sha256 ${hash}\nbytes ${js.length}\n`);

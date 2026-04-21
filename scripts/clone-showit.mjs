#!/usr/bin/env node
// Self-contained mirror of a Showit-hosted site.
//
// Pass 1: scan index.html for every //static.showit.co/... and //lib.showit.co/... URL.
// Pass 2: parse the inline init_data JSON for every `key` field — the Showit engine
//         builds image URLs at runtime as `assetURL + "/" + <width-bucket> + "/" + key`
//         (or `/file/` for svg/gif). Enqueue every key at every size bucket so
//         sections the static HTML doesn't currently show still have their images.
// Pass 3: download each into assets/showit/<preserved-path>. Scan each downloaded
//         .js/.css for further showit.co references; enqueue those too.
// Pass 4: rewrite URLs in index.html and all downloaded .js/.css to relative
//         ./assets/showit/... paths. Leave non-showit URLs alone.

// Size buckets the Showit engine selects from (from I=[...] in showit.min.js).
const SIZE_BUCKETS = [200, 400, 800, 1200, 1600, 2400, 3200];

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIR = path.join(ROOT, "assets", "showit");
const INDEX = path.join(ROOT, "index.html");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CONCURRENCY = 8;

// Match //static.showit.co/... or //lib.showit.co/... or https://static.showit.co/...
// up to the next quote / whitespace / paren / angle bracket.
const SHOWIT_URL_RE =
  /(?:https?:)?\/\/(?:static|lib)\.showit\.co\/[A-Za-z0-9_\-./]+(?:\.[A-Za-z0-9]{1,6})?/g;

function normaliseUrl(raw) {
  // Strip protocol so every URL is "//host/path"; we fetch with https: and store by host+path.
  let u = raw;
  if (u.startsWith("http://")) u = u.slice(5);
  if (u.startsWith("https://")) u = u.slice(6);
  if (!u.startsWith("//")) return null;
  // Drop query string / hash for on-disk path
  const clean = u.split("?")[0].split("#")[0];
  return clean; // "//static.showit.co/200/..."
}

function urlToLocalPath(normUrl) {
  // "//static.showit.co/200/foo/bar.jpg" -> assets/showit/static.showit.co/200/foo/bar.jpg
  const withoutSlashes = normUrl.slice(2);
  return path.join(ASSET_DIR, withoutSlashes);
}

function urlToRelativeHref(normUrl) {
  // Path that index.html at repo root uses to reference the asset.
  const withoutSlashes = normUrl.slice(2);
  return `./assets/showit/${withoutSlashes}`;
}

async function download(normUrl) {
  const outPath = urlToLocalPath(normUrl);
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const exists = await fs
      .stat(outPath)
      .then(() => true)
      .catch(() => false);
    if (exists) return { normUrl, outPath, skipped: true };
    // Retry transient failures (504s are common on Showit's CDN for
    // less-frequently-requested size buckets — the origin generates the
    // resized image on demand and sometimes times out the first request).
    let lastStatus = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 750 * attempt));
      const res = await fetch(`https:${normUrl}`, {
        headers: { "user-agent": USER_AGENT },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(outPath, buf);
        return { normUrl, outPath, bytes: buf.length };
      }
      lastStatus = res.status;
      if (res.status < 500 && res.status !== 429) break; // 4xx is permanent
    }
    return { normUrl, outPath, error: `HTTP ${lastStatus}` };
  } catch (err) {
    return { normUrl, outPath, error: err.message };
  }
}

async function runPool(items, worker) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
  return results;
}

function extractShowitUrls(text) {
  const out = new Set();
  const matches = text.matchAll(SHOWIT_URL_RE);
  for (const m of matches) {
    const norm = normaliseUrl(m[0]);
    if (norm) out.add(norm);
  }
  return [...out];
}

function extractInitDataKeys(html) {
  const m = html.match(
    /<script id="init_data"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) return [];
  let data;
  try {
    data = JSON.parse(m[1].trim());
  } catch {
    return [];
  }
  const keys = new Set();
  (function walk(v) {
    if (!v) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "key" && typeof x === "string") keys.add(x);
        walk(x);
      }
    }
  })(data);
  return [...keys];
}

function keyToUrls(key) {
  // Showit engine: SVG/GIF go under /file/<key>; everything else under
  // /<size-bucket>/<key>. We don't know which buckets actually exist server-side
  // for this key, so enqueue every bucket and let download() treat 404 as soft
  // failure.
  const ext = key.split(".").pop().toLowerCase();
  if (["svg", "gif"].includes(ext)) {
    return [`//static.showit.co/file/${key}`];
  }
  return SIZE_BUCKETS.map((w) => `//static.showit.co/${w}/${key}`);
}

async function main() {
  const html = await fs.readFile(INDEX, "utf8");
  const fromHtml = extractShowitUrls(html);
  console.log(`[pass 1] ${fromHtml.length} explicit showit URLs in index.html`);

  const keys = extractInitDataKeys(html);
  const fromKeys = keys.flatMap(keyToUrls);
  console.log(
    `[pass 2] ${keys.length} init_data keys -> ${fromKeys.length} candidate URLs across size buckets`,
  );

  const initial = [...new Set([...fromHtml, ...fromKeys])];
  const discovered = new Set(initial);
  const queue = [...initial];
  const results = [];

  while (queue.length) {
    const batch = queue.splice(0, queue.length);
    const batchResults = await runPool(batch, download);
    results.push(...batchResults);

    for (const r of batchResults) {
      if (r.error) continue;
      // Re-scan text assets for nested showit references (the engine JS/CSS
      // pulls in additional .css / images). Skipped (already-downloaded) files
      // are rescanned too — rewrites earlier this run may have stripped the
      // nested URLs, but we still want to reconcile the queue from the
      // pristine on-disk copy.
      if (/\.(js|css|html|svg)$/i.test(r.outPath)) {
        const content = await fs.readFile(r.outPath, "utf8").catch(() => "");
        const nested = extractShowitUrls(content);
        for (const u of nested) {
          if (!discovered.has(u)) {
            discovered.add(u);
            queue.push(u);
          }
        }
      }
    }
  }

  const ok = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => r.error);
  const hardFails = failed.filter((f) => !/HTTP 404/.test(f.error));
  console.log(
    `[download] ${ok}/${results.length} assets saved (${failed.length} missing, ${hardFails.length} hard failures)`,
  );
  for (const f of hardFails) console.log(`  FAIL  ${f.normUrl}  -> ${f.error}`);

  // Rewrite pass — index.html first.
  let rewritten = html;
  for (const norm of discovered) {
    const rel = urlToRelativeHref(norm);
    // Replace both protocol-relative and absolute forms.
    const variants = [norm, `https:${norm}`, `http:${norm}`];
    for (const v of variants) {
      rewritten = rewritten.split(v).join(rel);
    }
  }
  // Rewrite the Showit engine's runtime assetURL so JS-constructed image URLs
  // resolve to our local mirror. Showit does `assetURL + "/200/" + key` at
  // runtime; point the base at the on-disk layout we just created.
  rewritten = rewritten.replace(
    /"assetURL":"\/\/static\.showit\.co"/g,
    '"assetURL":"assets/showit/static.showit.co"',
  );
  // Drop the preconnect hint — nothing local needs it, and leaving it in would
  // still handshake the Showit CDN for no benefit.
  rewritten = rewritten.replace(
    /<link rel="preconnect" href="https:\/\/static\.showit\.co"\s*\/?>\s*/g,
    "",
  );
  await fs.writeFile(INDEX, rewritten);
  console.log(`[rewrite] index.html updated`);

  // Rewrite downloaded .js/.css so nested references point locally.
  let rewrittenAssets = 0;
  for (const r of results) {
    if (r.error) continue;
    if (!/\.(js|css)$/i.test(r.outPath)) continue;
    let content = await fs.readFile(r.outPath, "utf8");
    const before = content;
    for (const norm of discovered) {
      // Inside a nested asset, siblings live at the same depth on disk.
      // Rewrite to protocol-relative -> path relative to this asset's dir.
      const absDiskFromAsset = path.relative(
        path.dirname(r.outPath),
        urlToLocalPath(norm),
      );
      const relHref = absDiskFromAsset.split(path.sep).join("/");
      const variants = [norm, `https:${norm}`, `http:${norm}`];
      for (const v of variants) {
        content = content.split(v).join(relHref);
      }
    }
    if (content !== before) {
      await fs.writeFile(r.outPath, content);
      rewrittenAssets++;
    }
  }
  console.log(`[rewrite] ${rewrittenAssets} nested asset files updated`);

  console.log(`\nDone. Total unique showit URLs: ${discovered.size}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

# leighannmartin.com — static mirror

Self-contained clone of Leigh-Ann Martin's Showit-hosted site, published via GitHub Pages so we can take her off Showit hosting.

## What's here
- `index.html` — the single HTML shell Showit serves. All sections (Home / About / Pro Chef / Press / Contact) live inside this file, reached via hash routes (`/#/about`, etc.).
- `assets/showit/` — every image, font, and Showit engine JS/CSS file that the page used to fetch from `static.showit.co` / `lib.showit.co`, mirrored locally.
- `scripts/clone-showit.mjs` — re-runnable crawler + URL rewriter. Run it any time Leigh-Ann tweaks the live Showit site to refresh this mirror.

## Regenerate from scratch

```bash
curl -sSL -A "Mozilla/5.0" https://leighannmartin.com/ -o index.html
node scripts/clone-showit.mjs
```

The script is idempotent — it skips already-downloaded assets and re-rewrites URLs on every run.

## Local preview

```bash
npx serve .
```

## Known gaps
- **Contact form** posts to `clientservice.showit.co/contactform`. After Leigh-Ann cancels Showit, that endpoint stops working. Replace with a Flodesk form (she already has Flodesk) or Formspree before killing the Showit subscription.
- **Hash routing preserved 1:1** — deep links are `/#/about`, not `/about`. Matches current behavior; no SEO regression.
- **Showit JS engine is self-hosted.** Standard grey-area trade-off when leaving a drag-drop builder. Flag if it ever becomes a concern; fallback is rebuilding in Astro.

## DNS cutover (when Leigh-Ann gives the go)
1. Add a `CNAME` file to this repo root containing `leighannmartin.com`, push.
2. In Google Cloud DNS, replace the `A` record `75.101.134.27` with GitHub Pages apex IPs: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`. Add `CNAME www` → `izzydoesizzy.github.io.`.
3. Wait for propagation, then in GitHub Pages settings check "Enforce HTTPS" once the cert issues.
4. Cancel Showit.

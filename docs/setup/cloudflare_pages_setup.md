# Cloudflare Pages Setup — avalonpediatw

> Status: 2026-04-14 — **manual setup required**. No Cloudflare API token in
> `~/.claude/credentials/`, and per operational rule "minimize new services", Claude
> will not apply for a new token automatically. Edward: follow steps below, or drop an
> API token into `~/.claude/credentials/cloudflare_api.json` and ping `/go`.
>
> Decision 2026-04-14: not purchasing a custom domain. Using default
> `avalonpediatw.pages.dev` URL.

## Prerequisites

- Cloudflare account (free tier sufficient).
- GitHub repo `l12203685/avalonpediatw` with `main` branch buildable.

## One-time Manual Steps

1. Log in: <https://dash.cloudflare.com/>
2. Sidebar → **Workers & Pages** → **Create** → **Pages** tab → **Connect to Git**.
3. Authorize GitHub app (repo-scoped: `l12203685/avalonpediatw` only).
4. Pick repo `avalonpediatw` → branch `main`.
5. Build config:
   - Framework preset: **Astro**
   - Build command: `npm run build`
   - Build output dir: `dist`
   - Root directory: *(leave blank if Astro app is at repo root — adjust if
     monorepo layout uses `apps/web` or similar)*
   - Node version env: `NODE_VERSION=20`
6. Save and deploy. First build typically 2–4 min.
7. Default URL: `https://avalonpediatw.pages.dev/`
   - Preview URL per PR: `https://<hash>.avalonpediatw.pages.dev/`
8. Verify Chinese slug route: `https://avalonpediatw.pages.dev/角色/梅林/` → HTTP 200.
9. Verify pagefind zh-Hant search index ships in `dist/pagefind/`.

## Optional: API-driven Setup (Future)

If Edward provides a Cloudflare API token later, write it to
`~/.claude/credentials/cloudflare_api.json`:

```json
{
  "api_token": "<token with Pages:Edit + Account:Read>",
  "account_id": "<account-id>"
}
```

Then Claude can create the Pages project via wrangler:

```bash
npx wrangler pages project create avalonpediatw --production-branch main
npx wrangler pages deploy dist --project-name avalonpediatw
```

Required token scopes:

- Account → Cloudflare Pages:Edit
- Account → Account Settings:Read
- Zone → (none needed if using `.pages.dev`)

## Deliverables After Manual Setup

- [ ] `avalonpediatw.pages.dev` serves Astro build.
- [ ] `/角色/梅林/` returns HTTP 200.
- [ ] Pagefind index loads.
- [ ] GitHub PR previews auto-deploy.
- [ ] Record project URL + deployment ID in `代辦事項.md` M0.4 entry.

## Why No Custom Domain

- Edward decision 2026-04-14: defer `avalonpediatw.com` purchase.
- `.pages.dev` is free, HTTPS by default, sufficient for M0–M2.
- Domain purchase deferred until M3+ when public launch scheduled.

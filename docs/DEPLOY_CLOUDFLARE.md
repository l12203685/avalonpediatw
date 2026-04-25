# M0.4 Deploy — Cloudflare Pages (avalonpediatw.com)

> Due: 2026-04-20. This doc covers the wiki site ONLY (apps/wiki → CF Pages).
> The game platform deploy (packages/web → Firebase/GH Pages) is separate and unaffected.

## TL;DR for Edward

The repo is pre-wired. Once you complete the manual steps below, pushing to `main`
auto-deploys the wiki to Cloudflare Pages. No further code changes required.

---

## Step-by-step (after you swipe the card)

### 1. Create the Cloudflare account (5 min)

1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with your primary email. Verify.
3. Skip "Add a domain" on first screen — we'll do it later.
4. Enable 2FA immediately (Account → Security).

**Cost note:** Free plan is enough for M0.4 + M0.5 (Pages + R2 both free-tier).
Card is only required if you upgrade; the free tier does not auto-charge.

### 2. Create the API token (3 min)

1. Dashboard → top-right avatar → **My Profile** → **API Tokens** → **Create Token**.
2. Pick template **"Custom token"** with these permissions:
   - `Account` → `Cloudflare Pages` → **Edit**
   - `Account` → `Account Settings` → **Read**  *(for workflow sanity check)*
   - `User` → `User Details` → **Read**
3. Account Resources: **Include → Specific account → \<your account\>**.
4. **Create → Copy the token** (shown once). Save to vault:
   `~/.claude/credentials/cloudflare_api_token.txt`.

### 3. Grab the Account ID (30 sec)

Dashboard home → right sidebar → **Account ID** → copy.

### 4. Add GitHub secrets (2 min)

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Name                    | Value                                 |
|-------------------------|---------------------------------------|
| `CLOUDFLARE_API_TOKEN`  | token from step 2                     |
| `CLOUDFLARE_ACCOUNT_ID` | account ID from step 3                |

### 5. Create the Pages project (auto on first deploy)

No manual click-ops needed. The `cloudflare/pages-action@v1` step in
`.github/workflows/deploy-cloudflare-pages.yml` will create the Pages project
named **`avalonpediatw`** on its first successful run.

### 6. Trigger first deploy

```bash
git commit --allow-empty -m "chore(m0.4): trigger first CF Pages deploy"
git push origin main
```

Watch: `Actions` tab → `Deploy Wiki to Cloudflare Pages` → green tick.

First deploy URL: `https://avalonpediatw.pages.dev` (free subdomain, live immediately).

### 7. Attach custom domain — `avalonpediatw.com` (10 min)

> Only do this step once the `*.pages.dev` URL is confirmed working.

1. **Register the domain** (if not yet owned). Cheapest route: Cloudflare
   Registrar (at-cost pricing, no markup). Dashboard → **Domain Registration**
   → **Register Domains** → search `avalonpediatw.com`. ~USD $10/yr for `.com`.
2. Once registered, the domain auto-appears under **Websites** in your CF
   account with nameservers already pointing to CF.
3. Go to **Workers & Pages → avalonpediatw → Custom domains → Set up a custom domain**.
4. Enter `avalonpediatw.com`. CF auto-creates the DNS CNAME. Wait 1–3 min.
5. Repeat for `www.avalonpediatw.com` (the `_redirects` file already 301s www → apex).

SSL: CF auto-provisions a Universal SSL cert. No action needed.

### 8. Verify

```
https://avalonpediatw.com          → 200, wiki homepage
https://www.avalonpediatw.com      → 301 → https://avalonpediatw.com
https://avalonpediatw.pages.dev    → still live (keep for previews)
```

---

## What's already in place (no Edward action)

| File | Purpose |
|---|---|
| `wrangler.toml` | CF Pages project config (build output dir, compat date) |
| `apps/wiki/public/_headers` | security + cache headers |
| `apps/wiki/public/_redirects` | www→apex, legacy path migration |
| `.github/workflows/deploy-cloudflare-pages.yml` | auto-deploy on push to main |

## Preview deployments

Every PR that touches `apps/wiki/**` or `content/**` gets a preview URL posted
as a PR comment by the action. Merge to main → production deploy.

## Rollback

CF dashboard → Workers & Pages → avalonpediatw → Deployments → pick any
previous deployment → **Rollback**. Instant, no rebuild.

## Troubleshooting

- **Workflow fails with "Project not found"**: first run must be on `main`
  (not a PR), so CF Pages can create the project. Re-run after merging to main.
- **Token permission error**: re-check step 2 perms, especially `Pages: Edit`.
- **Custom domain stuck on "Verifying"**: wait 5 min, then refresh. If still
  stuck, check DNS record in CF DNS tab — the CNAME should be `proxied` (orange cloud).

## Out of scope for M0.4

- R2 bucket (M0.5) — uncomment `[[r2_buckets]]` block in `wrangler.toml` when ready.
- Pages Functions / SSR — wiki is pure static; no functions needed for MVP.
- Analytics — add CF Web Analytics post-launch (free, no code change).

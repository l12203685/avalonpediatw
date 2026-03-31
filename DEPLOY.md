# Avalon Pedia — Production Deployment Guide

## Architecture

```
User
 └── Firebase Hosting (web frontend, CDN)
       ├── /api/**       → Cloud Run (avalon-server)
       ├── /socket.io/** → Cloud Run (avalon-server, WebSocket)
       └── **            → /index.html (SPA fallback)

Cloud Run: avalon-server
  - Express + Socket.IO (WebSocket)
  - Firebase Admin SDK (Auth, RTD, Firestore)
  - Discord/LINE bots
```

Firebase Functions is NOT used — Socket.IO requires persistent connections
that Functions cannot provide. Cloud Run is the correct target.

---

## Prerequisites

| Tool | Install | Required |
|------|---------|----------|
| Node.js >= 18 | https://nodejs.org | yes |
| pnpm >= 8 | `npm i -g pnpm` | yes |
| firebase-cli | `npm i -g firebase-tools` | yes |
| Google Cloud SDK | https://cloud.google.com/sdk/docs/install | yes |
| Docker | https://docs.docker.com/get-docker/ | yes |

One-time login:

```bash
firebase login
gcloud auth login
gcloud auth configure-docker        # authorise docker push to GCR
gcloud config set project avalon-game-platform
```

---

## Environment Variables

### Cloud Run (server)

Set these in Cloud Run via the console or `gcloud run deploy --set-env-vars`:

| Variable | Source | Example |
|----------|--------|---------|
| `NODE_ENV` | hardcoded | `production` |
| `PORT` | hardcoded | `3001` |
| `FIREBASE_PROJECT_ID` | Firebase console | `avalon-game-platform` |
| `FIREBASE_API_KEY` | Firebase console > Project Settings | `AIza...` |
| `FIREBASE_AUTH_DOMAIN` | Firebase console | `avalon-game-platform.firebaseapp.com` |
| `FIREBASE_STORAGE_BUCKET` | Firebase console | `avalon-game-platform.appspot.com` |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase console | `123456789` |
| `FIREBASE_APP_ID` | Firebase console | `1:123:web:abc` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase console > Service Accounts | `{...}` (full JSON, single-line) |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal | `Bot ...` |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers | `...` |
| `LINE_CHANNEL_SECRET` | LINE Developers | `...` |
| `CORS_ORIGIN` | set after Hosting deploy | `https://avalon-game-platform.web.app` |

Set all secrets at once after first deploy:

```bash
gcloud run services update avalon-server \
  --region asia-east1 \
  --update-env-vars "FIREBASE_PROJECT_ID=avalon-game-platform,FIREBASE_API_KEY=AIza...,..."
```

Or use Secret Manager (recommended for credentials):

```bash
gcloud secrets create firebase-service-account --data-file=service-account.json
# then reference in Cloud Run:
gcloud run services update avalon-server \
  --update-secrets "FIREBASE_SERVICE_ACCOUNT_JSON=firebase-service-account:latest"
```

### Firebase Hosting (web frontend)

Vite environment variables baked in at build time. Set them before running the
deploy script (or export them in your shell):

| Variable | Value |
|----------|-------|
| `VITE_FIREBASE_API_KEY` | Firebase API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | `avalon-game-platform.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `avalon-game-platform` |
| `VITE_SERVER_URL` | Cloud Run URL (auto-set by deploy.sh) |

---

## One-Command Deploy

```bash
# Full deploy (build + Cloud Run + Firebase Hosting)
./deploy.sh

# Override project or region
./deploy.sh --project my-project-id --region us-central1

# Skip rebuild if code is unchanged (re-push same image + re-deploy hosting)
./deploy.sh --skip-build
```

The script does in order:
1. Preflight: verify all CLI tools present
2. `pnpm install --frozen-lockfile`
3. `pnpm run build` (turbo: builds shared, server, web)
4. `docker build` from root `Dockerfile` (multi-stage, production)
5. `docker push gcr.io/avalon-game-platform/avalon-server`
6. `gcloud run deploy avalon-server` (Cloud Run, asia-east1)
7. Retrieve Cloud Run URL
8. Re-build web with `VITE_SERVER_URL=<Cloud Run URL>`
9. `firebase deploy --only hosting`

---

## Manual Deploy (step-by-step)

### Step 1: Install and build

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### Step 2: Deploy server to Cloud Run

```bash
PROJECT_ID=avalon-game-platform
REGION=asia-east1
IMAGE="gcr.io/${PROJECT_ID}/avalon-server"

docker build -t "${IMAGE}" .
docker push "${IMAGE}"

gcloud run deploy avalon-server \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --allow-unauthenticated \
  --port 3001 \
  --memory 512Mi \
  --set-env-vars "NODE_ENV=production,PORT=3001"
```

Get the URL:

```bash
CLOUD_RUN_URL=$(gcloud run services describe avalon-server \
  --platform managed --region asia-east1 \
  --format "value(status.url)")
echo $CLOUD_RUN_URL
```

### Step 3: Build web with Cloud Run URL

```bash
VITE_SERVER_URL="${CLOUD_RUN_URL}" pnpm -F @avalon/web build
```

### Step 4: Deploy web to Firebase Hosting

```bash
firebase deploy --only hosting --project avalon-game-platform
```

---

## Verify

```bash
# Health check
curl ${CLOUD_RUN_URL}/health
# Expected: {"status":"ok","timestamp":"...","environment":"production","rooms":0}

# Frontend
open https://avalon-game-platform.web.app
```

---

## First-Time Setup Checklist

- [ ] Firebase project `avalon-game-platform` exists
- [ ] Firebase Hosting enabled in Firebase Console
- [ ] Cloud Run API enabled: `gcloud services enable run.googleapis.com`
- [ ] Container Registry API enabled: `gcloud services enable containerregistry.googleapis.com`
- [ ] Service account created for Cloud Run with Firestore + RTD access
- [ ] `gcloud auth configure-docker` done
- [ ] All Cloud Run env vars set (see table above)
- [ ] Firebase Realtime Database rules allow service account
- [ ] Firestore rules allow service account
- [ ] CORS_ORIGIN on Cloud Run updated to `https://avalon-game-platform.web.app`

---

## Troubleshooting

### Docker build fails — pnpm workspace resolution

Run from repo root, not from a subdirectory. The Dockerfile copies the full
workspace including `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

### Cloud Run: 403 on /socket.io

Firebase Hosting rewrites use `run.serviceId`. Confirm firebase.json has both
`/api/**` and `/socket.io/**` rewrites pointing to `avalon-server`.

### WebSocket connection fails from browser

Socket.IO falls back to long-polling when WebSocket is blocked. Cloud Run
supports WebSocket natively. If behind a CDN/proxy, confirm the CDN passes
`Upgrade: websocket` headers (Firebase Hosting does this automatically via
Cloud Run rewrites).

### CORS errors

Set `CORS_ORIGIN` on Cloud Run to the exact Hosting URL:

```bash
gcloud run services update avalon-server \
  --region asia-east1 \
  --update-env-vars "CORS_ORIGIN=https://avalon-game-platform.web.app"
```

### Firebase Admin: credential error

Ensure `FIREBASE_SERVICE_ACCOUNT_JSON` is set as a single-line JSON string, or
use Secret Manager reference. The service account must have the `Firebase Admin`
IAM role on the project.

---

## GitHub Actions CI/CD

Two workflows live in `.github/workflows/`:

| Workflow | Trigger | Jobs |
|----------|---------|------|
| `deploy.yml` | Push to `main` | test → deploy-server (Cloud Run) → deploy-hosting (Firebase) |
| `test.yml` | PR to `main` | test matrix (Node 18 + 20) + security audit |

### Required GitHub Secrets

Go to **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**.

#### Service accounts

| Secret | How to get it |
|--------|--------------|
| `GCP_SA_KEY` | Service account JSON with Cloud Run + GCR permissions (see below) |
| `FIREBASE_SERVICE_ACCOUNT_AVALON` | Firebase service account JSON (see below) |

**Create GCP service account for Cloud Run deploy:**

```bash
SA_NAME="github-actions-deploy"
PROJECT_ID="avalon-game-platform"

gcloud iam service-accounts create "${SA_NAME}" \
  --display-name "GitHub Actions Deploy" \
  --project "${PROJECT_ID}"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Roles needed: Cloud Run Admin, Storage Admin (for GCR push), Service Account User
for ROLE in roles/run.admin roles/storage.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "serviceAccount:${SA_EMAIL}" \
    --role "${ROLE}"
done

# Download key → paste content as GCP_SA_KEY secret
gcloud iam service-accounts keys create gcp-sa-key.json \
  --iam-account "${SA_EMAIL}"
cat gcp-sa-key.json   # copy entire JSON as the secret value
```

**Get Firebase service account JSON (for Hosting deploy):**

```bash
# Option A: Firebase console
# Firebase Console → Project Settings → Service accounts → Generate new private key
# Save file → paste content as FIREBASE_SERVICE_ACCOUNT_AVALON secret

# Option B: reuse GCP service account above
# Grant it the Firebase Hosting Admin role:
gcloud projects add-iam-policy-binding avalon-game-platform \
  --member "serviceAccount:${SA_EMAIL}" \
  --role roles/firebasehosting.admin
# Then use the same gcp-sa-key.json for FIREBASE_SERVICE_ACCOUNT_AVALON as well
```

#### Firebase config (baked into web build)

| Secret | Value |
|--------|-------|
| `VITE_FIREBASE_API_KEY` | Firebase console → Project Settings → Web app config |
| `VITE_FIREBASE_AUTH_DOMAIN` | e.g. `avalon-game-platform.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `avalon-game-platform` |
| `VITE_FIREBASE_STORAGE_BUCKET` | e.g. `avalon-game-platform.appspot.com` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | numeric sender ID from Firebase config |
| `VITE_FIREBASE_APP_ID` | `1:xxx:web:yyy` from Firebase config |

> `VITE_SERVER_URL` is NOT a secret — it is retrieved automatically from Cloud Run
> after each deploy and injected into the web build by the `deploy-hosting` job.

### First-time: enable Firebase Hosting GitHub integration

The `FirebaseExtended/action-hosting-deploy` action needs the Firebase Hosting
GitHub App installed on the repo. Run once from your local machine:

```bash
firebase init hosting:github
# Follow prompts — select repo, allow it to create the FIREBASE_SERVICE_ACCOUNT_AVALON
# secret automatically, or use the manual steps above.
```

### Clean up after key generation

```bash
rm gcp-sa-key.json   # never commit service account keys
```

---

## URLs (production)

| Resource | URL |
|----------|-----|
| Frontend | https://avalon-game-platform.web.app |
| Frontend (alt) | https://avalon-game-platform.firebaseapp.com |
| Server (Cloud Run) | https://avalon-server-<hash>-de.a.run.app |
| Health | `${CLOUD_RUN_URL}/health` |
| Firebase Console | https://console.firebase.google.com/project/avalon-game-platform |
| Cloud Run Console | https://console.cloud.google.com/run?project=avalon-game-platform |

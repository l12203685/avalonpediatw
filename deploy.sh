#!/bin/bash
# Avalon Pedia — Production Deploy Script
# Target: Cloud Run (server) + Firebase Hosting (web)
# Usage:  ./deploy.sh [--project PROJECT_ID] [--region REGION] [--skip-build]

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-avalon-game-platform}"
REGION="${CLOUD_RUN_REGION:-asia-east1}"
SERVICE_NAME="avalon-server"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
SKIP_BUILD=false

# ── Arg parse ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)   PROJECT_ID="$2"; shift 2 ;;
    --region)    REGION="$2";     shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# ── Preflight checks ─────────────────────────────────────────────────────────
echo "=== Preflight checks ==="

command -v node    >/dev/null 2>&1 || { echo "ERROR: node not found"; exit 1; }
command -v pnpm    >/dev/null 2>&1 || { echo "ERROR: pnpm not found (npm i -g pnpm)"; exit 1; }
command -v firebase>/dev/null 2>&1 || { echo "ERROR: firebase-cli not found (npm i -g firebase-tools)"; exit 1; }
command -v gcloud  >/dev/null 2>&1 || { echo "ERROR: gcloud not found — install Google Cloud SDK"; exit 1; }
command -v docker  >/dev/null 2>&1 || { echo "ERROR: docker not found"; exit 1; }

echo "  node   $(node -v)"
echo "  pnpm   $(pnpm -v)"
echo "  firebase $(firebase --version)"
echo "  gcloud $(gcloud --version | head -1)"
echo ""

# ── Install + build ───────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "=== Install dependencies ==="
  pnpm install --frozen-lockfile

  echo ""
  echo "=== Build all packages ==="
  pnpm run build
  echo ""
fi

# ── Phase 1: Cloud Run (server + Socket.IO) ───────────────────────────────────
echo "=== Phase 1: Deploy server to Cloud Run ==="
echo "  Project : ${PROJECT_ID}"
echo "  Region  : ${REGION}"
echo "  Service : ${SERVICE_NAME}"
echo "  Image   : ${IMAGE}"
echo ""

# Build Docker image (uses root Dockerfile — multi-stage, production-optimised)
echo "--- Building Docker image ---"
docker build -t "${IMAGE}" .

# Push to Google Container Registry
echo "--- Pushing image to GCR ---"
docker push "${IMAGE}"

# Deploy to Cloud Run
echo "--- Deploying to Cloud Run ---"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --allow-unauthenticated \
  --port 3001 \
  --min-instances 0 \
  --max-instances 10 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "PORT=3001"

# Retrieve the Cloud Run URL
CLOUD_RUN_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --platform managed \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format "value(status.url)")

echo ""
echo "Cloud Run URL: ${CLOUD_RUN_URL}"
echo ""

# ── Phase 2: Firebase Hosting (web frontend) ──────────────────────────────────
echo "=== Phase 2: Deploy web to Firebase Hosting ==="

# Inject the Cloud Run URL into the web build as VITE_SERVER_URL
# (re-build web only if Cloud Run URL changed — safe to always rebuild)
echo "--- Building web with production API URL ---"
VITE_SERVER_URL="${CLOUD_RUN_URL}" \
  pnpm -F @avalon/web build

echo "--- Deploying to Firebase Hosting ---"
firebase deploy --only hosting --project "${PROJECT_ID}"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== Deployment complete ==="
echo ""
echo "  Frontend : https://${PROJECT_ID}.web.app"
echo "  Server   : ${CLOUD_RUN_URL}"
echo "  Health   : ${CLOUD_RUN_URL}/health"
echo ""
echo "Verify:"
echo "  curl ${CLOUD_RUN_URL}/health"

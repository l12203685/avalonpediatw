#!/bin/bash

# 🚀 Avalon Game Platform - 一鍵部署腳本
# 使用方式: bash deploy.sh

set -e

echo "🚀 Avalon Game Platform 部署開始..."
echo "=================================="

# 顏色輸出
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# 1. 檢查 Node.js
echo -e "${BLUE}✓ 檢查環境...${NC}"
node --version || { echo "❌ 需要安裝 Node.js"; exit 1; }
npm --version || { echo "❌ 需要安裝 npm"; exit 1; }

# 2. 安裝 CLI 工具
echo -e "${BLUE}✓ 安裝 CLI 工具...${NC}"
npm install -g @railway/cli vercel --silent || true

# 3. 檢查 Vercel 登入
echo ""
echo -e "${BLUE}🔑 Vercel 認証...${NC}"
if [ -f ~/.vercel/auth.json ]; then
  echo "✓ 已登入 Vercel"
else
  echo "❌ 需要登入 Vercel"
  echo "執行: vercel login"
  vercel login
fi

# 4. 檢查 Railway 登入
echo ""
echo -e "${BLUE}🔑 Railway 認証...${NC}"
if [ -f ~/.railway/config.json ]; then
  echo "✓ 已登入 Railway"
else
  echo "❌ 需要登入 Railway"
  echo "執行: railway login"
  railway login
fi

# 5. 構建
echo ""
echo -e "${BLUE}🔨 構建項目...${NC}"
pnpm install
pnpm build

# 6. 部署前端到 Vercel
echo ""
echo -e "${BLUE}📦 部署前端到 Vercel...${NC}"
cd packages/web
vercel --prod --token $VERCEL_TOKEN 2>/dev/null || {
  echo "提示: 首次部署需要在 Vercel Dashboard 設置項目"
  echo "訪問: https://vercel.com/dashboard"
  vercel --prod
}
VERCEL_URL=$(vercel ls --json 2>/dev/null | jq -r '.[0].url' || echo "your-app.vercel.app")
echo -e "${GREEN}✓ 前端部署完成: https://${VERCEL_URL}${NC}"
cd ../..

# 7. 設置 Railway 項目
echo ""
echo -e "${BLUE}📦 部署後端到 Railway...${NC}"
cd packages/server

# 檢查是否已有 Railway 項目
if [ ! -f .railway/config.json ]; then
  echo "🔗 連接 Railway 項目..."
  railway init
fi

# 設置環境變量
echo "⚙️  設置環境變量..."
railway variables set NODE_ENV=production
railway variables set PORT=3001
railway variables set FIREBASE_PROJECT_ID=avalon-game-platform
railway variables set FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@avalon-game-platform.iam.gserviceaccount.com
railway variables set CORS_ORIGIN=https://${VERCEL_URL}

# 部署
echo "推送代碼到 Railway..."
railway up

RAILWAY_URL=$(railway status 2>/dev/null | grep -oP 'https://[^/]+' || echo "your-app.up.railway.app")
echo -e "${GREEN}✓ 後端部署完成: ${RAILWAY_URL}${NC}"

# 8. 更新前端環境變量
echo ""
echo -e "${BLUE}🔄 更新前端環境變量...${NC}"
cd ../../packages/web
vercel env set VITE_API_URL="${RAILWAY_URL}" --prod
echo -e "${GREEN}✓ 已更新 API 地址${NC}"

# 完成
echo ""
echo -e "${GREEN}=================================="
echo "✅ 部署完成！"
echo "=================================="
echo "🌐 前端: https://${VERCEL_URL}"
echo "🔗 後端: ${RAILWAY_URL}"
echo "🎮 開始遊戲: https://${VERCEL_URL}"
echo ""
echo "💡 下次更新只需:"
echo "   git push origin claude/avalon-game-platform-*"
echo "   (CI/CD 會自動部署)"
echo -e "${NC}"

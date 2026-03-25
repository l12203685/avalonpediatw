#!/bin/bash

set -e

echo "🚀 開始部署到 Firebase..."
echo ""

# 安裝依賴
echo "📦 安裝依賴..."
pnpm install --frozen-lockfile

# 構建所有包
echo "🔨 構建項目..."
pnpm run build

# 部署到 Firebase
echo "☁️  部署到 Firebase..."
firebase deploy --project avalon-game-platform

echo ""
echo "✅ 部署完成！"
echo ""
echo "🌐 前端: https://avalon-game-platform.web.app"
echo "⚡ 後端: https://avalon-game-platform.cloudfunctions.net/api"

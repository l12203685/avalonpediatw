#!/bin/bash

# Avalon Game Platform - 開發環境設置腳本
# 為新團隊成員自動化設置過程

set -e

echo "🚀 Avalon 遊戲平台 - 開發環境設置"
echo "=================================="
echo ""

# 檢查先決條件
echo "📋 檢查先決條件..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安裝。請訪問 https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js $(node --version)"

if ! command -v pnpm &> /dev/null; then
    echo "📦 安裝 pnpm..."
    npm install -g pnpm
fi
echo "✅ pnpm $(pnpm --version)"

if ! command -v git &> /dev/null; then
    echo "❌ Git 未安裝。請訪問 https://git-scm.com/"
    exit 1
fi
echo "✅ Git $(git --version | awk '{print $3}')"

echo ""

# 檢查倉庫設置
echo "🔍 檢查倉庫..."

if [ ! -d ".git" ]; then
    echo "❌ 不在 Git 倉庫中。請先克隆倉庫。"
    exit 1
fi
echo "✅ Git 倉庫找到"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "📌 當前分支: $BRANCH"

if [ "$BRANCH" != "claude/avalon-game-platform-0hDJ1" ]; then
    echo ""
    echo "⚠️  建議切換到開發分支"
    read -p "切換到 claude/avalon-game-platform-0hDJ1? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        git checkout claude/avalon-game-platform-0hDJ1
        git pull origin claude/avalon-game-platform-0hDJ1
    fi
fi

echo ""

# 安裝依賴
echo "📦 安裝依賴..."
pnpm install
echo "✅ 依賴安裝完成"

echo ""

# 設置環境變數
echo "⚙️  設置環境變數..."

if [ ! -f "packages/server/.env" ]; then
    echo "📝 建立 packages/server/.env"
    cp packages/server/.env.example packages/server/.env
    echo "⚠️  請編輯 packages/server/.env 並填入 Firebase 配置"
fi

if [ ! -f "packages/web/.env" ]; then
    echo "📝 建立 packages/web/.env"
    cp packages/web/.env.example packages/web/.env
    echo "⚠️  請編輯 packages/web/.env 並填入 Firebase 配置"
fi

echo "✅ 環境變數設置完成"

echo ""

# 類型檢查
echo "🔍 運行類型檢查..."
pnpm type-check
echo "✅ 類型檢查通過"

echo ""

# 成功完成
echo "=================================="
echo "✅ 開發環境設置完成!"
echo ""
echo "📖 下一步:"
echo "  1. 編輯 packages/server/.env (Firebase 配置)"
echo "  2. 編輯 packages/web/.env (Firebase 配置)"
echo "  3. 運行: pnpm dev"
echo "  4. 打開: http://localhost:5173"
echo ""
echo "📚 更多信息:"
echo "  - 閱讀: TEAM_GUIDE.md"
echo "  - 設置: docs/FIREBASE_SETUP.md"
echo "  - 任務: TEAM_TASKS.md"
echo ""
echo "💡 有問題? 查看 TEAM_GUIDE.md 的「常見問題」部分"
echo ""

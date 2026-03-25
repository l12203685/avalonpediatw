#!/bin/bash

# 部署验证脚本
# 检查部署前的所有配置

set -e

echo "🔍 Avalon Pedia 部署验证"
echo "========================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 计数器
PASS=0
FAIL=0
WARN=0

# 检查函数
check_pass() {
    echo -e "${GREEN}✓${NC} $1"
    ((PASS++))
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
    ((FAIL++))
}

check_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
    ((WARN++))
}

# 1. 检查 Node 和 pnpm 版本
echo "📦 检查依赖工具..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    check_pass "Node.js $NODE_VERSION 已安装"
else
    check_fail "Node.js 未安装"
fi

if command -v pnpm &> /dev/null; then
    PNPM_VERSION=$(pnpm -v)
    check_pass "pnpm $PNPM_VERSION 已安装"
else
    check_fail "pnpm 未安装"
fi

echo ""

# 2. 检查文件结构
echo "📁 检查项目结构..."
if [ -d "packages/web" ]; then
    check_pass "前端目录存在"
else
    check_fail "前端目录不存在"
fi

if [ -d "packages/server" ]; then
    check_pass "后端目录存在"
else
    check_fail "后端目录不存在"
fi

if [ -d "packages/shared" ]; then
    check_pass "共享库目录存在"
else
    check_warn "共享库目录不存在"
fi

echo ""

# 3. 检查配置文件
echo "⚙️ 检查配置文件..."
if [ -f "packages/web/vercel.json" ]; then
    check_pass "Vercel 配置文件存在"
else
    check_fail "Vercel 配置文件不存在"
fi

if [ -f "packages/server/railway.json" ]; then
    check_pass "Railway 配置文件存在"
else
    check_fail "Railway 配置文件不存在"
fi

if [ -f "packages/server/firebase-service-account.json" ]; then
    check_pass "Firebase 服务账户文件存在"
else
    check_warn "Firebase 服务账户文件不存在（可能在部署时通过环境变量设置）"
fi

echo ""

# 4. 检查环境变量模板
echo "🔐 检查环境变量配置..."
if [ -f "packages/server/.env.example" ]; then
    check_pass "后端 .env.example 存在"
else
    check_fail "后端 .env.example 不存在"
fi

if [ -f "packages/server/.env" ]; then
    check_warn "检测到本地 .env 文件（请勿提交到 Git）"
else
    check_warn "未找到本地 .env 文件"
fi

echo ""

# 5. 检查 package.json
echo "📄 检查 package.json..."
for pkg in "packages/web" "packages/server" "packages/shared"; do
    if [ -f "$pkg/package.json" ]; then
        check_pass "$pkg/package.json 存在"
    else
        check_fail "$pkg/package.json 不存在"
    fi
done

echo ""

# 6. 检查 TypeScript 配置
echo "🔧 检查 TypeScript 配置..."
if [ -f "tsconfig.json" ]; then
    check_pass "根 tsconfig.json 存在"
else
    check_fail "根 tsconfig.json 不存在"
fi

for pkg in "packages/web" "packages/server" "packages/shared"; do
    if [ -f "$pkg/tsconfig.json" ]; then
        check_pass "$pkg/tsconfig.json 存在"
    else
        check_fail "$pkg/tsconfig.json 不存在"
    fi
done

echo ""

# 7. 检查构建脚本
echo "🔨 检查构建脚本..."
if grep -q '"build"' package.json; then
    check_pass "根 package.json 有 build 脚本"
else
    check_warn "根 package.json 缺少 build 脚本"
fi

for pkg in "packages/web" "packages/server"; do
    if grep -q '"build"' "$pkg/package.json"; then
        check_pass "$pkg 有 build 脚本"
    else
        check_fail "$pkg 缺少 build 脚本"
    fi
done

echo ""

# 8. 验证前端构建
echo "🏗️ 验证前端构建配置..."
if grep -q "VITE_API_URL" packages/web/vercel.json; then
    check_pass "Vercel 配置包含 VITE_API_URL"
else
    check_warn "Vercel 配置缺少 VITE_API_URL"
fi

if grep -q "FIREBASE_PROJECT_ID" packages/web/vercel.json; then
    check_pass "Vercel 配置包含 Firebase 环境变量"
else
    check_warn "Vercel 配置缺少 Firebase 环境变量"
fi

echo ""

# 9. 验证后端构建
echo "🏗️ 验证后端构建配置..."
if grep -q "PORT" packages/server/railway.json; then
    check_pass "Railway 配置包含 PORT"
else
    check_warn "Railway 配置缺少 PORT"
fi

if grep -q "FIREBASE_PROJECT_ID" packages/server/railway.json; then
    check_pass "Railway 配置包含 Firebase 环境变量"
else
    check_fail "Railway 配置缺少 Firebase 环境变量"
fi

echo ""

# 10. 总结
echo "========================="
echo "验证结果总结"
echo "========================="
echo -e "${GREEN}通过: $PASS${NC}"
echo -e "${RED}失败: $FAIL${NC}"
echo -e "${YELLOW}警告: $WARN${NC}"

if [ $FAIL -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ 所有检查通过，可以开始部署！${NC}"
    echo ""
    echo "📚 后续步骤："
    echo "1. 在 Vercel 中配置前端环境变量"
    echo "2. 在 Railway 中配置后端环境变量"
    echo "3. 连接 GitHub 仓库"
    echo "4. 启动部署"
    echo ""
    echo "查看 DEPLOYMENT.md 了解详细部署步骤"
    exit 0
else
    echo ""
    echo -e "${RED}✗ 检查到 $FAIL 个问题需要修复${NC}"
    exit 1
fi

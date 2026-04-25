@echo off
REM Avalon Game Platform - 開發環境設置腳本 (Windows)

setlocal enabledelayedexpansion

echo 🚀 Avalon 遊戲平台 - 開發環境設置
echo ==================================
echo.

REM 檢查 Node.js
echo 📋 檢查先決條件...

node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js 未安裝。請訪問 https://nodejs.org/
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo ✅ Node.js %NODE_VERSION%

REM 檢查 pnpm
pnpm --version >nul 2>&1
if errorlevel 1 (
    echo 📦 安裝 pnpm...
    npm install -g pnpm
)
for /f "tokens=*" %%i in ('pnpm --version') do set PNPM_VERSION=%%i
echo ✅ pnpm %PNPM_VERSION%

REM 檢查 Git
git --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Git 未安裝。請訪問 https://git-scm.com/
    exit /b 1
)
echo ✅ Git 已安裝

echo.

REM 檢查倉庫
echo 🔍 檢查倉庫...

if not exist ".git" (
    echo ❌ 不在 Git 倉庫中。請先克隆倉庫。
    exit /b 1
)
echo ✅ Git 倉庫找到

for /f "tokens=*" %%i in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%i
echo 📌 當前分支: %BRANCH%

if not "%BRANCH%"=="claude/avalon-game-platform-0hDJ1" (
    echo.
    echo ⚠️  建議切換到開發分支
    set /p CONFIRM="切換到 claude/avalon-game-platform-0hDJ1? (y/n): "
    if /i "%CONFIRM%"=="y" (
        git checkout claude/avalon-game-platform-0hDJ1
        git pull origin claude/avalon-game-platform-0hDJ1
    )
)

echo.

REM 安裝依賴
echo 📦 安裝依賴...
call pnpm install
if errorlevel 1 (
    echo ❌ pnpm install 失敗
    exit /b 1
)
echo ✅ 依賴安裝完成

echo.

REM 設置環境變數
echo ⚙️  設置環境變數...

if not exist "packages\server\.env" (
    echo 📝 建立 packages\server\.env
    copy packages\server\.env.example packages\server\.env
    echo ⚠️  請編輯 packages\server\.env 並填入 Firebase 配置
)

if not exist "packages\web\.env" (
    echo 📝 建立 packages\web\.env
    copy packages\web\.env.example packages\web\.env
    echo ⚠️  請編輯 packages\web\.env 並填入 Firebase 配置
)

echo ✅ 環境變數設置完成

echo.

REM 類型檢查
echo 🔍 運行類型檢查...
call pnpm type-check
if errorlevel 1 (
    echo ⚠️  類型檢查有警告，但可以繼續
)
echo ✅ 完成

echo.

REM 成功完成
echo ==================================
echo ✅ 開發環境設置完成!
echo.
echo 📖 下一步:
echo   1. 編輯 packages\server\.env (Firebase 配置)
echo   2. 編輯 packages\web\.env (Firebase 配置)
echo   3. 運行: pnpm dev
echo   4. 打開: http://localhost:5173
echo.
echo 📚 更多信息:
echo   - 閱讀: TEAM_GUIDE.md
echo   - 設置: docs\FIREBASE_SETUP.md
echo   - 任務: TEAM_TASKS.md
echo.
echo 💡 有問題? 查看 TEAM_GUIDE.md 的「常見問題」部分
echo.

pause

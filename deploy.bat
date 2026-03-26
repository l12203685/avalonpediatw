@echo off
REM 🚀 Avalon Game Platform - Windows 部署腳本

setlocal enabledelayedexpansion

echo.
echo 🚀 Avalon Game Platform 部署開始...
echo ==================================
echo.

REM 檢查 Node.js
echo ✓ 檢查 Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ 需要安裝 Node.js: https://nodejs.org/
    exit /b 1
)

REM 檢查 npm
npm --version >nul 2>&1
if errorlevel 1 (
    echo ❌ 需要安裝 npm
    exit /b 1
)

REM 安裝全局工具
echo.
echo ✓ 安裝 CLI 工具...
call npm install -g @railway/cli vercel --silent 2>nul

REM Vercel 登入檢查
echo.
echo 🔑 Vercel 認証...
if not exist "%APPDATA%\.vercel" (
    echo ❌ 需要登入 Vercel
    echo.
    echo 執行以下命令登入:
    echo   vercel login
    call vercel login
) else (
    echo ✓ 已登入 Vercel
)

REM Railway 登入檢查
echo.
echo 🔑 Railway 認証...
if not exist "%USERPROFILE%\.railway" (
    echo ❌ 需要登入 Railway
    echo.
    echo 執行以下命令登入:
    echo   railway login
    call railway login
) else (
    echo ✓ 已登入 Railway
)

REM 構建
echo.
echo 🔨 構建項目...
call pnpm install
if errorlevel 1 goto :error
call pnpm build
if errorlevel 1 goto :error

REM 部署前端
echo.
echo 📦 部署前端到 Vercel...
cd packages\web
if not exist ".vercel" (
    echo 首次部署 - 需要設置項目...
    call vercel --prod
) else (
    call vercel --prod
)
if errorlevel 1 goto :error

REM 獲取 Vercel URL
for /f "tokens=*" %%i in ('vercel ls --json ^| find "url"') do (
    set VERCEL_LINE=%%i
)
echo.
echo ✓ 前端部署完成

cd ..\server

REM Railway 部署
echo.
echo 📦 部署後端到 Railway...

REM 初始化 Railway (如果需要)
if not exist ".railway" (
    echo 🔗 初始化 Railway 項目...
    call railway init
)

REM 設置環境變量
echo ⚙️  設置環境變量...
call railway variables set NODE_ENV=production
call railway variables set PORT=3001
call railway variables set FIREBASE_PROJECT_ID=avalon-game-platform
call railway variables set FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@avalon-game-platform.iam.gserviceaccount.com

REM 部署到 Railway
echo 推送代碼到 Railway...
call railway up
if errorlevel 1 goto :error

echo.
echo ✓ 後端部署完成

REM 完成訊息
echo.
echo ==================================
echo ✅ 部署完成！
echo ==================================
echo.
echo 🌐 訪問你的應用:
echo.
echo    前端: 查看 Vercel Dashboard
echo    後端: 查看 Railway Dashboard
echo.
echo 💡 下次更新只需:
echo    git push origin claude/avalon-game-platform-*
echo    (GitHub Actions 會自動部署)
echo.
pause
exit /b 0

:error
echo.
echo ❌ 部署失敗！
pause
exit /b 1

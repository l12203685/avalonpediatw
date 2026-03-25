FROM node:20-alpine

# 安裝 pnpm
RUN npm install -g pnpm

WORKDIR /app

# 複製 workspace 文件
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages

# 安裝依賴
RUN pnpm install --frozen-lockfile

# 構建 server
RUN pnpm -C packages/server build

# 設置工作目錄為 server
WORKDIR /app/packages/server

# 啟動應用
EXPOSE 3001
CMD ["node", "dist/index.js"]

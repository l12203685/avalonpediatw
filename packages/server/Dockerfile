FROM node:20-alpine

# 安裝 pnpm
RUN npm install -g pnpm

WORKDIR /app

# 複製根目錄文件（從 ../ 複製）
COPY ../../pnpm-workspace.yaml ../../pnpm-lock.yaml ./

# 複製所有 packages
COPY ../../packages ./packages

# 安裝依賴
RUN pnpm install --frozen-lockfile

# 構建 server
RUN pnpm -C packages/server build

# 啟動應用
EXPOSE 3001
CMD ["node", "packages/server/dist/index.js"]

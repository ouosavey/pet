# syntax=docker/dockerfile:1

# ========== 阶段 1：编译前端 ==========
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# 先只拷 package*.json，让依赖安装命中缓存层
COPY frontend/package.json frontend/package-lock.json ./
# build = tsc && vite build，tsc 会连测试文件一起做类型检查，需要完整 devDependencies，不能 --omit=dev
RUN npm ci --registry=https://registry.npmmirror.com

COPY frontend/ ./
RUN npm run build
# 产物在 dist/；frontend/public/images 由 Vite 自动复制进 dist

# ========== 阶段 2：安装后端依赖 ==========
# better-sqlite3 含原生模块：优先下载预编译二进制，下载失败时本地编译（需要 python3/make/g++）
# 注意必须装完整依赖（含 devDependencies）：src/services/updater.js 运行时 require('axios')，
# 而 axios 在 devDependencies 里，--omit=dev 会导致服务启动即崩。
FROM node:20-alpine AS backend-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --registry=https://registry.npmmirror.com

# ========== 阶段 3：运行镜像 ==========
FROM node:20-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production PORT=3000 TZ=Asia/Shanghai
WORKDIR /app/backend

# 生产依赖（含编译好的 better-sqlite3）
COPY --from=backend-deps /app/backend/node_modules ./node_modules

# 后端代码与配置（数据库路径基于 __dirname 解析，与工作目录无关）
COPY backend/package.json backend/knexfile.js backend/VERSION ./
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY backend/seeds ./seeds
COPY backend/scripts ./scripts

# 前端编译产物交给后端静态托管（对应部署指南「方案 A：后端托管前端」）
COPY --from=frontend-builder /app/frontend/dist ./public

EXPOSE 3000

# 首次启动：setup.js 幂等初始化（建表 + 种子 + admin 账号，已存在则跳过），然后常驻服务
CMD ["sh", "-c", "node scripts/setup.js && exec node src/server.js"]

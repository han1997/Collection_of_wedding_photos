# ============================================================================
# 婚礼照片收集系统 —— 生产镜像
#
# 构建上下文是**仓库根目录**（需要用根 package.json + lockfile 做 workspaces 安装）：
#   docker build -f server/Dockerfile -t wedding-collect .
#
# 为什么用 Debian 而不是 Alpine：
#   · sharp 的预编译 libvips 是 glibc 的，musl 上跑不了
#   · Debian 的 ffmpeg 包**自带 libheif**，这正是解码 iPhone HEIC 原图所需的
#     （HEIC 只影响能否出缩略图，原图始终原样保存）
#   多出来的 ~60MB 在 ffmpeg 自身的体积面前可以忽略。
# ============================================================================

# ---------------------------------------------------------------------------
# 依赖安装
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# 先只拷清单文件，依赖没变时这一层能命中缓存
COPY package.json package-lock.json ./
COPY server/package.json server/

# sharp 的平台二进制是 npm 上的 optionalDependencies，会随依赖一起装下来，
# 不需要联网去 GitHub 下载，也不需要在镜像里编译原生模块。
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# 运行镜像
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DATA_ROOT=/data \
    PORT=3000

# 用官方 Debian 镜像源，代理能正常访问则优先走代理加速；代理不通则 fallback 到直连。
# 不硬编码国内镜像，避免代理环境下 403。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      tini; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY --chown=node:node server/ ./server/

# 数据目录先建好并交给 node 用户。
# 实际内容由 bind mount 覆盖，但挂载点本身需要存在且可写。
RUN mkdir -p /data && chown -R node:node /data

# 非 root 运行（node 镜像内置 uid/gid 1000）
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 当 PID 1：否则 ffmpeg/ffprobe 这类子进程会变僵尸，
# 而且 SIGTERM 的转发也是错的（停止容器时正在合并的大文件会留成半截）
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "--enable-source-maps", "server/src/index.js"]

# 基础镜像可通过 --build-arg 覆盖（例如国内镜像源 docker.1ms.run/library/node:22-bookworm-slim）
ARG NODE_IMAGE=node:22-bookworm-slim
# 构建阶段用官方全量镜像：自带 python3/make/g++，无需 apt（受限网络里 apt 拉 Debian 源经常卡住），
# better-sqlite3 取不到预编译包时可以直接源码编译
ARG BUILD_IMAGE=node:22-bookworm

# 后端镜像：NestJS + better-sqlite3（原生模块需在构建阶段编译）
FROM ${BUILD_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY config ./config
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config

RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]

# 前端镜像：Vite 构建 + Caddy 静态托管 / 反向代理
# VITE_* 是构建期注入，改域名必须重新 build（不带缓存：--build-arg 变化会自动失效）
# 基础镜像可通过 --build-arg 覆盖（例如国内镜像源 docker.m.daocloud.io/library/node:22-alpine）
ARG NODE_IMAGE=node:22-alpine
ARG CADDY_IMAGE=caddy:2.8-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
ARG VITE_LOGTO_ENDPOINT
ARG VITE_LOGTO_APP_ID
ARG VITE_LOGTO_AUDIENCE
RUN npm run build

FROM ${CADDY_IMAGE}
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 80 443

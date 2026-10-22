# MCP 网关 · Enterprise MCP Gateway

> 面向企业的 **MCP（Model Context Protocol）工具治理网关**。对上是唯一 MCP Server，对下以 MCP Client 聚合 N 个上游 MCP Server，在中间层完成 **鉴权 · RBAC · 限流 · 熔断 · 并发控制 · 审计 · 脱敏 · 凭据加密 · 变更留痕 · 报表** 的治理闭环。

**技术栈（轻量化现代栈）**：`Vue3` + `Vite` + `UnoCSS` + `TypeScript` + `Pinia` ｜ `NestJS` + `TypeORM` + `better-sqlite3` + `MCP SDK` + `zod`
**主题**：语义 token 亮/暗双主题（品牌色 `#398FF6`，深色/浅色一键切换，跟随系统偏好）
**存储**：单文件 SQLite（WAL），零外部依赖，开箱即用

---

## 一、解决什么问题

大模型/Agent 直接对接企业内部工具时，普遍面临：**工具散落无统一入口、权限粗放无法收敛、调用无审计不可追溯、凭据明文散落、敏感数据外泄、上游抖动拖垮全局**。本网关把这些横切治理从各业务方下沉到统一中间层：

- **一个入口**：Agent 只需连网关一个 MCP Server，即可访问被授权的全部上游工具（命名空间 `upstream__tool`）。
- **可见即可调**：`tools/list` 返回的工具集与 RBAC 放行集**同源**，模型看到的就一定能调，杜绝"列得出调不动"。
- **全链路留痕**：谁、何时、用哪个 Key、调了哪个工具、参数摘要、耗时、结果、是否触敏脱敏，逐条可查、可导出。
- **纵深防御**：出站 SSRF CIDR 白名单、凭据 AES-256-GCM 加密、PII 脱敏、令牌桶限流、三态熔断、上游并发信号量。

---

## 二、架构总览

```
                    ┌──────────────────────────── MCP 网关（本项目）────────────────────────────┐
                    │                                                                            │
  Agent / LLM       │   MCP 通道(对客户端)          治理链(每次调用顺序执行)          上游通道(对下)   │
 ┌──────────┐  MCP  │  ┌───────────────┐   ┌──────────────────────────────────┐  ┌────────────┐ │
 │ Claude / │──────▶│  │ POST /mcp      │   │ 鉴权(Bearer Key)                  │  │ 上游 A      │ │
 │ Cursor / │ Stream│  │  · initialize  │──▶│  → RBAC(通配符/首条命中/默认拒绝)  │─▶│ (HTTP MCP) │ │
 │ 自研 App │  HTTP  │  │  · tools/list  │   │  → 令牌桶限流(key×tool)           │  ├────────────┤ │
 └──────────┘  +SSE │  │  · tools/call  │   │  → 三态熔断 + 并发信号量           │  │ 上游 B      │ │
                    │  └───────────────┘   │  → 路由转发 → 脱敏 → 审计攒批      │  │ (stdio)    │ │
                    │                       └──────────────────────────────────┘  └────────────┘ │
                    │   Admin 通道(对管理员，代码路径完全隔离)                          │            │
  管理员 ┌────────┐ │  ┌───────────────────────────────────────────────┐            ▼            │
 ───────▶│ 管理后台│─│─▶│ /admin/api/*  上游·工具·权限·Key·审计·变更·报表·设置 │   ┌──────────────┐ │
  浏览器 │ Vue3 UI│ │  └───────────────────────────────────────────────┘   │ SQLite (WAL)   │ │
         └────────┘ │                                                        │ gateway.db     │ │
                    │                                                        └──────────────┘ │
                    └────────────────────────────────────────────────────────────────────────┘
```

- **两条通道物理隔离**：`/mcp`（对模型，用 API Key）与 `/admin/api`（对管理员，用 Logto OIDC access token）不共享代码路径，降低越权面。
- **治理链显式编排**：`GatewayRouterService` 按固定顺序调用各治理 Service，任一环节拒绝即刻短路并落审计。
- **注册表版本化**：工具集/规则集变更会 bump `registryVersion`/`rulesVersion`，RBAC 结果按版本缓存，并向在线会话广播 `tools/list_changed`。

---

## 二·五、本期 P0 交付摘要（6 项）

> 对应 PRD 13.2 · 14.1 · 8.1 本迭代补强的 6 个 P0 项，已上线 + 冒烟护栏（`smoke-p0.sh` 18/18 全通过）。

| 项     | 能力                                                                                                                                                     | 入口                                                                                                         | 对应 PRD |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- |
| **F1** | **RBAC 影子模式 observe** · 越权调用放行、仅写 `event=rbac_would_forbid` 审计，支持上线前灰度验证新规则                                                  | `Permissions.vue` 顶部“强制/影子”开关 · `Reports.vue` “若切 enforce 会拦下 N 次”卡 · `settings['rbac.mode']` | 13.2-5   |
| **F2** | **权限矩阵一键回滚** · 基于 `change_logs.before_json` 快照回滚角色规则，新行仍留痕                                                                       | `Changes.vue` 行内“回滚”按钮 · `POST /admin/api/roles/:name/rules/rollback`                                  | R8       |
| **F3** | **影响面预览量化** · 新增 `affectedKeyCount` / `recent7dCalls` / `lostCalls7d` / `gainedCalls7d` / `totalImpact7d`，保存前直接看到“会屏蔽多少次现实调用” | `POST /permissions/preview` · `PUT /roles/:name/rules?dryRun=true` · `Permissions.vue` 预览弹窗              | 7.2-3    |
| **F4** | **Key 吊销即时失效**（≤ 2s） · `revoke()` 同事务内清理 `authCache` + `hashToId`，预定位 `invalidate()` 为 P2 多实例预埋                                  | `POST /admin/api/keys/:id/revoke` · `apikey.service.ts::revoke/invalidate`                                   | 6.3      |
| **F7** | **事件循环延迟监控** · `perf_hooks.monitorEventLoopDelay` 5s 采样 · p99 > 200ms 自动 IM 告警 · `history.reset()` 避免累积钝化                            | `GET /healthz` 含 `el_p99_ms` · `GET /metrics` 含 p50/p95/p99/max/mean · `common/event-loop-monitor.ts`      | 8.1      |
| **F9** | **stdio 上游 crash loop 自动熔断** · 5min 滑窗 ≥ 5 次启动失败 → 自动 `enabled=0` + `last_error=crash_loop` + IM 告警                                     | 健康检查内部 · `change_logs.action='auto-disable'` · `upstream-manager.service.ts`                           | 13.1-3   |

**护栏覆盖**：`scripts/smoke-p0.sh` 17 个断言步骤，全部针对以上 6 项 + 上期 3 个 bug 回归。与 `smoke-domestic.sh`（主链 15 断言）互补，后者验证“功能可用”，前者验证“本期改造没坏”。

---

## 二·六、P1 首批增量交付（3 项快赢）

> 对应 docs/todo.md 第六节，本批以“上线前可验收 + 交付后可持续运维”为定位。已上线 + 冒烟护栏（`scripts/smoke-p1.sh` 16/16 全通过）。

| 项       | 能力                                                                                                                                                                                                                                           | 入口                                                                                                                                    | 对应 PRD / todo    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **P1-C** | **熔断事件面板** · `BreakerService` 返值从字符串升级为 `BreakerTransition` 结构，健康度趋势入 `circuit_breaker_events` 表；主链 onSuccess/onFailure + 探活恢复三处埋点；面板展示实时三态 + 高频熔断 Top + 事件时间线                           | `/#/breaker` 新页 · `GET /admin/api/breaker/{status,events,summary}` · `database/entities/breaker-event.entity.ts`                      | todo 6.1           |
| **P1-A** | **数据库自动备份** · `better-sqlite3` 官方 `db.backup()` API（WAL 下不丢数据）· node-cron 默认每日 03:00 Asia/Shanghai · 滚动保留 7 份 · 面板一键备份 + 历史下载 · cron 表达式热更新无需重启                                                   | `/#/backups` 新页 · `POST /admin/api/backups/run` · `GET /admin/api/backups/:id/download` · `settings['backup.{enabled,cron,tz,keep}']` | todo 6.2           |
| **P1-B** | **Prometheus 标准指标** · prom-client 独立 Registry 不污染默认 · `mgw_` 前缀 · 默认指标（process / eventloop lag / heap）+ 6 个业务 gauge + tool_call 计数/延时 histogram。`/metrics` JSON 保留与旧 smoke 兼容，新增 `/metrics.prom` text 端点 | `GET /metrics.prom` Content-Type: text/plain · `governance/metrics.service.ts`                                                          | PRD 8.1 · todo 6.3 |

**护栏覆盖**：`scripts/smoke-p1.sh` 16 步·P1-C 结构断言 5 步 + P1-A 备份闭环 6 步（run → list → download → 字节一致性）+ P1-B Prometheus 4 步（text + 6 gauge + 默认指标 + JSON 兼容）。与 smoke-p0/smoke-domestic 同位阶，任何一项退化都会直接红。

---

## 二·七、P1 收尾包增量交付（4 项尾巴）

> 对应 docs/todo.md 第八节，把 P1 首批里推到后续的 3 条“已知限制” + 1 条“IM 告警尾巴”一次性清零。已上线 + 冒烟护栏（`scripts/smoke-p1b.sh` 13/13 全通过），无新依赖引入。

| 项       | 能力                                                                                                                                                                                                                                                 | 入口                                                                     | 对应 PRD / todo       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------- |
| **P1-D** | **备份失败 IM 告警** · `NotifyService` 新增 `backupFailed` / `backupPruneFailed`，同 trigger 5min 抑制，与 F7 事件循环告警同位阶；cron/manual 失败 / 旧份 unlink 失败都会即时推 IM                                                                   | `notify/im.service.ts` · `governance/backup.service.ts::run/prune`       | PRD 13.1-4 · todo 8.1 |
| **P1-E** | **HTTP 入口 QPS/延时 histogram** · `MetricsMiddleware` 全路由埋点，`mgw_http_requests_total{method,route,status}` + `mgw_http_request_duration_ms` 14 buckets；归一化路由模板防标签爆炸；监控入口自身双向排除避免自反馈                              | `GET /metrics.prom` · `governance/metrics.middleware.ts`                 | PRD 8.1 · todo 8.2    |
| **P1-F** | **熔断面板 SSE 实时推流** · `BreakerEventsService` 内置 `Subject`，`@Sse('events/stream')` endpoint 输出，25s 心跳防 Nginx 切断；`AdminTokenGuard` 仅对 `/stream` 开放 `?token=` query（EventSource 无法设 header）；前端 EventSource + 60s 全量兜底 | `/#/breaker` 顶部徽章 · `GET /admin/api/breaker/events/stream?token=xxx` | todo 8.3              |
| **P1-G** | **Grafana 看板 & Prometheus 模板** · 11 panel Dashboard JSON + scrape_config yml + docker-compose.observability.yml 一键拉起，导入即可看到 QPS/延时/错误率/熔断时间线/运行态 gauge 全套                                                              | `docs/grafana/README.md` · `gateway-overview.json` · `prometheus.yml`    | PRD 8.3 · todo 8.4    |

**护栏覆盖**：`scripts/smoke-p1b.sh` 13 步·P1-D 静态 2 步 + P1-E 结构/归一化/自反馈 4 步 + P1-F 建连/鉴权 3 步 + P1-G 目录/JSON/yml 3 步 + 前置 healthz 1 步。与 smoke-p1/p0/domestic 同位阶，重跑均无退化。

---

## 二·八、仪表盘 Seed 工具（数据源头 · 一次性 3–5 分钟灌完）

> 解决“新环境部署完仪表盘空空”痛点。走**真实注册上游 → 真实同步工具 → 真实写入 RBAC 规则 → 真实 tools/call 打流量**的完整链路把 Dashboard 6 张卡 + 趋势柱 + Top 10 + 高失败率榜一次填满，所有审计都过完整治理链（限流/熔断/RBAC/PII/audit_logs），**非直插 DB**。

| 组件                | 交付                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mock MCP Server** | `scripts/mock-mcp-server.mjs` · 单文件 3 variant · 共 25 工具（basic 9 快速 · finance 8 中长+3–12% 失败 · ops 8 长+5–22% 失败），走 SDK `McpServer` + `StdioServerTransport`                                                                                               |
| **Seed 主脚本**     | `scripts/seed-dashboard.sh` · 20 步：健康检查 → 幂等注册 3 mock 上游（已存在且健康则跳过 PUT 防 registry 抖动与旧 session 失效）→ 探活同步工具 → admin/support 角色**增量合并** allow 规则 → 签发 4 Key → 开 4 MCP session → 并发打流量 → 断言 overview/timeseries/metrics |
| **并发打流量**      | `scripts/seed-calls.py` · **按 upstream 分桶**，每桶 `ThreadPoolExecutor(max_workers=2)` 与后端 stdio `effLimit=2` 严格对齐，避免 `UPSTREAM_BUSY` 不落审计的短路                                                                                                           |

```bash
./start.sh &                                        # 后端在跑
./scripts/seed-dashboard.sh                         # 默认 12 次/工具 · ≈300 次调用 · 60–90s
./scripts/seed-dashboard.sh --calls 20              # 每工具 20 次 · 让 failTop 阈值命中（演示推荐）
./scripts/seed-dashboard.sh --concurrency 1         # 同上游内完全串行，零排队，耗时翻倍
```

**seed 完成后 Dashboard 会显示**（当前环境实测 · --calls 20）：

- **上游连通性** 4 / 4 全部 `up`（rail-12306 + 3 mock）
- **注册工具** 33 个（rail 8 + mock 25）
- **近 7 日调用** 900+ · 失败 50+ · 5.4% 失败率
- **Top 10 热点工具** 满：b64/echo/md5/now/random_int 各 33 次
- **高失败率榜** 3 位：get-current-date@26.9% · news@18.2% · get_metrics@12.1%
- **24 小时趋势柱**：主峰 800+ · 7 桶非零

**幂等**：脚本可反复跑 · 已存在且健康的 mock 上游会跳过 PUT（防 registry 抖动 + session 失效）；Key 每次会新签一把（旧 Key 不删不影响 seed 效果，UI 里手动吊销即可）；RBAC 规则为**增量合并**（幂等），只补 mock-\_\_\_\_ allow，不动原有 rail-12306 相关规则。

**顺手修一个产品级 bug**：seed 过程中发现 `ConcurrencyService.release()` 存在 slot 泄漏 —— 有 waiter 时只走 `next()` （内部 `active++`）而不先 `active--`，导致 `active` 无上限累加，一旦上游卡一下后面就永远 `UPSTREAM_BUSY`（且该分支不落审计，Dashboard 上完全看不到）。已修为**无条件先 `active--`，再 shift waiter**（`backend/src/governance/concurrency.service.ts`）。`smoke-p0/p1/p1b/domestic` 4 档 66 步回归全绿，无破坏。

---

## 三、目录结构

```
mcp-agent/
├─ MCP网关产品技术PRD.md        # 需求来源
├─ README.md                    # 本文件
├─ start.sh                     # 一键启停脚本（自动 .env 加载 + 优雅停止 + 端口预检）
├─ .gitignore                   # 屏蔽 node_modules / dist / .env / data / .run / logs
├─ scripts/                     # 运维/测试辅助
│  ├─ mgw-fmt.py                # 格式化
│  ├─ smoke-test.sh             # 轻量冒烟（stdio env 白名单 / ZodExceptionFilter / 优雅停止 三大回归）
│  ├─ smoke-domestic.sh         # 深度冒烟（国内上游 12306-mcp 真实调用 + 仪表盘指标全覆盖）
│  ├─ smoke-p0.sh               # P0 护栏（F1–F9 6 项 P0 + 上期 3 bug 回归）
│  ├─ smoke-p1.sh               # P1 首批护栏（熔断面板 + 备份闭环 + Prometheus）
│  ├─ smoke-p1b.sh              # P1 收尾包护栏（IM 告警 + HTTP histogram + SSE + Grafana 模板）
│  ├─ seed-dashboard.sh         # 仪表盘 seed（3 mock 上游 + 4 Key + 真实 tools/call 打流量 · 20 步幂等）
│  ├─ seed-calls.py             # Seed 内使用的并发打流量 helper（按 upstream 分桶·与 stdio effLimit=2 对齐）
│  └─ mock-mcp-server.mjs       # Mock MCP stdio server（basic/finance/ops 3 variant·共 25 工具）
├─ docs/
│  ├─ 产品方案.md               # 产品经理视角：定位/角色/场景/功能/指标
│  ├─ 技术架构.md               # 架构师视角：分层/数据模型/治理链/时序/权衡
│  ├─ 部署运维.md               # 生产部署：Nginx/systemd/Docker/备份/加固
│  ├─ todo.md                   # 本期迭代计划与验收结果（P0 + P1 首批 + P1 收尾包）
│  └─ grafana/                  # P1-G・可观测入口（docker-compose 一键拉起参考）
│     ├─ README.md               # 导入步骤 + 3 条告警 rule + 指标清单
│     ├─ gateway-overview.json   # 11 panel Grafana Dashboard（导入即用）
│     └─ prometheus.yml          # scrape_configs 示例
├─ backend/                     # NestJS 网关后端
│  ├─ src/
│  │  ├─ config/                # 三级配置(env > gateway.json > 默认)
│  │  ├─ database/              # 实体(11 表)、data-source、seed
│  │  ├─ auth/                  # ApiKey、RBAC、Crypto(AES-256-GCM)
│  │  ├─ governance/            # 限流、熔断、并发、审计、脱敏
│  │  ├─ gateway/               # registry、upstream、router、stdio
│  │  ├─ transport/             # MCP 通道(/mcp)、session 管理
│  │  ├─ admin/                 # Admin REST API(/admin/api/*)、变更留痕
│  │  ├─ notify/                # IM Webhook 告警
│  │  ├─ common/                # logger、errors、工具
│  │  ├─ bootstrap.service.ts   # 启动引导(配置→注册表→规则→连上游)
│  │  ├─ app.module.ts
│  │  └─ main.ts
│  ├─ config/gateway.json       # 基础配置(非敏感)
│  └─ data/gateway.db           # SQLite(运行时生成，WAL)
└─ frontend/                    # Vue3 管理后台
   └─ src/
      ├─ api/                   # 类型化 API 层 + fetch 封装
      ├─ components/            # Icon/Modal/Toast/PageHeader/Empty/Spinner
      ├─ layouts/AdminLayout.vue
      ├─ views/                 # 10 大管理页
      ├─ stores/ router/ composables/ utils/ styles/
      └─ uno.config.ts          # 设计系统：语义 token shortcuts（颜色全部指向 CSS 变量）
```

---

## 四、快速开始

**前置**：Node.js **≥ 20.18.1**（`better-sqlite3` 为原生模块，需本地编译工具链；macOS 装 Xcode CLT，Linux 装 `build-essential python3`）。

### 0) 一键启动（推荐）

项目根提供了 [`start.sh`](./start.sh)，自动完成：依赖预检 → `.env` 加载 → 幂等 seed → 前后端并行启动（带颜色前缀）→ Ctrl+C 优雅停止。

```bash
# 首次使用：拷一份 .env 模板，按需修改 MGW_SECRET / LOGTO_ISSUER / LOGTO_AUDIENCE / DEEPSEEK_API_KEY 等
cp backend/.env.example backend/.env

./start.sh              # 一键启前后端
./start.sh --stop       # 另开终端优雅停止
./start.sh --force      # 端口被占时自动强制接手
./start.sh --no-seed    # 确定库结构就绪时跳过 seed
./start.sh --help       # 帮助
```

启动后终端会打印实际监听地址：前端 `http://127.0.0.1:5173`（管理后台）、后端 `http://127.0.0.1:8080/mcp`（MCP 入口）。

> **关于 `.env`**：`backend/.env` 已被 [`.gitignore`](./.gitignore) 屏蔽不会入仓；start.sh 在当前 shell 里 `set -a; source backend/.env; set +a` 确保 MGW\_\* 与自定义变量（如 `DEEPSEEK_API_KEY`）能流向后端进程与 stdio 子进程。

以下为手动分目启动方式（与一键脚本等效）：

### 1) 启动后端

```bash
cd backend
npm install
npm run seed          # 初始化：内置角色/规则/系统设置 + 签发一把演示 admin Key(明文打印在控制台)
npm run start:dev     # 开发模式(热重载)，监听 http://127.0.0.1:8080
# 生产：npm run build && npm run start:prod
```

### 2) 启动前端

```bash
cd frontend
npm install
npm run dev           # http://127.0.0.1:5173 ，已配 proxy 将 /admin/api、/healthz、/metrics 转发到 :8080
```

### 3) 登录管理后台

管理端**不再使用静态 Admin Token**，而是走 Logto OIDC：浏览器打开 `http://127.0.0.1:5173`，点击登录会跳转到 Logto 托管登录页，登录成功后回到后台。

- 首次使用需先在 Logto 里创建账号（或由管理员在 Admin Console `http://localhost:3002` 邀请）
- 身份与权限来自 access token：`gateway:read`（读）、`gateway:write`（写）、`gateway:sensitive`（高危操作：审计/Key/备份/写设置）
- 审计/变更记录的操作者取自 token 的 `sub`，不可伪造
- 右上角「账号设置」可跳转 Logto Account Center 修改展示名/头像

后端需要配置 `LOGTO_ISSUER`（如 `http://localhost:3001/oidc`）与 `LOGTO_AUDIENCE`（与 Logto API Resource indicator 一致，如 `https://api.gateway.local`）。

### 4) 冒烟测试（可选，改核心链路后建议跑一次）

`scripts/` 下提供三档冒烟，均依赖 `./start.sh` 已在跑 `:8080`。管理端只认 Logto JWT，脚本通过 `scripts/mgw-token.sh` 用机器身份（`MGW_M2M_CLIENT_ID` / `MGW_M2M_CLIENT_SECRET`，client_credentials）换 token 并缓存 15 分钟；也可用环境变量 `MGW_TOKEN` 直接注入。

```bash
# 轻量档：16 步 · 覆盖鉴权/RBAC/限流/审计/脱敏/变更留痕 + 3 个已修 bug 的回归
./scripts/smoke-test.sh

# 深度档：18 步 · 建立 12306-mcp 国内上游 → 3 次真实余票查询 → 仪表盘全指标断言
#         前置：cd backend && npm i --no-save --registry=https://registry.npmmirror.com 12306-mcp
./scripts/smoke-domestic.sh                # 默认收尾会软删上游 + 吊销 Key
./scripts/smoke-domestic.sh --no-cleanup   # 保留上游和 Key 用于 UI 演示
./scripts/smoke-domestic.sh --from 广州 --to 深圳 --days 5   # 自定义线路

# P0 护栏（本期新增）：17 步 · F1–F9 6 项 P0 + 上期 3 bug 回归
#         需至少 1 个已连通上游，脚本会自动选当前 registry 中的首个工具作为测试目标
./scripts/smoke-p0.sh                      # 默认收尾会删临时角色/Key + 恢复 enforce
./scripts/smoke-p0.sh --keep               # 保留临时角色与 Key 便于事后排查

# P1 护栏（本批新增）：16 步 · P1-C 熔断面板结构 + P1-A 备份闭环 + P1-B Prometheus 标准指标
./scripts/smoke-p1.sh                      # 默认收尾会清理临时下载文件（保留备份本体）
./scripts/smoke-p1.sh --keep               # 保留 /tmp 下的下载产物供人工验证

# P1 收尾包护栏（本批新增）：13 步 · P1-D IM 告警静态 + P1-E HTTP histogram + P1-F SSE 建连 + P1-G Grafana 模板
./scripts/smoke-p1b.sh                     # 无副作用 · 可反复跑

# 仪表盘 Seed（可选）：20 步 · 3 mock 上游 + 4 Key + 真实 tools/call 打流量
#         一次性把 Dashboard 卡片/趋势柱/Top 榜/高失败率榜灌满（非直插 DB · 全走治理链）
./scripts/seed-dashboard.sh                # 默认 12 次/工具 · ≈300 次调用 · 60–90s
./scripts/seed-dashboard.sh --calls 20    # 演示推荐（让 failTop 阈值 20 能命中）
```

跑完会打印 `PASS N / FAIL M · 步骤 K`，任何 FAIL 会附带上下文与断言表达式。推荐回归顺序：`smoke-test.sh → smoke-domestic.sh → smoke-p0.sh → smoke-p1.sh → smoke-p1b.sh`。

---

## 五、默认凭据与内置角色

`npm run seed` 会写入三个内置 RBAC 角色（规则按 sort 升序、首条命中即决定、无命中默认拒绝，`deny` 组自动排在 `allow` 组前）：

| 角色      | 语义   | 规则要点                                                                            |
| --------- | ------ | ----------------------------------------------------------------------------------- |
| `intern`  | 实习生 | 拒绝一切 `*__delete_*` / `*__write_*` / `finance__*`；仅放开 `wiki__*`、`*__search` |
| `support` | 客服   | 拒绝 `crm__delete_*`、`finance__refund_*`；放开 `crm__*`、`wiki__*`、`order__*`     |
| `admin`   | 管理员 | 仅拒绝 `*__drop_*`；放开 `*`                                                        |

若库中无任何 Key，seed 会签发一把演示 **admin** Key 并在控制台**打印一次明文**（形如 `mgw_live_xxx...`），用于 MCP 通道联调。请妥善保存——明文不再二次展示。

---

## 六、作为 MCP Server 被调用

MCP 通道：`POST /mcp`（JSON-RPC 2.0，支持批量），鉴权头 `Authorization: Bearer <MCP API Key>`，协议版本 `2025-06-18`（回落 `2025-03-26`）。会话通过响应头 `Mcp-Session-Id` 建立、后续请求回传该头复用。

```bash
KEY="mgw_live_你的演示Key"

# 1) initialize —— 建立会话，读取响应头 Mcp-Session-Id
curl -i -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 2) tools/list —— 返回该 Key 角色「可见即可调」的工具集
curl -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Mcp-Session-Id: <上一步返回>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) tools/call —— 调用某个工具(命名空间 upstream__tool)
curl -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -H "Mcp-Session-Id: <会话ID>" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wiki__search","arguments":{"q":"报销流程"}}}'
```

在 Claude Desktop / Cursor 等客户端中，把网关配置为一个 Streamable HTTP MCP Server 即可（URL = `http://<host>:8080/mcp`，Header 带上 Bearer Key）。

---

## 七、管理后台 · 10 大页面

| 页面       | 路由           | 职责                                                                                                                                         |
| ---------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 仪表盘     | `/dashboard`   | 运行态总览：健康、注册表版本、会话数、上游连通、审计队列、**事件循环 p99**                                                                   |
| 上游服务   | `/upstreams`   | 增删改上游（HTTP/stdio）、探测连通、刷新工具、凭据加密存储；**stdio crash loop 自动熔断下线**                                                |
| 工具目录   | `/tools`       | 聚合工具浏览、描述覆写(含注入告警)、单独上下线、工具级限流                                                                                   |
| 权限矩阵   | `/permissions` | 角色规则编辑器 + 保存前 dryRun 预览(得失工具/受影响 Key/**近 7d 实际命中量**) + 矩阵视图；**顶部“强制/影子”开关**                            |
| API Key    | `/keys`        | 签发/轮换/吊销，明文一次性展示，按使用者/角色/状态筛选；**签发与轮换需 `gateway:sensitive`，吊销只需写权限**；吊销 ≤ 2s 即时失效             |
| 审计日志   | `/audit`       | 多维组合筛选（含 `event` / `errorCode` / `role`）+ 分页 + 详情(全量参数/错误) + CSV 导出                                                     |
| 变更记录   | `/changes`     | 治理面写操作留痕，变更前后快照 diff；**行内一键回滚角色规则**                                                                                |
| 数据报表   | `/reports`     | 调用趋势(SVG)、热点工具/上游/用户、失败率 Top、各上游 P95；**影子模式命中卡**                                                                |
| 熔断事件   | `/breaker`     | **P1-C**・上游健康度趋势：实时三态网格 + 高频熔断 Top + 事件时间线（opened/recovered 分页），**P1-F SSE 推流实时提醒新迁移**，与调用报表分离 |
| 数据库备份 | `/backups`     | **P1-A**・自动备份面板：一键备份 + 历史列表 + 字节一致性下载 + 恢复流程说明                                                                  |

---

## 八、Admin REST API 概览

统一前缀 `/admin/api`，鉴权：`Authorization: Bearer <Logto access token>`（scope：`gateway:read` / `gateway:write` / `gateway:sensitive`）。操作者由后端从已验签 token 的 `sub` 取得，不再接受 `x-admin-user`。

| 模块                   | 端点（节选）                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游                   | `GET/POST /upstreams`、`PUT/DELETE /upstreams/:name`、`POST /upstreams/:name/probe\|refresh`                                                                                                      |
| 工具                   | `GET /tools`、`GET /tools/:fullName`、`PUT /tools/:fullName/description\|enabled\|ratelimit`                                                                                                      |
| 角色/规则              | `GET/POST /roles`、`DELETE /roles/:name`、`GET/PUT /roles/:name/rules`(支持 dryRun)、**`POST /roles/:name/rules/rollback`**                                                                       |
| 权限                   | `POST /permissions/preview`、`GET /permissions/matrix`                                                                                                                                            |
| Key                    | `GET/POST /keys`、`POST /keys/:id/revoke`、`POST /keys/:id/rotate`、**`POST /keys/revoke-user`**（按使用者一键吊销全部有效 Key，离职/封禁用）                                                     |
| 审计/变更              | `GET /audit`（支持 `role` / `event` / `errorCode` 等 10+ 参数）、`GET /audit/:id`、`GET /audit/export`、`GET /changes`                                                                            |
| 报表                   | `GET /stats/overview`、`GET /stats/timeseries`                                                                                                                                                    |
| **熔断事件**（P1-C）   | `GET /breaker/status`、`GET /breaker/events`（支持 `upstream`/`event`/`from`/`to`/分页）、`GET /breaker/summary?days=N`、**`GET /breaker/events/stream`**（P1-F・SSE 长连，支持 `?token=` query） |
| **数据库备份**（P1-A） | `GET /backups`（分页 + `status` 筛选）、`GET /backups/summary`、`POST /backups/run`（手动触发）、`GET /backups/:id/download`                                                                      |
| 系统                   | `GET /healthz`、`GET /metrics`、`GET /metrics.prom`、`GET /system/registry`、`POST /system/registry/refresh`、`GET/PUT /settings`（读写均需 `gateway:sensitive`）                                 |

---

## 九、配置参考

三级优先级：**环境变量 > `backend/config/gateway.json` > 内置默认**。敏感项（`MGW_SECRET`、`LOGTO_*`、`MGW_M2M_CLIENT_SECRET`）请走环境变量或 `*_FILE`（Docker/K8s secret 挂载），**勿写入 json 提交仓库**。

| 环境变量                                      | 默认值                                   | 说明                                                   |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `MGW_PORT` / `MGW_HOST`                       | `8080` / `127.0.0.1`                     | 监听端口与地址                                         |
| `MGW_DATA_DIR`                                | `./data`                                 | SQLite 与备份目录                                      |
| `MGW_PUBLIC_ORIGIN`                           | `http://127.0.0.1:8080`                  | 对外基址（启动日志展示 + MCP Origin 校验）             |
| `MGW_ALLOWED_ORIGINS`                         | 空                                       | 允许的浏览器 Origin（逗号分隔，防 DNS rebinding）      |
| `MGW_SECRET` / `MGW_SECRET_FILE`              | 开发兜底(64×`a`)                         | **AES-256-GCM 主密钥(64 hex)**，加密上游凭据。生产必设 |
| `LOGTO_ISSUER`                                | `http://localhost:3001/oidc`             | 管理端 JWT issuer，须与 Logto endpoint 一致            |
| `LOGTO_AUDIENCE`                              | `https://api.gateway.local`              | 管理端 JWT audience，与 Logto API Resource 一致        |
| `MGW_M2M_CLIENT_ID` / `MGW_M2M_CLIENT_SECRET` | 空                                       | 仅本地/CI：回归脚本换管理端 token 的机器身份           |
| `MGW_OUTBOUND_ALLOWED_CIDRS`                  | `10.0.0.0/8,127.0.0.1/32,192.168.0.0/16` | 出站 SSRF 白名单（`169.254.0.0/16` 永久拒绝）          |
| `MGW_MAX_SESSIONS`                            | `300`                                    | MCP 会话上限                                           |
| `MGW_SESSION_IDLE_TIMEOUT_S`                  | `1800`                                   | 会话空闲超时(秒)                                       |
| `MGW_STDIO_MAX`                               | `8`                                      | stdio 上游子进程上限                                   |
| `MGW_AUDIT_FLUSH_MS` / `MGW_AUDIT_FLUSH_SIZE` | `1000` / `100`                           | 审计攒批刷盘阈值                                       |
| `MGW_REGISTRY_REFRESH_INTERVAL_S`             | `300`                                    | 注册表定时刷新间隔                                     |
| `MGW_IM_WEBHOOK`                              | 空                                       | 熔断/告警推送的 IM Webhook                             |
| `MGW_CONFIG`                                  | `./config/gateway.json`                  | 中间层配置文件路径                                     |
| `NODE_ENV`                                    | `development`                            | 运行环境                                               |

完整环境变量模板见 [`backend/.env.example`](backend/.env.example)。

### settings 表内可配项（管理页 `/settings` 或直接 `PUT /admin/api/settings`）

| key                                                      | 默认            | 说明                                                                                  |
| -------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| `ratelimit.default_qpm` / `ratelimit.burst`              | `30` / `30`     | 全局限流默认（Key × Tool 令牌桶）                                                     |
| `upstream.timeout_ms` / `upstream.concurrency`           | `20000` / `20`  | 上游默认超时与并发                                                                    |
| `audit.enabled` / `audit.args_full_threshold`            | `1` / `4096`    | 审计开关与全量入库阈值                                                                |
| `registry.refresh_interval_s` / `session.idle_timeout_s` | `300` / `1800`  | 注册表刷新与会话空闲                                                                  |
| `rbac.mode`                                              | `enforce`       | **F1** 影子模式开关：`enforce` 默认拒绝 · `observe` 放行但写 `rbac_would_forbid` 审计 |
| `backup.enabled`                                         | `1`             | **P1-A** 自动备份总开关，关闭后仅保留面板手动备份能力                                 |
| `backup.cron`                                            | `0 3 * * *`     | **P1-A** 标准 node-cron 5 段表达式，变更后 `reloadCron` 即时重挂无需重启              |
| `backup.tz`                                              | `Asia/Shanghai` | **P1-A** cron 时区（与日志时间轴一致）                                                |
| `backup.keep`                                            | `7`             | **P1-A** 滚动保留份数，超出后自动清理旧文件与旧行（失败行永不删）                     |

---

## 十、安全须知（生产上线前务必）

1. **改主密钥与身份配置**：设置强随机 `MGW_SECRET`（`openssl rand -hex 32`；`NODE_ENV=production` 下缺失会直接拒绝启动）；管理端接入正式 Logto（`LOGTO_ISSUER` / `LOGTO_AUDIENCE`），并在 Logto 里按最小权限分配 `gateway:read` / `gateway:write` / `gateway:sensitive`。一旦 `MGW_SECRET` 变更，历史加密的上游凭据将无法解密，需重新录入。
2. **建表方式切换**：MVP 用 TypeORM `synchronize` 自动建表；生产建议关闭并改用 migration（见部署文档）。
3. **传输加密**：对外一律经 Nginx/反代终止 TLS，网关只在内网监听 `127.0.0.1`。
4. **收敛出站白名单**：`MGW_OUTBOUND_ALLOWED_CIDRS` 按实际上游网段最小化。
5. **最小权限**：为每类调用方建独立角色与 Key，善用 `deny` 前置与到期时间；定期轮换。
6. **stdio 上游环境变量隔离**：网关为防主密钥泄露给第三方子进程，**不会**将 backend 进程的 `process.env` 默认传递或覆盖到 stdio 子进程，仅允许白名单（PATH/HOME/LANG/LC\_\*/TZ/NODE_ENV 等）。业务凭据（如 `DEEPSEEK_API_KEY`）必须在上游记录的 `env` 字段中显式声明（AES-256-GCM 加密存储），确保隔离粒度为“每个上游一份”。
7. **`.env` 与仓库**：本地开发推荐 `cp backend/.env.example backend/.env`，`start.sh` 会自动 source；`.gitignore` 已屏蔽 `**/.env` 以防误交。生产环境直接以 systemd `EnvironmentFile=` 或 Docker `env_file:` 喂入，不依赖仓库内文件。
8. **`/metrics.prom` 与内网限制**：Prometheus 拉取端点与 `/metrics` `/healthz` 同为无鉴权，生产应在 Nginx 反代层限制 `allow 10.0.0.0/8; allow 127.0.0.1; deny all;`，或至少隔离到一个内网域。
9. **备份目录与主机隔离**：`data/backup/` 默认与主库同盘同目录，仅提供“防手滑 / 防默认 cron 丢库”的快照；防 ransomware / 防机房故障需要额外上对象存储（rsync/s3 sync）同步，面板下载接口便于你接。
10. **SSE token query 与日志屏蔽**：`/admin/api/breaker/events/stream?token=xxx`（P1-F）因 EventSource 无法设 header，开放了 query 兜底。Nginx 默认 `access_log` 会记 URL，包含 query——建议为 SSE 路径单独定义 `log_format` 剔掉 args，或至少确认日志存储与主机日志隔离：`location ~ /stream$ { access_log off; proxy_pass http://mgw; }`。timingSafeEqual 同位阶。
11. **单副本部署约束**：MCP 会话（`Mcp-Session-Id` → caller 快照）保存在进程内存，重启后所有客户端需重新 `initialize`；多副本时请求落到别的实例会返回 `-32002 Session not found`。当前版本按**单实例**部署，若要扩容需先做会话外置或前置粘性会话。
12. **离职 / 封禁处置**：Logto 里禁用账号只影响控制台登录，**不会**让其 `mgw_live_` Key 失效。正确顺序是：先在 Logto 停用账号，再在 Keys 页「按使用者吊销」或调用 `POST /admin/api/keys/revoke-user`（`{ "userName": "...", "reason": "offboard" }`）吊销其名下全部 Key。

---

## 十一、上游集成示例 · 国内开源 MCP（12306-mcp）

想直观看到「一个上游 → 治理 → MCP 通道 → 真实业务」的完整闭环？我们精选了中国铁路余票查询的社区开源 MCP Server [`12306-mcp`](https://github.com/chen3feng/12306-mcp)（无需 API Key，直连 12306 公开数据），作为**零门槛可复现**的国内上游示例。

### 选型对比

| 候选                                     | 是否可用    | 备注                                                                                |
| ---------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `@amap/amap-maps-mcp-server`（高德官方） | ⚠️ 需 key   | 源码硬检查 `AMAP_MAPS_API_KEY`，无 key 直接 `process.exit`，工具无法注册            |
| **`12306-mcp`（社区开源）**              | ✅ 开箱可跑 | stdio 传输 · 无需 key · 直连 12306 公开数据 · 暴露 10 工具（其中治理白名单内 8 个） |

### 三步接入

**1) 安装（不污染 package.json）**

```bash
cd backend
npm install --no-save \
  --registry=https://registry.npmmirror.com \
  --cache /tmp/mgw-npm-cache \
  12306-mcp
```

**2) 在管理后台 · 上游服务 → 新建 stdio 上游**（或用 Admin API 直接 POST）

```json
{
  "name": "rail-12306",
  "displayName": "中国铁路12306",
  "description": "社区开源 MCP Server（12306-mcp），无需 API Key 直连 12306 余票/经停站/车站码等公开数据。",
  "transport": "stdio",
  "command": "node",
  "args": ["./node_modules/12306-mcp/build/index.js"],
  "cwd": "<backend 绝对路径>",
  "env": {},
  "sensitivity": "normal",
  "timeoutMs": 20000,
  "concurrency": 4
}
```

保存后点「探测」，约 1.2s 内可拉到 8 个工具：`get-tickets` / `get-interline-tickets` / `get-train-route-stations` / `get-current-date` / `get-stations-code-in-city` / `get-station-code-of-citys` / `get-station-code-by-names` / `get-station-by-telecode`（前缀 `rail-12306__`）。

**3) 签发一把 admin 角色 Key，走 MCP 通道真实调用**

```bash
# 建立 session
SID=$(curl -i -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer mgw_live_xxx" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' \
  | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')

# 查询 3 天后北京→上海的 G 字头高铁
curl -X POST http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer mgw_live_xxx" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rail-12306__get-tickets","arguments":{"date":"2026-09-15","fromStation":"北京","toStation":"上海","trainFilterFlags":"G","limitedNum":3,"format":"text"}}}'
```

预期响应片段（**真实回传**）：

```
G547 北京南(telecode:VNP) -> 上海虹桥(telecode:AOH) 06:18 -> 12:11 历时：05:53
  · 商务座：无  · 一等座：有票  · 二等座：有票  · 无座：有票
G1   北京南(telecode:VNP) -> 上海虹桥(telecode:AOH) 06:30 -> 11:24 历时：04:54
G3   北京南(telecode:VNP) -> 上海(telecode:SHH)     06:52 -> 11:33 历时：04:41
```

同时在 `审计日志` 页可见 `rail-12306__get-tickets` 的 `tool_call` 记录，`resultOk=1`，参数摘要 PII 已按规则脱敏。

### 一键复现

上述三步已封装为 [`scripts/smoke-domestic.sh`](scripts/smoke-domestic.sh)：17 步骤、12 断言全绿；同时覆盖前端 `Dashboard.vue` 6 张卡 + `Reports.vue` 4 顶卡 5 大表 + `/healthz` 8 字段 + `/metrics` + `/stats/overview` 12 指标 + `/stats/timeseries` 4 种区间的**仪表盘指标全覆盖**断言。适合改核心统计/治理链路后回归。

---

## 十二、进一步阅读

- [`docs/产品方案.md`](docs/产品方案.md) —— 产品经理视角：定位、角色、场景、功能规格、成功指标
- [`docs/技术架构.md`](docs/技术架构.md) —— 架构师视角：分层、数据模型、治理链时序、关键技术权衡
- [`docs/部署运维.md`](docs/部署运维.md) —— 生产部署、Nginx/systemd/Docker、备份恢复、加固清单、故障排查

## License

MIT

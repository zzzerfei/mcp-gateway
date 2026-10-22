# MCP 网关优化方案

> 版本：v0.1 ｜ 状态：方案设计 ｜ 目标：从"单机轻量 MVP"演进为"可生产、可横向扩展"的 MCP 治理网关

## 1. 现状盘点

### 1.1 技术栈

| 层面   | 现状                                                                          |
| ------ | ----------------------------------------------------------------------------- |
| 后端   | NestJS 10 + TypeScript 5.6                                                    |
| 数据库 | TypeORM 0.3 + **better-sqlite3 11**（单文件 SQLite, WAL, `synchronize` 建表） |
| MCP    | @modelcontextprotocol/sdk 1.0（对客户端 Server / 对上游 Client 双角色）       |
| 可观测 | prom-client + node-cron                                                       |
| 部署   | 单进程 / 单实例 / 2C4G                                                        |

### 1.2 单机假设（生产化的主要障碍）

1. **SQLite 单文件**：单进程独占，多实例无法共享。
2. **session 在进程内 Map**：`session.manager.ts`，重启即丢，多实例不共享。
3. **`synchronize` 自动建表**：无迁移脚本，未版本化。
4. **备份用 `db.backup()`**：better-sqlite3 专属 API，换库后失效。

## 2. 优化目标

- **多实例/HA**：支持 ≥2 实例横向扩展，会话与数据共享。
- **数据可迁移**：SQLite → PostgreSQL + migration 版本化。
- **存储解耦**：会话外置，配置环境可切换。
- **生产可观测**：指标、日志、链路完整。

## 3. 优化方案（按依赖顺序）

### 3.1 第一步：存储层抽象（驱动可切换）

现状 `database/**` 大量依赖 SQLite 专属 API（PRAGMA、`db.backup()`）。先做**驱动层抽象**：

```ts
interface DatabaseDriver {
  init(): Promise<void>;
  backup?(): Promise<void>; // sqlite 专属，换库后另处理
  getRepository<T>(entity: EntitySchema<T>): Repository<T>;
}
```

- 通过配置 `DB_DRIVER=sqlite|postgres` 切换。
- 先保留 sqlite 默认，Postgres 作为可选 driver 起步。

**影响点**（需改造）：

- `database/database.module.ts`（数据源工厂）
- `governance/backup.service.ts`（`db.backup()` 依赖）

### 3.2 第二步：SQLite → PostgreSQL + Migration

- 移除 `synchronize: true`，引入 TypeORM Migration (`npm run migration:generate/run`)。
- 实体保持不变（TypeORM 跨库兼容），仅 DSN 与驱动变化。
- 备份方案改为 Postgres 原生命令（`pg_dump`）或 WAL 归档。

**收益**：数据共享、事务可靠、审计大表可查询（现状审计上限 5000 万条需归档）。

### 3.3 第三步：会话外置 Redis

现状 session 存在进程内 Map，多实例必然不一致。

```
session.manager.ts
   Map<string, Session>   →   Redis (SETEX key, ttl, value) + ioredis
```

- GET/SET 改为 Redis 命令，TTL 沿用现有空闲超时（1800s）。
- 多实例通过负载均衡共享同一 Redis，实现"任一台实例都认识同一会话"。

**连带**：危机关闭（熔断/吊销状态）如需多实例即时一致，也应从内存迁到 Redis（或接受最终一致 + 短 TTL）。

### 3.4 第四步：多实例 + 负载均衡（HA 双活）

前置：SQLite→PG、session→Redis 已完成（否则 HA 无从谈起）。

- 部署 ≥2 个网关实例，前置 LB（Nginx/云 LB）分流。
- Node 侧无本地持久状态后可自由扩缩。
- 备份/定时任务（node-cron）需加**分布式锁**（Redis SET NX）防多实例重复执行。

**最终拓扑**：

```
          LB (负载均衡)
         /    \
   实例A       实例B
   \              /
    PostgreSQL  +  Redis  ← 中心化状态
```

## 4. 生产化完整清单

| 项          | 现状                         | 优化后                   |
| ----------- | ---------------------------- | ------------------------ |
| DB          | SQLite 单文件                | PostgreSQL + migration   |
| Session     | 进程内 Map                   | Redis                    |
| 部署        | 单实例                       | 多实例 + LB              |
| 备份        | better-sqlite3 `db.backup()` | pg_dump / WAL 归档       |
| 定时任务    | node-cron 单机               | + Redis 分布式锁         |
| 建表        | `synchronize`                | Migration 版本化         |
| 熔断/吊销态 | 内存                         | Redis 共享（或最终一致） |
| 审计大表    | 5000 万需归档                | 按时间分区 / 归档任务    |

## 5. 优先级与分批

| 批  | 内容                             | 验收                 |
| --- | -------------------------------- | -------------------- |
| P1  | 驱动抽象 + sqlite 仍可用         | 现有 smoke 全绿      |
| P2  | 支持 postgres driver + migration | 一键切 PG 起服务     |
| P3  | session 落 Redis                 | 多实例共享会话       |
| P4  | 多实例 + LB + 分布式锁           | 双实例压测无状态冲突 |

## 6. 不优化项（本期明确不做）

- 不做工具编排、不做 LLM 网关（保持网关治理边界）。
- 不做多租户。
- 不引入消息队列（当期 QPS 未到）。

## 7. 文档对应

- 生产化路径 = PRD 中 P2「多实例」路线图落地。
- 本方案不改工具治理交互（注册/授权/审计 API 不变），仅替换底层存储与部署形态，客户端与上游接入协议兼容。

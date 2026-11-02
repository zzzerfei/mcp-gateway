# Grafana 看板 & Prometheus 采集示例

> P1-G 交付 · 让 `smoke-p1.sh` 里已经跑通的 `/metrics.prom` 端点即插即用地接入可观测体系。
>
> 本目录**不会被打包进应用**，纯粹是给运维/SRE 的模板参考。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `prometheus.yml` | 单个 scrape job 示例，粘到你的 Prometheus 主配置的 `scrape_configs` 下即可 |
| `gateway-overview.json` | 一张 Grafana Dashboard（10+ panel），涵盖 HTTP QPS / 延时 / 错误率 / 上游 tool_call / 熔断时间线 / 事件循环 / 内存 / 运行态 gauge |

## 快速开始（本地跑通）

假设你的开发机已经能通过 `http://127.0.0.1:8080/metrics.prom` 拉到指标（即 `./start.sh` 已启动）。

### 1) 起一套 Prometheus + Grafana（docker-compose 最省事）

```yaml
# docker-compose.observability.yml
version: "3.8"
services:
  prometheus:
    image: prom/prometheus:v2.53.0
    network_mode: host          # macOS 上直连宿主 127.0.0.1:8080
    volumes:
      - ./docs/grafana/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=15d

  grafana:
    image: grafana/grafana:11.1.0
    network_mode: host
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana-data:/var/lib/grafana

volumes:
  grafana-data:
```

```bash
docker compose -f docker-compose.observability.yml up -d
# Prometheus: http://127.0.0.1:9090  → Status / Targets 里应看到 mcp-gateway 为 UP
# Grafana:    http://127.0.0.1:3000  → admin / admin
```

> Linux 上若不用 `network_mode: host`，`static_configs` 里的 `127.0.0.1:8080` 要换成宿主在 docker0 网桥上的地址（通常 `172.17.0.1:8080`）。

### 2) Grafana 导入 Dashboard

1. Grafana 左侧 **Connections → Data sources → Add data source → Prometheus**，URL 填 `http://127.0.0.1:9090`，Save & Test。
2. **Dashboards → New → Import**，把本目录 `gateway-overview.json` 拖进去（或粘贴 JSON）。
3. 顶部 `Prometheus` 下拉选刚才建的数据源，Import。
4. 默认时间窗 3h、刷新 30s。想看**熔断中数据**，另开终端跑 `./scripts/smoke-p1.sh`，几秒内 dashboard "熔断状态时间线" 会出现红色台阶。

### 3) 告警建议（可选）

在 Grafana **Alerting → Contact points** 里把 IM webhook 填进来（与网关 `MGW_IM_WEBHOOK` 同一个），
建 3 条最基础的 rule 就能覆盖 PRD 8.1 里的红线：

| 名称 | 表达式 | 阈值 | for |
| --- | --- | --- | --- |
| HTTP P99 高延时 | `histogram_quantile(0.99, sum by (le) (rate(mgw_http_request_duration_ms_bucket[5m])))` | > 500ms | 3m |
| 5xx 错误率 | `sum(rate(mgw_http_requests_total{status="5xx"}[5m])) / sum(rate(mgw_http_requests_total[5m]))` | > 5% | 2m |
| 熔断中上游 | `count(mgw_upstream_breaker_state == 2)` | > 0 | 1m |

> 事件循环 P99 与备份失败已在网关内部通过 NotifyService 直推 IM（F7 / P1-D），无需在 Grafana 侧重复配置。

## 指标清单（对齐 `metrics.service.ts`）

| 指标 | 类型 | 标签 | 用途 |
| --- | --- | --- | --- |
| `mgw_http_requests_total` | Counter | `method`,`route`,`status` | HTTP QPS / 状态分布 |
| `mgw_http_request_duration_ms_bucket` | Histogram | `method`,`route` | HTTP 延时分位 |
| `mgw_tool_calls_total` | Counter | `upstream`,`status` | MCP tool 调用分布 |
| `mgw_tool_call_duration_ms_bucket` | Histogram | `upstream` | tool 调用延时 |
| `mgw_upstream_breaker_state` | Gauge | `upstream` | 0/1/2 三态 |
| `mgw_registry_tools_total` | Gauge | — | 注册表工具数 |
| `mgw_registry_version` | Gauge | — | 注册表版本（单调递增） |
| `mgw_sessions_active` | Gauge | — | 活跃 MCP 会话数 |
| `mgw_upstreams_connected` | Gauge | — | 已连上游数 |
| `mgw_audit_queue_depth` | Gauge | — | 审计攒批队列深度 |
| `mgw_ratelimit_buckets` | Gauge | — | 令牌桶实例数 |
| `mgw_process_resident_memory_bytes` | Gauge | — | RSS（默认指标） |
| `mgw_nodejs_eventloop_lag_seconds_bucket` | Histogram | — | 事件循环 lag（默认指标） |
| `mgw_nodejs_heap_size_used_bytes` | Gauge | — | V8 堆使用（默认指标） |

其余 `mgw_*` 前缀的默认指标共 30+ 项（CPU/句柄/GC/内存池），无需在面板里逐一列，可通过 `curl /metrics.prom | grep ^mgw_` 全量查看。

## 已知限制

1. **不追踪上游健康探测成功率** —— 目前仅有 `mgw_upstream_breaker_state` 表达结果，不表达"探活请求耗时/成功率"。若需要，等后续 P2 引入 `mgw_healthcheck_*` 指标。
2. **不做 histogram route × status 双维聚合** —— 双维会让标签数从 ~50 涨到 ~500，scrape 侧成本较高；错误率统一走 Counter 的 status 分类维度。
3. **`mgw_upstream_breaker_state` 由 refreshRuntime 拉取前刷新** —— scrape 间隔短于 15s 时不会看到"两次 scrape 之间的中间态"，只反映上一次拉取时的快照。这符合 Prometheus 官方"event-driven → gauge 转换"的建议。

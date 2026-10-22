import { Controller, Get, Query, Sse, UseGuards } from "@nestjs/common";
import { Observable, interval, map, merge } from "rxjs";
import { LogtoGuard } from "./guards/logto.guard";
import { BreakerService } from "../governance/breaker.service";
import { BreakerEventsService } from "../governance/breaker-events.service";
import { CircuitBreakerEvent } from "../database/entities/breaker-event.entity";

/**
 * P1-C・熔断事件面板 API。
 * 与 stats/overview（面向调用量）分离：本 controller 只回答"上游健康度趋势"。
 */
@Controller("admin/api/breaker")
@UseGuards(LogtoGuard)
export class BreakerAdminController {
  constructor(
    private readonly breaker: BreakerService,
    private readonly events: BreakerEventsService,
  ) {}

  /** 当前内存快照 + 配置。用于面板顶部"实时"卡。 */
  @Get("status")
  async status(): Promise<{
    config: { failThreshold: number; openMs: number; windowMs: number };
    upstreams: Array<{
      upstream: string;
      state: "closed" | "open" | "half-open";
      fails: number;
      openedAt: number;
    }>;
  }> {
    return {
      config: this.breaker.getConfig(),
      upstreams: this.breaker
        .snapshotAll()
        .sort((a, b) => b.openedAt - a.openedAt),
    };
  }

  /** 事件分页查询。 */
  @Get("events")
  async list(
    @Query("upstream") upstream?: string,
    @Query("event") event?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page?: string,
    @Query("size") size?: string,
  ): Promise<{
    total: number;
    page: number;
    size: number;
    rows: CircuitBreakerEvent[];
  }> {
    const ev = event === "opened" || event === "recovered" ? event : undefined;
    return this.events.query({
      upstream,
      event: ev,
      from: from ? Number(from) : undefined,
      to: to ? Number(to) : undefined,
      page: page ? Number(page) : 1,
      size: size ? Number(size) : 20,
    });
  }

  /** 概览：近 N 天每个上游的开合次数。用于面板"高频熔断"卡。 */
  @Get("summary")
  async summary(@Query("days") days?: string): Promise<
    Array<{
      upstream: string;
      opened: number;
      recovered: number;
      lastEventTs: number;
    }>
  > {
    const d = Math.max(1, Math.min(90, Number(days) || 7));
    return this.events.summary(d);
  }

  /**
   * P1-F・SSE 实时推流：上游熔断状态发生迁移时即时向已连接的面板广播。
   * 心跳 25s（防 Nginx 默认 60s idle 切断）；前端需 `new EventSource('/admin/api/breaker/events/stream?token=xxx')`。
   * 安全：LogtoGuard 已对 `/stream` 路径开放 `?token=` query，与 header 同位阶。
   */
  @Sse("events/stream")
  stream(): Observable<unknown> {
    const breaker$ = this.events.subscribe();
    const ping$ = interval(25_000).pipe(
      map(() => ({ type: "ping", data: { ts: Date.now() } })),
    );
    return merge(breaker$, ping$);
  }
}

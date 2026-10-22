import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { LogtoGuard } from "./guards/logto.guard";
import { AuditLog } from "../database/entities/audit.entity";
import { RbacService } from "../auth/rbac.service";

/**
 * 报表聚合 SQL：参数化 + 白名单，SQL 注入防线不松。
 * 聚合查询失败必须显式上抛，不静默 catch 返回空数组（否则报表看起来「今天没数据」）。
 */
@Controller("admin/api/stats")
@UseGuards(LogtoGuard)
export class StatsAdminController {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    private readonly rbac: RbacService,
  ) {}

  private clampDays(days?: string): number {
    return Math.min(Math.max(Number(days) || 7, 1), 90);
  }

  @Get("overview")
  async overview(@Query("days") days?: string): Promise<any> {
    const d = this.clampDays(days);
    const since = Date.now() - d * 86_400_000;
    const db = this.auditRepo.manager;

    const topTools = await db.query(
      `SELECT tool, COUNT(*) AS n, ROUND(AVG(duration_ms)) AS avg_ms,
              ROUND(100.0 * SUM(CASE WHEN result_ok = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS fail_pct
         FROM audit_logs WHERE ts > ? AND event = 'tool_call'
        GROUP BY tool ORDER BY n DESC LIMIT 10`,
      [since],
    );

    const byUpstream = await db.query(
      `SELECT upstream, COUNT(*) AS n,
              ROUND(100.0 * SUM(CASE WHEN result_ok = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS fail_pct
         FROM audit_logs WHERE ts > ? AND event = 'tool_call'
        GROUP BY upstream`,
      [since],
    );

    const sensitiveCount = await db.query(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE sensitive = 1 AND ts > ?`,
      [since],
    );

    const totalCalls = await db.query(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN result_ok = 0 THEN 1 ELSE 0 END) AS fails
         FROM audit_logs WHERE ts > ? AND event = 'tool_call'`,
      [since],
    );

    const topUsers = await db.query(
      `SELECT user_name, COUNT(*) AS n FROM audit_logs
        WHERE ts > ? AND event = 'tool_call' AND user_name IS NOT NULL
        GROUP BY user_name ORDER BY n DESC LIMIT 10`,
      [since],
    );

    // 失败率 Top5 工具（样本量 > 20 才有统计意义）
    const failTop = await db.query(
      `SELECT tool, COUNT(*) AS n,
              ROUND(100.0 * SUM(CASE WHEN result_ok = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS fail_pct
         FROM audit_logs WHERE ts > ? AND event = 'tool_call'
        GROUP BY tool HAVING COUNT(*) > 20 ORDER BY fail_pct DESC LIMIT 5`,
      [since],
    );

    // F1 影子模式统计：当前模式 + 窗口内 would-forbid 命中数（供前端报表卡“若切 enforce 会拦下 N 次”）
    const wouldForbid: any[] = await db.query(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE ts > ? AND event = 'rbac_would_forbid'`,
      [since],
    );
    const wouldForbidTop: any[] = await db.query(
      `SELECT tool, role, COUNT(*) AS n FROM audit_logs
        WHERE ts > ? AND event = 'rbac_would_forbid'
        GROUP BY tool, role ORDER BY n DESC LIMIT 10`,
      [since],
    );

    return {
      days: d,
      topTools,
      byUpstream,
      failTop,
      topUsers,
      sensitiveCount: sensitiveCount[0]?.n ?? 0,
      totalCalls: totalCalls[0]?.n ?? 0,
      totalFails: totalCalls[0]?.fails ?? 0,
      // P95 各上游耗时（正确算法：排序 + OFFSET，不用 AVG 冒充）
      p95ByUpstream: await this.p95ByUpstream(since),
      // F1 影子模式（前端报表卡数据源）
      rbacMode: this.rbac.getMode(),
      wouldForbidCount: wouldForbid[0]?.n ?? 0,
      wouldForbidTop,
    };
  }

  /**
   * SQLite 无原生百分位。用 ORDER BY + LIMIT 1 OFFSET (n*0.95) 近似。
   * 不要用 AVG 冒充 P95——长尾会被平均值完全抹平。
   */
  private async p95ByUpstream(since: number): Promise<any[]> {
    const db = this.auditRepo.manager;
    const upstreams: any[] = await db.query(
      `SELECT DISTINCT upstream FROM audit_logs WHERE ts > ? AND event = 'tool_call' AND upstream IS NOT NULL`,
      [since],
    );
    const out: any[] = [];
    for (const { upstream } of upstreams) {
      const cnt: any[] = await db.query(
        `SELECT COUNT(*) AS n FROM audit_logs WHERE ts > ? AND upstream = ? AND event = 'tool_call'`,
        [since, upstream],
      );
      const n = cnt[0]?.n ?? 0;
      if (n === 0) continue;
      const offset = Math.floor(n * 0.95);
      const row: any[] = await db.query(
        `SELECT duration_ms FROM audit_logs WHERE ts > ? AND upstream = ? AND event = 'tool_call'
          ORDER BY duration_ms LIMIT 1 OFFSET ?`,
        [since, upstream, offset],
      );
      out.push({ upstream, count: n, p95_ms: row[0]?.duration_ms ?? 0 });
    }
    return out;
  }

  /**
   * 趋势折线：调用量与失败率，按 hour/day 分桶。
   * 无数据的桶也补齐（写 0），否则新部署时曲线会“因为只一个数据点而看不到”。
   * 前端依赖固定桶数做 x 轴刻度与填充，后端必须给完区间。
   */
  @Get("timeseries")
  async timeseries(
    @Query("days") days?: string,
    @Query("bucket") bucket?: string,
  ): Promise<any> {
    const d = this.clampDays(days);
    const bucketMs = bucket === "day" ? 86_400_000 : 3_600_000;
    const now = Date.now();
    const sinceRaw = now - d * 86_400_000;
    const startBucket = Math.floor(sinceRaw / bucketMs) * bucketMs;
    const endBucket = Math.floor(now / bucketMs) * bucketMs;
    const db = this.auditRepo.manager;
    const rows: any[] = await db.query(
      `SELECT ts, result_ok FROM audit_logs WHERE ts >= ? AND event = 'tool_call'`,
      [startBucket],
    );
    const hits = new Map<number, { total: number; fails: number }>();
    for (const r of rows) {
      const key = Math.floor(r.ts / bucketMs) * bucketMs;
      if (key < startBucket || key > endBucket) continue;
      const b = hits.get(key) ?? { total: 0, fails: 0 };
      b.total++;
      if (r.result_ok === 0) b.fails++;
      hits.set(key, b);
    }
    // 按完整区间补齐：包含零值桶，保证前端 x 轴可分格
    const out: Array<{
      ts: number;
      total: number;
      fails: number;
      fail_pct: number;
    }> = [];
    for (let t = startBucket; t <= endBucket; t += bucketMs) {
      const v = hits.get(t) ?? { total: 0, fails: 0 };
      out.push({
        ts: t,
        total: v.total,
        fails: v.fails,
        fail_pct: v.total ? +((100 * v.fails) / v.total).toFixed(1) : 0,
      });
    }
    return out;
  }
}

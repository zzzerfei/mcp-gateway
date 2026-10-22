import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { LogtoGuard, RequireScopes } from "./guards/logto.guard";
import { AuditLog, ChangeLog } from "../database/entities/audit.entity";
import { ChangeLogService } from "./change-log.service";

@Controller("admin/api")
@UseGuards(LogtoGuard)
export class AuditAdminController {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    private readonly changes: ChangeLogService,
  ) {}

  @Get("audit")
  @RequireScopes("gateway:sensitive")
  async query(
    @Query("user") user?: string,
    @Query("tool") tool?: string,
    @Query("upstream") upstream?: string,
    @Query("role") role?: string,
    @Query("sensitive") sensitive?: string,
    @Query("ok") ok?: string,
    @Query("keyword") keyword?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("event") event?: string,
    @Query("errorCode") errorCode?: string,
    @Query("page") page?: string,
    @Query("size") size?: string,
  ): Promise<any> {
    const qb = this.auditRepo.createQueryBuilder("a");
    if (user) qb.andWhere("a.user_name = :user", { user });
    if (tool) qb.andWhere("a.tool LIKE :tool", { tool: `%${tool}%` });
    if (upstream) qb.andWhere("a.upstream = :upstream", { upstream });
    // F1·影子模式审计查询入口：按角色过滤（与前端“越权历史”入口对齐）
    if (role) qb.andWhere("a.role = :role", { role });
    if (sensitive === "1") qb.andWhere("a.sensitive = 1");
    if (ok === "0") qb.andWhere("a.result_ok = 0");
    if (ok === "1") qb.andWhere("a.result_ok = 1");
    if (keyword)
      qb.andWhere(
        "(a.tool LIKE :kw OR a.user_name LIKE :kw OR a.args_digest LIKE :kw)",
        { kw: `%${keyword}%` },
      );
    if (from) qb.andWhere("a.ts >= :from", { from: Number(from) });
    if (to) qb.andWhere("a.ts <= :to", { to: Number(to) });
    // F1 影子模式：前端筛选“越权历史”入口（event='rbac_would_forbid'）
    if (event) qb.andWhere("a.event = :event", { event });
    if (errorCode) qb.andWhere("a.error_code = :ec", { ec: errorCode });
    const total = await qb.getCount();
    const p = Math.max(1, Number(page) || 1);
    const s = Math.min(200, Math.max(1, Number(size) || 20));
    qb.orderBy("a.ts", "DESC")
      .skip((p - 1) * s)
      .take(s);
    const rows = await qb.getMany();
    return {
      total,
      page: p,
      size: s,
      rows: rows.map((r) => this.serialize(r)),
    };
  }

  private serialize(a: AuditLog) {
    return {
      id: a.id,
      ts: a.ts,
      requestId: a.requestId,
      event: a.event,
      userName: a.userName,
      team: a.team,
      role: a.role,
      tool: a.tool,
      upstream: a.upstream,
      argsDigest: a.argsDigest,
      resultBytes: a.resultBytes,
      resultOk: a.resultOk,
      errorCode: a.errorCode,
      durationMs: a.durationMs,
      queueMs: a.queueMs,
      sensitive: a.sensitive,
      redacted: a.redacted,
      callerIp: a.callerIp,
    };
  }

  /** CSV 流式导出（上限 10 万行）。必须声明在 :id 之前，否则 /audit/export 会被 :id='export' 拦截 */
  @Get("audit/export")
  @RequireScopes("gateway:sensitive")
  async export(
    @Res() res: Response,
    @Query("user") user?: string,
    @Query("tool") tool?: string,
    @Query("sensitive") sensitive?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<void> {
    const qb = this.auditRepo.createQueryBuilder("a");
    if (user) qb.andWhere("a.user_name = :user", { user });
    if (tool) qb.andWhere("a.tool LIKE :tool", { tool: `%${tool}%` });
    if (sensitive === "1") qb.andWhere("a.sensitive = 1");
    if (from) qb.andWhere("a.ts >= :from", { from: Number(from) });
    if (to) qb.andWhere("a.ts <= :to", { to: Number(to) });
    qb.orderBy("a.ts", "DESC").take(100_001);
    const rows = await qb.getMany();
    if (rows.length > 100_000) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .send("导出超过 10 万行，请缩小时间范围");
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-${Date.now()}.csv"`,
    );
    const header =
      "id,ts,event,user,team,role,tool,upstream,result_ok,error_code,duration_ms,sensitive\n";
    res.write("\uFEFF" + header);
    for (const r of rows) {
      res.write(
        [
          r.id,
          r.ts,
          r.event,
          r.userName ?? "",
          r.team ?? "",
          r.role ?? "",
          r.tool ?? "",
          r.upstream ?? "",
          r.resultOk,
          r.errorCode ?? "",
          r.durationMs ?? "",
          r.sensitive,
        ].join(",") + "\n",
      );
    }
    res.end();
  }

  /** 单条详情（含 args_full 与原始 error_msg） */
  @Get("audit/:id")
  @RequireScopes("gateway:sensitive")
  async detail(@Param("id") id: string): Promise<any> {
    const a = await this.auditRepo.findOne({ where: { id: Number(id) } });
    if (!a) throw new HttpException("审计记录不存在", HttpStatus.NOT_FOUND);
    return a;
  }

  @Get("changes")
  @RequireScopes("gateway:sensitive")
  async queryChanges(
    @Query("target_type") targetType?: string,
    @Query("actor") actor?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page?: string,
    @Query("size") size?: string,
  ): Promise<any> {
    return this.changes.query({
      targetType,
      actor,
      from: from ? Number(from) : undefined,
      to: to ? Number(to) : undefined,
      page: page ? Number(page) : 1,
      size: size ? Number(size) : 20,
    });
  }
}

import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Request, Response } from "express";
import { LogtoGuard, RequireScopes } from "./guards/logto.guard";
import { actorOf } from "./actor";
import { BackupService } from "../governance/backup.service";
import { ChangeLogService } from "./change-log.service";
import { Backup } from "../database/entities/backup.entity";
import { logger } from "../common/logger";

/**
 * P1-A・数据库备份管理 API。
 *
 * 端点：
 * - GET  /admin/api/backups?status=&page=&size=  列表
 * - GET  /admin/api/backups/summary              概览（Dashboard 卡）
 * - POST /admin/api/backups/run                  立即备份（同步 · 返回该行）
 * - GET  /admin/api/backups/:id/download         下载备份文件
 *
 * 手动触发写 change_logs(targetType='backup', action='create')，
 * cron 自动触发仅落 backups 表，避免污染人工变更列表。
 */
@Controller("admin/api/backups")
@UseGuards(LogtoGuard)
export class BackupAdminController {
  constructor(
    private readonly backup: BackupService,
    private readonly changes: ChangeLogService,
  ) {}

  @Get()
  @RequireScopes("gateway:sensitive")
  async list(
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("size") size?: string,
  ): Promise<{ total: number; page: number; size: number; rows: Backup[] }> {
    const st = status === "ok" || status === "failed" ? status : undefined;
    return this.backup.query({
      status: st,
      page: page ? Number(page) : 1,
      size: size ? Number(size) : 20,
    });
  }

  @Get("summary")
  @RequireScopes("gateway:sensitive")
  async summary() {
    return this.backup.summary();
  }

  @Post("run")
  async run(@Req() req: Request): Promise<Backup> {
    const actor = actorOf(req);
    const row = await this.backup.run("manual", actor);
    await this.changes.record({
      actor,
      actorIp: req.ip,
      targetType: "backup",
      targetId: row.filename,
      action: "create",
      after: {
        bytes: row.bytes,
        durationMs: row.durationMs,
        status: row.status,
      },
      diffSummary: `手动备份：${row.filename}（${row.bytes} bytes · ${row.durationMs}ms）`,
    });
    return row;
  }

  @Get(":id/download")
  @RequireScopes("gateway:sensitive")
  async download(@Req() req: Request, @Res() res: Response): Promise<void> {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ message: "id 非法" });
      return;
    }
    const target = await this.backup.resolvePath(id);
    if (!target) {
      res.status(404).json({ message: "备份文件不存在或已被清理" });
      return;
    }
    // 记录一次下载审计（不阻断响应）
    const actor = actorOf(req);
    this.changes
      .record({
        actor,
        actorIp: req.ip,
        targetType: "backup",
        targetId: target.filename,
        action: "create",
        diffSummary: `下载备份：${target.filename}`,
      })
      .catch((e) =>
        logger.warn("备份下载留痕失败", { err: (e as Error).message }),
      );
    res.download(target.absPath, target.filename);
  }
}

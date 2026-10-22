import { Module } from "@nestjs/common";
import { LogtoGuard } from "./guards/logto.guard";
import { ChangeLogService } from "./change-log.service";
import { UpstreamAdminController } from "./upstream.controller";
import { ToolAdminController } from "./tool.controller";
import { KeyAdminController } from "./key.controller";
import { PermissionAdminController } from "./permission.controller";
import { AuditAdminController } from "./audit.controller";
import { StatsAdminController } from "./stats.controller";
import { BreakerAdminController } from "./breaker.controller";
import { BackupAdminController } from "./backup.controller";
import { SystemController } from "./system.controller";
import { SmokeCaseController } from "./smoke-case.controller";

/**
 * 管理后台模块（对管理员通道）。所有 /admin/api/* 端点经 LogtoGuard 鉴权，
 * 与 MCP 通道（Bearer Key）完全隔离——两套凭据、两条代码路径。
 *
 * 控制器按业务域划分：上游 / 工具 / Key / 权限 / 审计 / 报表 / 系统。
 * ChangeLogService 承载全部写操作留痕（含 before/after，支持回溯）。
 * 依赖的 Repository 与各治理 Service 均由 @Global 模块提供，此处无需重复 imports。
 */
@Module({
  controllers: [
    UpstreamAdminController,
    ToolAdminController,
    KeyAdminController,
    PermissionAdminController,
    AuditAdminController,
    StatsAdminController,
    BreakerAdminController,
    BackupAdminController,
    SystemController,
    SmokeCaseController,
  ],
  providers: [LogtoGuard, ChangeLogService],
  exports: [ChangeLogService],
})
export class AdminModule {}

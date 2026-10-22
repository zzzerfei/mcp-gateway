import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { z } from "zod";
import { LogtoGuard } from "./guards/logto.guard";
import { actorOf } from "./actor";
import { ToolOverride } from "../database/entities/tool.entity";
import { Role } from "../database/entities/identity.entity";
import { ToolRegistryService } from "../gateway/registry.service";
import { GatewayRouterService } from "../gateway/router.service";
import { ChangeLogService } from "./change-log.service";
import { stageOf, stagesOf } from "./chain-stage";
import { SessionManager } from "../transport/session.manager";

/** Prompt 注入告警：描述覆写含可疑模式时提示（不阻断，但要让人确认） */
const SUSPICIOUS_DESC =
  /(忽略之前|ignore previous|system:|你现在是|disregard)/i;

@Controller("admin/api/tools")
@UseGuards(LogtoGuard)
export class ToolAdminController {
  constructor(
    @InjectRepository(ToolOverride)
    private readonly overrideRepo: Repository<ToolOverride>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly registry: ToolRegistryService,
    private readonly router: GatewayRouterService,
    private readonly changes: ChangeLogService,
    private readonly sessions: SessionManager,
  ) {}

  private actor(req: Request): string {
    return actorOf(req);
  }

  @Get()
  async list(
    @Query("upstream") upstream?: string,
    @Query("q") q?: string,
    @Query("overridden") overridden?: string,
  ): Promise<any[]> {
    let names = this.registry.allToolNames(true);
    if (upstream) names = names.filter((n) => n.startsWith(`${upstream}__`));
    if (q)
      names = names.filter((n) => n.toLowerCase().includes(q.toLowerCase()));
    const out: any[] = [];
    for (const fn of names) {
      const e = this.registry.get(fn);
      if (!e) continue;
      const ov = await this.overrideRepo.findOne({ where: { fullName: fn } });
      if (overridden === "1" && !ov) continue;
      out.push({
        fullName: fn,
        upstream: e.upstream,
        originalName: e.originalName,
        title: e.def.title,
        description: e.def.description,
        rawDescription: e.rawDescription,
        enabled: e.enabled,
        sensitivity: e.sensitivity,
        overridden: !!ov,
        rateQpm: ov?.rateQpm ?? null,
        note: ov?.note ?? "",
      });
    }
    return out;
  }

  @Get(":fullName")
  async detail(@Param("fullName") fullName: string): Promise<any> {
    const e = this.registry.get(fullName);
    if (!e) throw new HttpException("工具不存在", HttpStatus.NOT_FOUND);
    const ov = await this.overrideRepo.findOne({ where: { fullName } });
    return {
      fullName,
      upstream: e.upstream,
      originalName: e.originalName,
      title: e.def.title,
      description: e.def.description,
      rawDescription: e.rawDescription,
      inputSchema: e.def.inputSchema,
      enabled: e.enabled,
      sensitivity: e.sensitivity,
      override: ov ?? null,
    };
  }

  /**
   * 试调用：复用 GatewayRouter 的完整治理链（RBAC→限流→熔断→并发→转发→审计），
   * 因此测到的行为与真实客户端一致，不存在"绕过治理的假测试"。
   * role 可指定，用于在发 Key 之前预演某角色的权限结果。
   */
  @Post(":fullName/invoke")
  async invoke(
    @Param("fullName") fullName: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const { args, role: roleInput } = z
      .object({
        args: z.record(z.unknown()).default({}),
        role: z.string().max(64).optional(),
      })
      .parse(body ?? {});

    if (!this.registry.get(fullName))
      throw new HttpException("工具不存在", HttpStatus.NOT_FOUND);

    const role = roleInput || "admin";
    const roleRow = await this.roleRepo.findOne({ where: { name: role } });
    if (!roleRow)
      throw new HttpException(`角色不存在：${role}`, HttpStatus.BAD_REQUEST);

    const t0 = Date.now();
    const result = await this.router.routeCall(
      fullName,
      args,
      {
        keyId: -1, // 负数：标识非真实 Key 调用，与生产流量区分
        keyPrefix: "test",
        userName: `admin:${this.actor(req)}`,
        team: "admin",
        role,
        profile: "admin_test",
      },
      {
        callerIp: req.ip,
        clientInfo: '{"name":"admin-tester"}',
        channel: "admin",
      },
    );

    return {
      ok: !result.isError,
      requestId: result.requestId ?? null,
      durationMs: Date.now() - t0,
      errorCode: result.errorCode ?? null,
      stage: stageOf(result.errorCode),
      stages: stagesOf(result.errorCode),
      result: result.content ?? null,
    };
  }

  private async ensureOverride(
    fullName: string,
    actor: string,
  ): Promise<ToolOverride> {
    let ov = await this.overrideRepo.findOne({ where: { fullName } });
    if (!ov) {
      ov = this.overrideRepo.create({
        fullName,
        description: null,
        enabled: 1,
        rateQpm: null,
        cacheTtlS: 0,
        note: "",
        updatedBy: actor,
        updatedAt: Date.now(),
      } as Partial<ToolOverride>);
    }
    return ov;
  }

  @Put(":fullName/description")
  async overrideDescription(
    @Param("fullName") fullName: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const schema = z.object({ description: z.string().max(4000) });
    const { description } = schema.parse(body);
    const e = this.registry.get(fullName);
    if (!e) throw new HttpException("工具不存在", HttpStatus.NOT_FOUND);
    const warning = SUSPICIOUS_DESC.test(description)
      ? "描述含可疑指令模式，请确认是否为 Prompt 注入"
      : undefined;
    const ov = await this.ensureOverride(fullName, this.actor(req));
    const before = ov.description;
    ov.description = description;
    ov.updatedBy = this.actor(req);
    ov.updatedAt = Date.now();
    await this.overrideRepo.save(ov);
    await this.registry.applyOverride(fullName, { description });
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "tool_override",
      targetId: fullName,
      action: "update",
      before: { description: before },
      after: { description },
      diffSummary: `覆写工具 ${fullName} 描述`,
    });
    this.sessions.broadcastListChanged();
    return { ok: true, warning };
  }

  @Put(":fullName/enabled")
  async toggleEnabled(
    @Param("fullName") fullName: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(body);
    const e = this.registry.get(fullName);
    if (!e) throw new HttpException("工具不存在", HttpStatus.NOT_FOUND);
    const ov = await this.ensureOverride(fullName, this.actor(req));
    ov.enabled = enabled ? 1 : 0;
    ov.updatedBy = this.actor(req);
    ov.updatedAt = Date.now();
    await this.overrideRepo.save(ov);
    await this.registry.applyOverride(fullName, { enabled: ov.enabled });
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "tool_override",
      targetId: fullName,
      action: enabled ? "enable" : "disable",
      diffSummary: `${enabled ? "上线" : "下线"}工具 ${fullName}`,
    });
    this.sessions.broadcastListChanged();
    return { ok: true };
  }

  @Put(":fullName/ratelimit")
  async setRateLimit(
    @Param("fullName") fullName: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const { rateQpm } = z
      .object({ rateQpm: z.number().int().positive().nullable() })
      .parse(body);
    const ov = await this.ensureOverride(fullName, this.actor(req));
    ov.rateQpm = rateQpm;
    ov.updatedBy = this.actor(req);
    ov.updatedAt = Date.now();
    await this.overrideRepo.save(ov);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "tool_override",
      targetId: fullName,
      action: "update",
      after: { rateQpm },
      diffSummary: `设置工具 ${fullName} 限流 QPM=${rateQpm ?? "默认"}`,
    });
    return { ok: true };
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Request } from "express";
import { z } from "zod";
import { LogtoGuard } from "./guards/logto.guard";
import { actorOf } from "./actor";
import { ChangeLogService } from "./change-log.service";
import { stageOf, stagesOf } from "./chain-stage";
import { SmokeCase } from "../database/entities/smoke-case.entity";
import { Role } from "../database/entities/identity.entity";
import { ToolRegistryService } from "../gateway/registry.service";
import { GatewayRouterService, RouteResult } from "../gateway/router.service";

/** 单条用例的执行结果（前端直接渲染，字段与试调用保持一致） */
interface CaseRunItem {
  id: number;
  name: string;
  toolFullName: string;
  role: string;
  ok: boolean;
  requestId: string | null;
  durationMs: number;
  errorCode: string | null;
  stage: string;
  stages: {
    no: number;
    name: string;
    status: "passed" | "failed" | "skipped";
  }[];
  result: unknown;
}

@Controller("admin/api/cases")
@UseGuards(LogtoGuard)
export class SmokeCaseController {
  constructor(
    @InjectRepository(SmokeCase)
    private readonly caseRepo: Repository<SmokeCase>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly registry: ToolRegistryService,
    private readonly router: GatewayRouterService,
    private readonly changes: ChangeLogService,
  ) {}

  private actor(req: Request): string {
    return actorOf(req);
  }

  @Get()
  async list(): Promise<any[]> {
    const rows = await this.caseRepo.find({ order: { id: "ASC" } });
    return rows.map((c) => ({
      ...c,
      enabled: !!c.enabled,
      toolExists: !!this.registry.get(c.toolFullName),
    }));
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: Request): Promise<any> {
    const input = z
      .object({
        name: z.string().min(1).max(128),
        toolFullName: z.string().min(1).max(256),
        args: z.record(z.unknown()).default({}),
        role: z.string().max(64).default("admin"),
      })
      .parse(body ?? {});

    if (!this.registry.get(input.toolFullName))
      throw new HttpException("工具不存在", HttpStatus.NOT_FOUND);

    const now = Date.now();
    const row = this.caseRepo.create({
      name: input.name,
      toolFullName: input.toolFullName,
      argsJson: JSON.stringify(input.args),
      role: input.role,
      enabled: 1,
      createdBy: this.actor(req),
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      lastOk: null,
      lastDurationMs: null,
      lastError: null,
    } as Partial<SmokeCase>);
    await this.caseRepo.save(row);

    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "smoke_case",
      targetId: String(row.id),
      action: "create",
      after: { name: row.name, toolFullName: row.toolFullName, role: row.role },
      diffSummary: `新建冒烟用例「${row.name}」→ ${row.toolFullName}`,
    });
    return { ok: true, id: row.id };
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const input = z
      .object({
        name: z.string().min(1).max(128).optional(),
        args: z.record(z.unknown()).optional(),
        role: z.string().max(64).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(body ?? {});

    const row = await this.findOrThrow(Number(id));
    const before = {
      name: row.name,
      argsJson: row.argsJson,
      role: row.role,
      enabled: row.enabled,
    };

    if (input.name !== undefined) row.name = input.name;
    if (input.args !== undefined) row.argsJson = JSON.stringify(input.args);
    if (input.role !== undefined) row.role = input.role;
    if (input.enabled !== undefined) row.enabled = input.enabled ? 1 : 0;
    row.updatedAt = Date.now();
    await this.caseRepo.save(row);

    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "smoke_case",
      targetId: String(row.id),
      action: "update",
      before,
      after: {
        name: row.name,
        argsJson: row.argsJson,
        role: row.role,
        enabled: row.enabled,
      },
      diffSummary: `更新冒烟用例「${row.name}」`,
    });
    return { ok: true };
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Req() req: Request): Promise<any> {
    const row = await this.findOrThrow(Number(id));
    await this.caseRepo.remove(row);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "smoke_case",
      targetId: String(row.id),
      action: "delete",
      before: { name: row.name, toolFullName: row.toolFullName },
      diffSummary: `删除冒烟用例「${row.name}」`,
    });
    return { ok: true };
  }

  @Post(":id/run")
  async run(@Param("id") id: string, @Req() req: Request): Promise<any> {
    const row = await this.findOrThrow(Number(id));
    return this.execute(row, req);
  }

  /** 一键回归：串行执行全部启用用例，避免同时打满上游 */
  @Post("run-all")
  async runAll(@Req() req: Request): Promise<any> {
    const rows = await this.caseRepo.find({
      where: { enabled: 1 },
      order: { id: "ASC" },
    });
    const t0 = Date.now();
    const items: CaseRunItem[] = [];
    for (const row of rows) items.push(await this.execute(row, req));
    return {
      total: items.length,
      passed: items.filter((i) => i.ok).length,
      failed: items.filter((i) => !i.ok).length,
      durationMs: Date.now() - t0,
      items,
    };
  }

  /**
   * 执行单条用例。keyId 取 -(1000+id)：每个用例独立限流桶，
   * 回归时不会互相挤占，也不会污染真实 Key 的额度。
   */
  private async execute(row: SmokeCase, req: Request): Promise<CaseRunItem> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(row.argsJson || "{}");
    } catch {
      args = {};
    }

    const roleRow = await this.roleRepo.findOne({ where: { name: row.role } });
    const t0 = Date.now();
    let result: RouteResult;

    if (!roleRow) {
      result = {
        isError: true,
        errorCode: "FORBIDDEN" as RouteResult["errorCode"],
      };
    } else {
      result = await this.router.routeCall(
        row.toolFullName,
        args,
        {
          keyId: -(1000 + row.id),
          keyPrefix: "smoke",
          userName: `smoke:${this.actor(req)}`,
          team: "admin",
          role: row.role,
          profile: "smoke_test",
        },
        {
          callerIp: req.ip,
          clientInfo: '{"name":"smoke-runner"}',
          channel: "admin",
        },
      );
    }

    const durationMs = Date.now() - t0;
    const ok = !result.isError;
    const errorCode = result.errorCode ?? null;
    const stage = roleRow
      ? stageOf(errorCode ?? undefined)
      : `② RBAC：角色不存在（${row.role}）`;

    row.lastRunAt = Date.now();
    row.lastOk = ok ? 1 : 0;
    row.lastDurationMs = durationMs;
    row.lastError = ok ? null : stage;
    await this.caseRepo.save(row);

    return {
      id: row.id,
      name: row.name,
      toolFullName: row.toolFullName,
      role: row.role,
      ok,
      requestId: result.requestId ?? null,
      durationMs,
      errorCode,
      stage,
      stages: roleRow
        ? stagesOf(errorCode ?? undefined)
        : stagesOf("FORBIDDEN"),
      result: result.content ?? null,
    };
  }

  private async findOrThrow(id: number): Promise<SmokeCase> {
    const row = await this.caseRepo.findOne({ where: { id } });
    if (!row) throw new HttpException("用例不存在", HttpStatus.NOT_FOUND);
    return row;
  }
}

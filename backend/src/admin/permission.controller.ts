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
import { Role, RoleRule, ApiKey } from "../database/entities/identity.entity";
import { AuditLog } from "../database/entities/audit.entity";
import { RbacService, MatchableRule } from "../auth/rbac.service";
import { ToolRegistryService } from "../gateway/registry.service";
import { ChangeLogService } from "./change-log.service";
import { SessionManager } from "../transport/session.manager";

/** 规则输入（sort 由后端按语义重排，不接受前端指定） */
const ruleInput = z.object({
  effect: z.enum(["allow", "deny"]),
  pattern: z.string().min(1).max(200),
  memo: z.string().max(500).optional().default(""),
});

/**
 * 权限治理页 API：角色、规则、权限矩阵、变更预览。
 * 核心契约「可见即可调」：矩阵与 tools/list 共用 RBAC.buildAllowedSet 同一份结果。
 */
@Controller("admin/api")
@UseGuards(LogtoGuard)
export class PermissionAdminController {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(RoleRule)
    private readonly ruleRepo: Repository<RoleRule>,
    @InjectRepository(ApiKey)
    private readonly keyRepo: Repository<ApiKey>,
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
    private readonly rbac: RbacService,
    private readonly registry: ToolRegistryService,
    private readonly changes: ChangeLogService,
    private readonly sessions: SessionManager,
  ) {}

  private actor(req: Request): string {
    return actorOf(req);
  }

  // ── 角色 ──────────────────────────────────────────────

  @Get("roles")
  async listRoles(): Promise<any[]> {
    const roles = await this.roleRepo.find({ order: { createdAt: "ASC" } });
    const counts = await this.ruleRepo
      .createQueryBuilder("r")
      .select("r.role", "role")
      .addSelect("COUNT(*)", "cnt")
      .groupBy("r.role")
      .getRawMany<{ role: string; cnt: string }>();
    const cntMap = new Map(counts.map((c) => [c.role, Number(c.cnt)]));
    const keyCounts = await this.keyRepo
      .createQueryBuilder("k")
      .select("k.role", "role")
      .addSelect("COUNT(*)", "cnt")
      .where("k.revoked = 0")
      .groupBy("k.role")
      .getRawMany<{ role: string; cnt: string }>();
    const keyMap = new Map(keyCounts.map((c) => [c.role, Number(c.cnt)]));
    return roles.map((r) => ({
      name: r.name,
      description: r.description,
      isBuiltin: r.isBuiltin === 1,
      ruleCount: cntMap.get(r.name) ?? 0,
      activeKeyCount: keyMap.get(r.name) ?? 0,
      createdAt: r.createdAt,
    }));
  }

  @Post("roles")
  async createRole(@Body() body: unknown, @Req() req: Request): Promise<any> {
    const { name, description } = z
      .object({
        name: z
          .string()
          .regex(
            /^[a-z][a-z0-9_]{1,31}$/,
            "角色名需为小写字母/数字/下划线，2-32位",
          ),
        description: z.string().max(200).optional().default(""),
      })
      .parse(body);
    const exist = await this.roleRepo.findOne({ where: { name } });
    if (exist) throw new HttpException("角色已存在", HttpStatus.CONFLICT);
    const role = this.roleRepo.create({
      name,
      description,
      isBuiltin: 0,
      createdAt: Date.now(),
    } as Partial<Role>);
    await this.roleRepo.save(role);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "role",
      targetId: name,
      action: "create",
      after: { name, description },
      diffSummary: `新建角色 ${name}`,
    });
    return { ok: true, name };
  }

  @Delete("roles/:name")
  async deleteRole(
    @Param("name") name: string,
    @Req() req: Request,
  ): Promise<any> {
    const role = await this.roleRepo.findOne({ where: { name } });
    if (!role) throw new HttpException("角色不存在", HttpStatus.NOT_FOUND);
    if (role.isBuiltin === 1)
      throw new HttpException("内置角色不可删除", HttpStatus.FORBIDDEN);
    const keyCount = await this.keyRepo.count({
      where: { role: name, revoked: 0 },
    });
    if (keyCount > 0)
      throw new HttpException(
        `该角色下仍有 ${keyCount} 个有效 Key，请先迁移或吊销`,
        HttpStatus.CONFLICT,
      );
    await this.ruleRepo.delete({ role: name });
    await this.roleRepo.delete({ name });
    this.rbac.bumpRulesVersion();
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "role",
      targetId: name,
      action: "delete",
      before: { name, description: role.description },
      diffSummary: `删除角色 ${name}`,
    });
    return { ok: true };
  }

  // ── 规则 ──────────────────────────────────────────────

  @Get("roles/:name/rules")
  async getRules(@Param("name") name: string): Promise<any> {
    const role = await this.roleRepo.findOne({ where: { name } });
    if (!role) throw new HttpException("角色不存在", HttpStatus.NOT_FOUND);
    const rules = await this.ruleRepo.find({
      where: { role: name },
      order: { sort: "ASC" },
    });
    return {
      role: name,
      rules: rules.map((r) => ({
        id: r.id,
        effect: r.effect,
        pattern: r.pattern,
        sort: r.sort,
        memo: r.memo,
      })),
    };
  }

  /**
   * 保存规则（事务整体替换）。dryRun=true 时只返回预览不落库。
   * sort 由 normalizeSort 按「deny 组在前、allow 组在后」自动重排，管理员无需手填数字。
   */
  @Put("roles/:name/rules")
  async saveRules(
    @Param("name") name: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const { rules, dryRun } = z
      .object({
        rules: z.array(ruleInput).max(200),
        dryRun: z.boolean().optional().default(false),
      })
      .parse(body);
    const role = await this.roleRepo.findOne({ where: { name } });
    if (!role) throw new HttpException("角色不存在", HttpStatus.NOT_FOUND);

    // 校验 pattern 合法（复用 RBAC 的正则编译，非法则抛错）
    const normalized = RbacService.normalizeSort(rules);
    const allTools = this.registry.allToolNames(true);
    const preview = await this.buildPreview(name, normalized, allTools);
    if (dryRun) return { ok: true, dryRun: true, preview };

    const before = await this.ruleRepo.find({
      where: { role: name },
      order: { sort: "ASC" },
    });
    await this.ruleRepo.manager.transaction(async (em) => {
      await em.delete(RoleRule, { role: name });
      if (normalized.length > 0) {
        const rows = normalized.map((r, i) =>
          em.create(RoleRule, {
            role: name,
            effect: r.effect,
            pattern: r.pattern,
            sort: r.sort,
            memo: rules[i]?.memo ?? "",
          }),
        );
        await em.save(rows);
      }
    });
    this.rbac.bumpRulesVersion();
    await this.rbac.loadRules(name);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "role_rules",
      targetId: name,
      action: "update",
      before: before.map((r) => ({ effect: r.effect, pattern: r.pattern })),
      after: normalized.map((r) => ({ effect: r.effect, pattern: r.pattern })),
      diffSummary: `更新角色 ${name} 规则：+${preview.gained.length} -${preview.lost.length}`,
    });
    // 权限变化 → 通知在线客户端刷新工具列表
    this.sessions.broadcastListChanged();
    return { ok: true, preview };
  }

  /** 计算一组规则相对当前状态的差异（新增/失去可见的工具、受影响 Key、近 7d 命中次数） */
  private async buildPreview(
    role: string,
    newRules: MatchableRule[],
    allTools: string[],
  ) {
    await this.rbac.loadRules(role);
    const currentSet = this.rbac.buildAllowedSet(
      role,
      allTools,
      this.registry.version,
    );
    const nextSet = this.rbac.computeWithRules(newRules, allTools);
    const gained = [...nextSet].filter((t) => !currentSet.has(t));
    const lost = [...currentSet].filter((t) => !nextSet.has(t));
    const affectedKeys = await this.keyRepo.find({
      where: { role, revoked: 0 },
    });

    // PRD 7.2-3 补数据：近 7d 该角色对 lost/gained 工具的命中次数，让管理员能看见“这个变更会屏蔽多少现实调用”
    const sinceTs = Date.now() - 7 * 86_400_000;
    const impactSet = new Set<string>([...lost, ...gained]);
    const impact7d: Record<string, number> = {};
    if (impactSet.size > 0) {
      const rows = await this.auditRepo
        .createQueryBuilder("a")
        .select("a.tool", "tool")
        .addSelect("COUNT(*)", "cnt")
        .where("a.role = :role", { role })
        .andWhere("a.ts >= :since", { since: sinceTs })
        .andWhere("a.event = :ev", { ev: "tool_call" })
        .groupBy("a.tool")
        .getRawMany<{ tool: string; cnt: string }>();
      for (const r of rows) {
        if (impactSet.has(r.tool)) impact7d[r.tool] = Number(r.cnt);
      }
    }
    const lostCalls7d = lost.reduce((s, t) => s + (impact7d[t] ?? 0), 0);
    const gainedCalls7d = gained.reduce((s, t) => s + (impact7d[t] ?? 0), 0);

    return {
      role,
      currentCount: currentSet.size,
      nextCount: nextSet.size,
      gained,
      lost,
      affectedKeys: affectedKeys.map((k) => ({
        id: k.id,
        name: k.name,
        userName: k.userName,
        keyPrefix: k.keyPrefix,
      })),
      affectedKeyCount: affectedKeys.length,
      // 新增：影响面量化，前端预览弹窗直接读这几个字段
      recent7dCalls: impact7d,
      lostCalls7d,
      gainedCalls7d,
      totalImpact7d: lostCalls7d + gainedCalls7d,
    };
  }

  /** 变更预览（不落库，供前端「保存前确认」弹窗） */
  @Post("permissions/preview")
  async preview(@Body() body: unknown): Promise<any> {
    const { role, rules } = z
      .object({ role: z.string(), rules: z.array(ruleInput).max(200) })
      .parse(body);
    const exists = await this.roleRepo.findOne({ where: { name: role } });
    if (!exists) throw new HttpException("角色不存在", HttpStatus.NOT_FOUND);
    const normalized = RbacService.normalizeSort(rules);
    const allTools = this.registry.allToolNames(true);
    return this.buildPreview(role, normalized, allTools);
  }

  /**
   * F2・一键回滚角色规则到某次变更前的快照。
   * 仅允许回滚 targetType='role_rules' 且 action='update' 的历史；其他类型（upstream/api_key 等）语义复杂，下期再扩。
   * 事务内部一次完成：旧集 → new集 → bumpRulesVersion → loadRules → 开变更 → broadcastListChanged。
   */
  @Post("roles/:name/rules/rollback")
  async rollbackRules(
    @Param("name") name: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const { changeId } = z
      .object({ changeId: z.number().int().positive() })
      .parse(body);
    const role = await this.roleRepo.findOne({ where: { name } });
    if (!role) throw new HttpException("角色不存在", HttpStatus.NOT_FOUND);
    const chg = await this.changes.getById(changeId);
    if (!chg) throw new HttpException("变更归档不存在", HttpStatus.NOT_FOUND);
    if (chg.targetType !== "role_rules" || chg.targetId !== name) {
      throw new HttpException(
        "仅允许回滚当前角色的规则变更",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (chg.action !== "update" && chg.action !== "rollback") {
      throw new HttpException(
        "仅支持回滚“更新”或“回滚”类型的历史行",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!chg.beforeJson)
      throw new HttpException(
        "历史行无 before 快照，无法回滚",
        HttpStatus.BAD_REQUEST,
      );

    const beforeRules = JSON.parse(chg.beforeJson) as Array<{
      effect: "allow" | "deny";
      pattern: string;
    }>;
    if (!Array.isArray(beforeRules))
      throw new HttpException(
        "快照格式不合法",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

    // 规范化 sort（deny 前 allow 后），与保存时同语义
    const normalized = RbacService.normalizeSort(
      beforeRules.map((r) => ({ effect: r.effect, pattern: r.pattern })),
    );
    const current = await this.ruleRepo.find({
      where: { role: name },
      order: { sort: "ASC" },
    });
    const allTools = this.registry.allToolNames(true);
    const preview = await this.buildPreview(name, normalized, allTools);

    await this.ruleRepo.manager.transaction(async (em) => {
      await em.delete(RoleRule, { role: name });
      if (normalized.length > 0) {
        const rows = normalized.map((r) =>
          em.create(RoleRule, {
            role: name,
            effect: r.effect,
            pattern: r.pattern,
            sort: r.sort,
            memo: `rollback#${changeId}`,
          }),
        );
        await em.save(rows);
      }
    });
    this.rbac.bumpRulesVersion();
    await this.rbac.loadRules(name);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "role_rules",
      targetId: name,
      action: "rollback",
      before: current.map((r) => ({ effect: r.effect, pattern: r.pattern })),
      after: normalized.map((r) => ({ effect: r.effect, pattern: r.pattern })),
      diffSummary: `回滚角色 ${name} 规则至变更 #${changeId} 之前(+${preview.gained.length} -${preview.lost.length})`,
    });
    this.sessions.broadcastListChanged();
    return { ok: true, rolledBackTo: changeId, preview };
  }

  /**
   * 权限矩阵：角色 × 工具，实时计算（不存储，避免与 RBAC 结果漂移）。
   * 返回每个角色对每个工具的 allow/deny 状态，前端渲染成勾选网格。
   */
  @Get("permissions/matrix")
  async matrix(@Query("upstream") upstream?: string): Promise<any> {
    const roles = await this.roleRepo.find({ order: { createdAt: "ASC" } });
    let tools = this.registry.allToolNames(true);
    if (upstream) tools = tools.filter((t) => t.startsWith(`${upstream}__`));
    const columns = tools.map((fn) => {
      const e = this.registry.get(fn);
      return {
        fullName: fn,
        upstream: e?.upstream ?? fn.split("__")[0],
        enabled: e?.enabled ?? true,
        sensitivity: e?.sensitivity ?? "normal",
      };
    });
    const rows: any[] = [];
    for (const role of roles) {
      await this.rbac.loadRules(role.name);
      const allowed = this.rbac.buildAllowedSet(
        role.name,
        tools,
        this.registry.version,
      );
      const cells: Record<string, boolean> = {};
      for (const fn of tools) cells[fn] = allowed.has(fn);
      rows.push({
        role: role.name,
        description: role.description,
        allowedCount: allowed.size,
        cells,
      });
    }
    return { columns, rows, registryVersion: this.registry.version };
  }
}

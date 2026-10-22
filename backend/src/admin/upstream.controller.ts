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
import { Request } from "express";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { z } from "zod";
import { LogtoGuard, type AuthedRequest } from "./guards/logto.guard";
import { actorOf } from "./actor";
import { Upstream } from "../database/entities/upstream.entity";
import { UpstreamManagerService } from "../gateway/upstream-manager.service";
import { CryptoService } from "../auth/crypto.service";
import { ChangeLogService } from "./change-log.service";
import { SessionManager } from "../transport/session.manager";

const NAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;

const CreateUpstreamSchema = z.object({
  name: z.string().regex(NAME_RE, "name 需匹配 ^[a-z][a-z0-9_-]{1,31}$"),
  displayName: z.string().optional().default(""),
  transport: z.enum(["http", "stdio"]).default("http"),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  sensitivity: z.enum(["normal", "high"]).default("normal"),
  owner: z.string().optional().default(""),
  timeoutMs: z.number().int().positive().optional().default(20000),
  concurrency: z.number().int().positive().optional().default(20),
  remark: z.string().optional().default(""),
  // 上线/下线开关：0=软删下线，1=上线启用。创建默认 1；PUT 可翻转，支持“重新启用已软删的上游”。
  enabled: z.number().int().min(0).max(1).optional().default(1),
});

const UpdateUpstreamSchema = CreateUpstreamSchema.partial().omit({
  name: true,
});

@Controller("admin/api/upstreams")
@UseGuards(LogtoGuard)
export class UpstreamAdminController {
  constructor(
    @InjectRepository(Upstream)
    private readonly repo: Repository<Upstream>,
    private readonly manager: UpstreamManagerService,
    private readonly crypto: CryptoService,
    private readonly changes: ChangeLogService,
    private readonly sessions: SessionManager,
  ) {}

  private actor(req: Request): string {
    return actorOf(req);
  }

  private isSensitive(req: Request): boolean {
    return (
      (req as AuthedRequest).auth?.scopes.includes("gateway:sensitive") ?? false
    );
  }

  /**
   * 默认脱敏（fail-closed）：只有显式传 sensitive=true 才展开连接细节。
   * 调用方漏传只会少给字段，不会多给。
   */
  private serialize(u: Upstream, sensitive = false) {
    const masking = !sensitive;
    return {
      id: u.id,
      name: u.name,
      displayName: u.displayName,
      transport: u.transport,
      url: masking ? null : u.url,
      headersMasked:
        masking || !u.headersEnc ? null : this.safeMaskHeaders(u.headersEnc),
      command: masking ? null : u.command,
      args: masking ? [] : u.argsJson ? JSON.parse(u.argsJson) : [],
      cwd: masking ? null : u.cwd,
      sensitivity: u.sensitivity,
      enabled: u.enabled,
      owner: u.owner,
      timeoutMs: u.timeoutMs,
      concurrency: u.concurrency,
      remark: u.remark,
      lastStatus: u.lastStatus,
      lastError: masking ? null : u.lastError,
      lastCheckedAt: u.lastCheckedAt,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    };
  }

  private safeMaskHeaders(enc: string): Record<string, string> {
    try {
      const h = this.crypto.decryptJson<Record<string, string>>(enc) ?? {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(h))
        out[k] = this.crypto.maskSecret(String(v));
      return out;
    } catch {
      return { _error: "解密失败（主密钥不匹配）" };
    }
  }

  @Get()
  async list(@Req() req: Request): Promise<any[]> {
    const rows = await this.repo.find({ order: { createdAt: "DESC" } });
    const sensitive = this.isSensitive(req);
    return rows.map((r) => this.serialize(r, sensitive));
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: Request): Promise<any> {
    const input = CreateUpstreamSchema.parse(body);
    if (input.transport === "http") {
      if (!input.url)
        throw new HttpException(
          "http 传输必须提供 url",
          HttpStatus.BAD_REQUEST,
        );
      const v = this.manager.validateUrl(input.url);
      if (!v.ok)
        throw new HttpException(
          `上游地址被拒绝：${v.reason}`,
          HttpStatus.BAD_REQUEST,
        );
    } else {
      if (!input.command)
        throw new HttpException(
          "stdio 传输必须提供 command",
          HttpStatus.BAD_REQUEST,
        );
    }
    const exists = await this.repo.findOne({ where: { name: input.name } });
    if (exists)
      throw new HttpException(`上游 ${input.name} 已存在`, HttpStatus.CONFLICT);

    const now = Date.now();
    const entity = this.repo.create({
      name: input.name,
      displayName: input.displayName ?? "",
      transport: input.transport,
      url: input.url ?? null,
      headersEnc: this.crypto.encryptJson(input.headers ?? null),
      command: input.command ?? null,
      argsJson: input.args ? JSON.stringify(input.args) : null,
      cwd: input.cwd ?? null,
      envEnc: this.crypto.encryptJson(input.env ?? null),
      sensitivity: input.sensitivity,
      enabled: input.enabled ?? 1,
      owner: input.owner ?? "",
      timeoutMs: input.timeoutMs,
      concurrency: input.concurrency,
      remark: input.remark ?? "",
      // 走到这里说明上面的试连接已成功；实体尚未落库，connect() 里的 markStatus 更新不到行，
      // 故直接写入首次探测结果，避免卡片显示“未知”
      lastStatus: "up",
      lastError: "",
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now,
    } as Partial<Upstream>);

    // 先试连接，失败不落库
    const probe = await this.manager.connect(entity as Upstream);
    if (!probe.ok) {
      throw new HttpException(
        `上游连接失败，未保存：${probe.error}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    const saved = await this.repo.save(entity);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "upstream",
      targetId: saved.name,
      action: "create",
      after: this.serialize(saved, true),
      diffSummary: `新增上游 ${saved.name}（${saved.transport}）`,
    });
    this.sessions.broadcastListChanged();
    return this.serialize(saved, true);
  }

  @Put(":name")
  async update(
    @Param("name") name: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const input = UpdateUpstreamSchema.parse(body);
    const u = await this.repo.findOne({ where: { name } });
    if (!u) throw new HttpException("上游不存在", HttpStatus.NOT_FOUND);
    const before = this.serialize(u, true);
    if (input.url !== undefined) u.url = input.url;
    if (input.headers !== undefined)
      u.headersEnc = this.crypto.encryptJson(input.headers);
    if (input.displayName !== undefined) u.displayName = input.displayName;
    if (input.sensitivity !== undefined) u.sensitivity = input.sensitivity;
    if (input.owner !== undefined) u.owner = input.owner;
    if (input.timeoutMs !== undefined) u.timeoutMs = input.timeoutMs;
    if (input.concurrency !== undefined) u.concurrency = input.concurrency;
    if (input.remark !== undefined) u.remark = input.remark;
    if (input.command !== undefined) u.command = input.command;
    if (input.args !== undefined) u.argsJson = JSON.stringify(input.args);
    if (input.env !== undefined) u.envEnc = this.crypto.encryptJson(input.env);
    if (input.enabled !== undefined) u.enabled = input.enabled;
    u.updatedAt = Date.now();
    const saved = await this.repo.save(u);
    await this.manager.disconnect(name).catch(() => {});
    await this.manager.connect(saved);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "upstream",
      targetId: name,
      action: "update",
      before,
      after: this.serialize(saved, true),
      diffSummary: `更新上游 ${name} 配置`,
    });
    this.sessions.broadcastListChanged();
    return this.serialize(saved, true);
  }

  @Delete(":name")
  async remove(
    @Param("name") name: string,
    @Req() req: Request,
  ): Promise<{ ok: boolean }> {
    const u = await this.repo.findOne({ where: { name } });
    if (!u) throw new HttpException("上游不存在", HttpStatus.NOT_FOUND);
    await this.manager.disconnect(name);
    u.enabled = 0;
    u.updatedAt = Date.now();
    await this.repo.save(u);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "upstream",
      targetId: name,
      action: "disable",
      before: this.serialize(u, true),
      diffSummary: `下线上游 ${name}`,
    });
    this.sessions.broadcastListChanged();
    return { ok: true };
  }

  @Post(":name/probe")
  async probe(@Param("name") name: string): Promise<any> {
    return this.manager.probe(name);
  }

  @Post(":name/refresh")
  async refresh(@Param("name") name: string): Promise<any> {
    const res = await this.manager.refresh(name);
    this.sessions.broadcastListChanged();
    return res;
  }
}

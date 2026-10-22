import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { z } from "zod";
import { LogtoGuard, RequireScopes } from "./guards/logto.guard";
import { actorOf } from "./actor";
import { ApiKeyService } from "../auth/apikey.service";
import { Role } from "../database/entities/identity.entity";
import { ChangeLogService } from "./change-log.service";

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  userName: z.string().min(1).max(100),
  team: z.string().optional().default(""),
  role: z.string().min(1),
  profile: z.string().optional().default(""),
  expiresInDays: z.number().int().positive().nullable().optional(),
});

const RevokeUserSchema = z.object({
  userName: z.string().min(1).max(100),
  reason: z.enum(["leak", "offboard", "rotate", "other"]).default("offboard"),
});

@Controller("admin/api/keys")
@UseGuards(LogtoGuard)
export class KeyAdminController {
  constructor(
    private readonly keys: ApiKeyService,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly changes: ChangeLogService,
  ) {}

  private actor(req: Request): string {
    return actorOf(req);
  }

  /**
   * 签发：明文只在此响应出现一次。
   *
   * 必须 gateway:sensitive：签名可以指定任意角色（含内置 `admin`），
   * 只校验 write 的话，写角色能给自己 mint 一把全权限 Key，绕过 Key 管理边界。
   * 吊销类接口不收紧——止损动作不该被权限卡住。
   */
  @Post()
  @RequireScopes("gateway:sensitive")
  async issue(@Body() body: unknown, @Req() req: Request): Promise<any> {
    const input = CreateKeySchema.parse(body);
    const role = await this.roleRepo.findOne({ where: { name: input.role } });
    if (!role)
      throw new HttpException(
        `角色 ${input.role} 不存在`,
        HttpStatus.BAD_REQUEST,
      );
    const { raw, key } = await this.keys.issue({
      name: input.name,
      userName: input.userName,
      team: input.team,
      role: input.role,
      profile: input.profile,
      expiresInDays: input.expiresInDays ?? null,
      createdBy: this.actor(req),
    });
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "api_key",
      targetId: String(key.id),
      action: "create",
      after: { prefix: key.keyPrefix, user: key.userName, role: key.role },
      diffSummary: `签发 Key ${key.keyPrefix}（${key.userName}/${key.role}）`,
    });
    return {
      raw,
      id: key.id,
      prefix: key.keyPrefix,
      name: key.name,
      userName: key.userName,
      role: key.role,
    };
  }

  @Get()
  @RequireScopes("gateway:sensitive")
  async list(
    @Query("user") user?: string,
    @Query("role") role?: string,
    @Query("revoked") revoked?: string,
  ): Promise<any[]> {
    const rows = await this.keys.list({
      user,
      role,
      revoked: revoked != null && revoked !== "" ? Number(revoked) : undefined,
    });
    return rows.map((k) => ({
      id: k.id,
      prefix: k.keyPrefix,
      name: k.name,
      userName: k.userName,
      team: k.team,
      role: k.role,
      profile: k.profile,
      expiresAt: k.expiresAt,
      revoked: k.revoked,
      revokeReason: k.revokeReason,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    }));
  }

  /**
   * 按使用者一键吊销其名下所有有效 Key。
   *
   * 离职/封禁场景：Logto 侧停用账号只影响控制台登录，不影响 `mgw_live_` Key；
   * 必须在网关侧把该 userName 的 Key 全部吊销，才算真正切断调用能力。
   */
  @Post("revoke-user")
  @RequireScopes("gateway:sensitive")
  async revokeUser(@Body() body: unknown, @Req() req: Request): Promise<any> {
    const { userName, reason } = RevokeUserSchema.parse(body);
    const { count, prefixes } = await this.keys.revokeByUser(
      userName,
      reason,
      this.actor(req),
    );
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "api_key",
      targetId: `user:${userName}`,
      action: "revoke",
      after: { userName, reason, count, prefixes },
      diffSummary: `按使用者吊销 ${userName} 名下 ${count} 个 Key（原因：${reason}）`,
    });
    return { ok: true, count, prefixes };
  }

  @Post(":id/revoke")
  async revoke(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const { reason } = z
      .object({
        reason: z
          .enum(["leak", "offboard", "rotate", "other"])
          .default("other"),
      })
      .parse(body ?? {});
    const key = await this.keys.revoke(Number(id), reason, this.actor(req));
    if (!key) throw new HttpException("Key 不存在", HttpStatus.NOT_FOUND);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "api_key",
      targetId: id,
      action: "revoke",
      after: { reason },
      diffSummary: `吊销 Key ${key.keyPrefix}（原因：${reason}）`,
    });
    return { ok: true };
  }

  /** 轮换等价于重新签发一把新凭据 → 与签发同权限 */
  @Post(":id/rotate")
  @RequireScopes("gateway:sensitive")
  async rotate(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<any> {
    const { graceMinutes } = z
      .object({ graceMinutes: z.number().int().min(0).optional().default(0) })
      .parse(body ?? {});
    const res = await this.keys.rotate(
      Number(id),
      graceMinutes * 60_000,
      this.actor(req),
    );
    if (!res) throw new HttpException("Key 不存在", HttpStatus.NOT_FOUND);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: "api_key",
      targetId: id,
      action: "update",
      after: { newPrefix: res.key.keyPrefix, graceMinutes },
      diffSummary: `轮换 Key（新 ${res.key.keyPrefix}，宽限 ${graceMinutes} 分钟）`,
    });
    return { raw: res.raw, id: res.key.id, prefix: res.key.keyPrefix };
  }
}

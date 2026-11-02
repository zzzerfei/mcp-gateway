import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { AdminTokenGuard } from './guards/admin-token.guard';
import { ApiKeyService } from '../auth/apikey.service';
import { Role } from '../database/entities/identity.entity';
import { ChangeLogService } from './change-log.service';

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  userName: z.string().min(1).max(100),
  team: z.string().optional().default(''),
  role: z.string().min(1),
  profile: z.string().optional().default(''),
  expiresInDays: z.number().int().positive().nullable().optional(),
});

@Controller('admin/api/keys')
@UseGuards(AdminTokenGuard)
export class KeyAdminController {
  constructor(
    private readonly keys: ApiKeyService,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly changes: ChangeLogService,
  ) {}

  private actor(req: Request): string {
    return (req.headers['x-admin-user'] as string) || 'admin';
  }

  /** 签发：明文只在此响应出现一次 */
  @Post()
  async issue(@Body() body: unknown, @Req() req: Request): Promise<any> {
    const input = CreateKeySchema.parse(body);
    const role = await this.roleRepo.findOne({ where: { name: input.role } });
    if (!role) throw new HttpException(`角色 ${input.role} 不存在`, HttpStatus.BAD_REQUEST);
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
      targetType: 'api_key',
      targetId: String(key.id),
      action: 'create',
      after: { prefix: key.keyPrefix, user: key.userName, role: key.role },
      diffSummary: `签发 Key ${key.keyPrefix}（${key.userName}/${key.role}）`,
    });
    return { raw, id: key.id, prefix: key.keyPrefix, name: key.name, userName: key.userName, role: key.role };
  }

  @Get()
  async list(@Query('user') user?: string, @Query('role') role?: string, @Query('revoked') revoked?: string): Promise<any[]> {
    const rows = await this.keys.list({
      user,
      role,
      revoked: revoked != null && revoked !== '' ? Number(revoked) : undefined,
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

  @Post(':id/revoke')
  async revoke(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<any> {
    const { reason } = z.object({ reason: z.enum(['leak', 'offboard', 'rotate', 'other']).default('other') }).parse(body ?? {});
    const key = await this.keys.revoke(Number(id), reason, this.actor(req));
    if (!key) throw new HttpException('Key 不存在', HttpStatus.NOT_FOUND);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: 'api_key',
      targetId: id,
      action: 'revoke',
      after: { reason },
      diffSummary: `吊销 Key ${key.keyPrefix}（原因：${reason}）`,
    });
    return { ok: true };
  }

  @Post(':id/rotate')
  async rotate(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<any> {
    const { graceMinutes } = z.object({ graceMinutes: z.number().int().min(0).optional().default(0) }).parse(body ?? {});
    const res = await this.keys.rotate(Number(id), graceMinutes * 60_000, this.actor(req));
    if (!res) throw new HttpException('Key 不存在', HttpStatus.NOT_FOUND);
    await this.changes.record({
      actor: this.actor(req),
      actorIp: req.ip,
      targetType: 'api_key',
      targetId: id,
      action: 'update',
      after: { newPrefix: res.key.keyPrefix, graceMinutes },
      diffSummary: `轮换 Key（新 ${res.key.keyPrefix}，宽限 ${graceMinutes} 分钟）`,
    });
    return { raw: res.raw, id: res.key.id, prefix: res.key.keyPrefix };
  }
}

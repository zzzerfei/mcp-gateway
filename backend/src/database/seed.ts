/**
 * 种子脚本：npm run seed（ts-node 直接执行，不经 Nest 容器）。
 * 幂等：角色/设置按主键 upsert，规则整体替换，重复执行结果一致。
 *
 * 播种内容：
 * - 3 个内置角色 intern / support / admin 及其 RBAC 规则（deny 组在前）
 * - DEFAULT_SETTINGS 全量初值
 * - 1 个演示用 admin Key（明文只在本次输出打印一次，库中仅存哈希）
 */
import { DataSource } from 'typeorm';
import { buildDataSourceOptions, defaultDbPath } from './data-source';
import { Role, RoleRule, Setting, ApiKey, DEFAULT_SETTINGS } from './entities';
import { ConfigService } from '../config/config.service';
import { CryptoService } from '../auth/crypto.service';
import { RbacService } from '../auth/rbac.service';

interface SeedRule {
  effect: 'allow' | 'deny';
  pattern: string;
  memo: string;
}

/**
 * 角色规则设计（对应 PRD 的最小可用权限模型）：
 * - intern：默认全拒，仅放开只读检索类；显式 deny 一切 delete/write
 * - support：放开业务上游，deny 高危的 crm 删除与财务写
 * - admin：放开一切（*），仅 deny 明确的毁灭性操作
 * 通配符语义：upstream__tool，'*' 匹配任意，'*__delete_*' 匹配所有删除类工具。
 */
const ROLE_SEEDS: Array<{ name: string; description: string; rules: SeedRule[] }> = [
  {
    name: 'intern',
    description: '实习生：只读检索，禁止任何写/删',
    rules: [
      { effect: 'deny', pattern: '*__delete_*', memo: '禁止一切删除类工具' },
      { effect: 'deny', pattern: '*__write_*', memo: '禁止一切写入类工具' },
      { effect: 'deny', pattern: 'finance__*', memo: '财务上游完全隔离' },
      { effect: 'allow', pattern: 'wiki__*', memo: '放开知识库检索' },
      { effect: 'allow', pattern: '*__search', memo: '放开各上游的搜索类只读工具' },
    ],
  },
  {
    name: 'support',
    description: '客服：业务上游可用，禁高危删除与财务写',
    rules: [
      { effect: 'deny', pattern: 'crm__delete_*', memo: 'CRM 删除需 admin' },
      { effect: 'deny', pattern: 'finance__refund_*', memo: '退款需 admin 复核' },
      { effect: 'allow', pattern: 'crm__*', memo: '放开 CRM 业务工具' },
      { effect: 'allow', pattern: 'wiki__*', memo: '放开知识库' },
      { effect: 'allow', pattern: 'order__*', memo: '放开订单查询/处理' },
    ],
  },
  {
    name: 'admin',
    description: '管理员：全量放开，仅禁毁灭性操作',
    rules: [
      { effect: 'deny', pattern: '*__drop_*', memo: '禁止 drop 类毁灭操作' },
      { effect: 'allow', pattern: '*', memo: '管理员默认全放开' },
    ],
  },
];

async function main(): Promise<void> {
  const ds = new DataSource(buildDataSourceOptions(defaultDbPath(), true));
  await ds.initialize();
  const now = Date.now();

  const roleRepo = ds.getRepository(Role);
  const ruleRepo = ds.getRepository(RoleRule);
  const settingRepo = ds.getRepository(Setting);
  const keyRepo = ds.getRepository(ApiKey);

  // 1) 角色 + 规则
  for (const seed of ROLE_SEEDS) {
    const exist = await roleRepo.findOne({ where: { name: seed.name } });
    if (!exist) {
      await roleRepo.save(roleRepo.create({ name: seed.name, description: seed.description, isBuiltin: 1, createdAt: now }));
    } else {
      exist.description = seed.description;
      await roleRepo.save(exist);
    }
    // 规则整体替换（幂等）
    await ruleRepo.delete({ role: seed.name });
    const normalized = RbacService.normalizeSort(seed.rules);
    const rows = normalized.map((r, i) =>
      ruleRepo.create({ role: seed.name, effect: r.effect, pattern: r.pattern, sort: r.sort, memo: seed.rules.find((x) => x.pattern === r.pattern)?.memo ?? '' }),
    );
    await ruleRepo.save(rows);
    // eslint-disable-next-line no-console
    console.log(`[seed] 角色 ${seed.name}：${rows.length} 条规则`);
  }

  // 2) 设置初值（不覆盖已存在的，避免抹掉运维调整）
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const exist = await settingRepo.findOne({ where: { key } });
    if (!exist) {
      await settingRepo.save(settingRepo.create({ key, value, updatedBy: 'seed', updatedAt: now }));
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] 设置项：${Object.keys(DEFAULT_SETTINGS).length} 个（已存在的不覆盖）`);

  // 3) 演示 Key（仅当库中一个 key 都没有时才签发，避免重复执行刷屏）
  const keyCount = await keyRepo.count();
  if (keyCount === 0) {
    const config = new ConfigService();
    const crypto = new CryptoService(config);
    const { raw, hash, prefix } = crypto.generateApiKey();
    await keyRepo.save(
      keyRepo.create({
        keyHash: hash,
        keyPrefix: prefix,
        name: '演示-管理员Key',
        userName: 'demo_admin',
        team: 'platform',
        role: 'admin',
        profile: '',
        expiresAt: null,
        revoked: 0,
        createdBy: 'seed',
        createdAt: now,
      }),
    );
    // eslint-disable-next-line no-console
    console.log('\n[seed] 已签发演示 Key（明文仅此一次，请立即保存）：');
    // eslint-disable-next-line no-console
    console.log(`       ${raw}\n`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[seed] 已存在 ${keyCount} 个 Key，跳过演示 Key 签发`);
  }

  await ds.destroy();
  // eslint-disable-next-line no-console
  console.log('[seed] 完成');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[seed] 失败：', e);
  process.exit(1);
});

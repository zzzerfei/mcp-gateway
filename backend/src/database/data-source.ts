import { DataSource, DataSourceOptions } from 'typeorm';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { ALL_ENTITIES } from './entities';

/**
 * SQLite 连接选项工厂。Nest 运行时、TypeORM CLI、seed 脚本共用同一份，
 * 杜绝「CLI 建的表和运行时不一致」这类经典坑。
 *
 * 关键决策：
 * - better-sqlite3 驱动（同步、零外部依赖、单文件），契合轻量化技术栈诉求
 * - WAL 模式：读写不互斥，审计攒批写入不阻塞 MCP 调用读路径
 * - busy_timeout：并发写撞锁时等待而非立即抛 SQLITE_BUSY
 * - foreign_keys ON：SQLite 默认关闭外键约束，必须显式打开
 * - synchronize：MVP 阶段由实体自动建表；生产可切 migrations（见 README）
 */
export function buildDataSourceOptions(dbPath: string, synchronize = true): DataSourceOptions {
  const dir = resolve(dbPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return {
    type: 'better-sqlite3',
    database: dbPath,
    entities: ALL_ENTITIES,
    synchronize,
    logging: false,
    // better-sqlite3 专属：拿到裸连接后执行 PRAGMA
    prepareDatabase: (db: any) => {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('foreign_keys = ON');
      db.pragma('synchronous = NORMAL');
    },
  } as DataSourceOptions;
}

/** 默认库路径：./data/gateway.db（可用 MGW_DATA_DIR 覆盖） */
export function defaultDbPath(): string {
  const dataDir = resolve(process.env.MGW_DATA_DIR ?? './data');
  return join(dataDir, 'gateway.db');
}

/** TypeORM CLI 入口（migration:generate / migration:run 等） */
const dataSource = new DataSource(buildDataSourceOptions(defaultDbPath(), false));
export default dataSource;

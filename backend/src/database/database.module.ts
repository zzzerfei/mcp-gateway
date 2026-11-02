import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '../config/config.service';
import { ALL_ENTITIES } from './entities';
import { buildDataSourceOptions } from './data-source';

/**
 * 数据库模块（全局）。forRootAsync 注入 ConfigService 拿到 dbPath，
 * forFeature 注册全部 9 张表的 Repository，并整体 export，
 * 使任意模块的 @InjectRepository 都能解析——数据访问是横切关注点。
 *
 * synchronize 由 MGW_DB_SYNCHRONIZE 控制：默认开（MVP 自动建表），
 * 生产建议置 0 并改用 migrations（README 有说明）。
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildDataSourceOptions(config.dbPath, process.env.MGW_DB_SYNCHRONIZE !== '0'),
    }),
    TypeOrmModule.forFeature(ALL_ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}

import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ZodError } from 'zod';

/**
 * ZodError 全局过滤器。
 * 目的：把 zod `.parse()` 抛出的验证错误从默认 500 归一化为 400 + 结构化 details，
 * 让前端与运维一眼看到「哪个字段错了、期望什么」，避免所有 admin 写端点在参数
 * 校验失败时统一黑盒 500。
 *
 * Nest 内置的 HttpException / 业务自定义异常不会命中此 filter，行为保持不变。
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(err: ZodError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();

    const issues = err.errors.map((e) => ({
      path: e.path.length > 0 ? e.path.join('.') : '(root)',
      code: e.code,
      message: e.message,
      expected: (e as unknown as { expected?: string }).expected,
      received: (e as unknown as { received?: string }).received,
    }));

    res.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'validation_failed',
      message: issues.map((i) => `${i.path}: ${i.message}`).join('; '),
      issues,
    });
  }
}

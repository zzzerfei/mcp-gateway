import { Request } from "express";
import type { AuthedRequest } from "./guards/logto.guard";

/**
 * 审计/留痕用的操作者标识。
 *
 * 必须是**不可变**的标识，否则同一个人会被拆成多个 actor，历史记录断链：
 * - 用 `sub`：Logto 内部永久 ID
 * - 用 `username`：登录名，已被设为 ReadOnly（管理员维护）
 * - **绝不用 `name`**：展示名允许用户自助修改，一旦参与审计就会漂移
 *
 * 来源是已验签的 token，而不是可伪造的 `x-admin-user` 头。
 */
export function actorOf(req: Request): string {
  const auth = (req as AuthedRequest).auth;
  return auth?.sub ?? auth?.username ?? "unknown";
}

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { logto, getGatewayScopes, refreshGatewayScopes } from "../lib/logto";
import { setUnauthorizedHandler, setScopeMissingHandler } from "../api/client";

const REDIRECT_KEY = "mgw_login_redirect";

/**
 * 认证 + 授权状态。
 *
 * - 认证由 Logto 托管（OIDC + PKCE），身份取自 ID token
 * - 授权取自 access token 里的 scope（后端另有一份独立验签，前端不承担安全判断）
 * - canWrite / canSensitive 只用于隐藏按钮；真正的拦截在后端 Guard
 */
export const useAuthStore = defineStore("auth", () => {
  const authenticated = ref(false);
  const user = ref("");
  const displayName = ref("");
  const scopes = ref<string[]>([]);
  const ready = ref(false);

  const signedIn = computed(() => authenticated.value);
  const canWrite = computed(() => scopes.value.includes("gateway:write"));
  const canSensitive = computed(() =>
    scopes.value.includes("gateway:sensitive"),
  );
  /** 有网关读权限才算"已开通"；注册后未分配角色时为 false */
  const hasAccess = computed(() => scopes.value.includes("gateway:read"));

  /**
   * 身份展示：登录账号（username）与展示名（name）分开。
   * - user 只放登录账号，不回落到 name，避免两个概念混在一起
   * - displayName 优先 name，未设置时退回登录账号
   */
  function applyClaims(claims: Record<string, unknown>): void {
    user.value =
      (claims.username as string) ||
      (claims.preferred_username as string) ||
      (claims.sub as string) ||
      "user";
    displayName.value = ((claims.name as string) ?? "").trim() || user.value;
  }

  /** 探测一次登录态（路由守卫每次进入前调用，内部只真正探测一次） */
  async function init(): Promise<void> {
    if (ready.value) return;
    try {
      authenticated.value = await logto.isAuthenticated();
      if (authenticated.value) {
        applyClaims(
          (await logto.getIdTokenClaims()) as Record<string, unknown>,
        );
        scopes.value = await getGatewayScopes();
      }
    } catch {
      authenticated.value = false;
      scopes.value = [];
    }
    ready.value = true;
  }

  /**
   * 同步展示名：账号中心改完资料后，ID token 还是旧快照，
   * 这里强制换一次 token 拿新的 name claim（不重新登录）。
   */
  async function refreshIdentity(): Promise<void> {
    if (!authenticated.value) return;
    try {
      await refreshGatewayScopes();
      applyClaims((await logto.getIdTokenClaims()) as Record<string, unknown>);
    } catch {
      /* 失败时保留旧展示，不影响使用 */
    }
  }

  /**
   * 强制刷新 token 并重算 scope。
   * 返回 true 表示权限集合发生了变化（调用方可以重试刚才被拒的请求）。
   */
  async function refreshPermissions(): Promise<boolean> {
    try {
      const before = scopes.value.slice().sort().join(" ");
      const next = await refreshGatewayScopes();
      scopes.value = next;
      return next.slice().sort().join(" ") !== before;
    } catch {
      return false;
    }
  }

  /** 跳转 Logto 登录页；登录成功回到 /callback */
  async function login(redirect = "/dashboard"): Promise<void> {
    sessionStorage.setItem(REDIRECT_KEY, redirect);
    await logto.signIn(`${location.origin}/callback`);
  }

  /** 处理 /callback?code=... ，换取 token 后回到登录前页面 */
  async function handleCallback(): Promise<string> {
    await logto.handleSignInCallback(window.location.href);
    ready.value = false;
    await init();
    const redirect = sessionStorage.getItem(REDIRECT_KEY) || "/dashboard";
    sessionStorage.removeItem(REDIRECT_KEY);
    return redirect;
  }

  /** 注销：清本地 token 并跳 Logto 的统一登出页 */
  async function logout(): Promise<void> {
    authenticated.value = false;
    user.value = "";
    displayName.value = "";
    scopes.value = [];
    ready.value = false;
    await logto.signOut(`${location.origin}/`);
  }

  // 401 时清掉本地会话并回登录页（避免拿着坏 token 反复请求）
  setUnauthorizedHandler(() => {
    void logto.clearAllTokens();
    authenticated.value = false;
    scopes.value = [];
    ready.value = true;
    if (location.pathname !== "/login") location.replace("/login");
  });

  // 403 MISSING_SCOPE 时刷新一次 token（角色刚变更的场景）
  setScopeMissingHandler(() => refreshPermissions());

  return {
    authenticated: signedIn,
    user,
    displayName,
    scopes,
    canWrite,
    canSensitive,
    hasAccess,
    ready,
    init,
    refreshIdentity,
    refreshPermissions,
    login,
    handleCallback,
    logout,
  };
});

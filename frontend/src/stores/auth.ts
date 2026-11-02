import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { tokenStore, setUnauthorizedHandler } from '../api/client';
import { verifyToken } from '../api';

/**
 * 认证状态。MCP 网关后台用「Admin Token」单一凭据（非用户名密码体系），
 * 与 MCP 通道的 API Key 完全隔离。Token 存 localStorage，刷新页面不掉线。
 */
export const useAuthStore = defineStore('auth', () => {
  const token = ref<string>(tokenStore.token);
  const user = ref<string>(tokenStore.user);
  const authenticated = computed(() => !!token.value);

  /** 登录：向后端试探 token 是否有效，有效才落地 */
  async function login(inputToken: string, inputUser: string): Promise<{ ok: boolean; error?: string }> {
    const t = inputToken.trim();
    const u = (inputUser || 'admin').trim();
    if (!t) return { ok: false, error: '请输入 Admin Token' };
    const valid = await verifyToken(t, u);
    if (!valid) return { ok: false, error: 'Token 无效或网关不可达' };
    token.value = t;
    user.value = u;
    tokenStore.token = t;
    tokenStore.user = u;
    return { ok: true };
  }

  function logout(): void {
    token.value = '';
    tokenStore.clear();
  }

  // 401 时自动登出（由 client.ts 回调），路由守卫负责跳转
  setUnauthorizedHandler(() => {
    logout();
    if (location.hash !== '#/login') location.hash = '#/login';
  });

  return { token, user, authenticated, login, logout };
});

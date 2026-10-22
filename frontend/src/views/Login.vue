<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import Icon from '../components/Icon.vue';

/**
 * 登录页。不再收集任何凭据：进入即自动跳转 Logto 统一登录页，
 * 账号密码 / 邮箱验证码 / GitHub 等登录方式都在 Logto 侧配置与演进。
 * 若 3 秒还没跳走（Logto 不可达、被拦截等），降级为手动重试，避免白屏。
 */
const auth = useAuthStore();
const route = useRoute();

const loading = ref(false);
const slow = ref(false);
const error = ref('');

let slowTimer: number | undefined;
function clearSlowTimer(): void {
  if (slowTimer) {
    clearTimeout(slowTimer);
    slowTimer = undefined;
  }
}

async function signIn(): Promise<void> {
  if (loading.value) return;
  error.value = '';
  slow.value = false;
  loading.value = true;
  clearSlowTimer();
  slowTimer = window.setTimeout(() => {
    slow.value = true;
  }, 3000);
  try {
    await auth.login((route.query.redirect as string) || '/dashboard');
  } catch (e) {
    loading.value = false;
    error.value = (e as Error).message || '无法跳转统一登录';
  } finally {
    clearSlowTimer();
  }
}

onMounted(() => {
  void signIn();
});
onBeforeUnmount(clearSlowTimer);
</script>

<template>
  <div class="h-full w-full flex items-center justify-center p-6">
    <div class="w-full max-w-md">
      <!-- 品牌区 -->
      <div class="text-center mb-8">
        <div
          class="inline-flex w-16 h-16 rounded-2xl bg-accent-solid text-accent-fg items-center justify-center text-3xl font-bold mb-5">
          M
        </div>
        <h1 class="text-2xl font-semibold text-fg tracking-tight">MCP 网关治理控制台</h1>
        <p class="text-sm text-muted mt-2">企业级 MCP 工具网关 · 权限 / 限流 / 熔断 / 审计一体化治理</p>
      </div>

      <!-- 登录卡片 -->
      <div class="glass-card p-7 backdrop-blur-2xl">
        <transition name="fade">
          <div v-if="error"
            class="flex items-center gap-2 text-danger text-xs bg-danger-soft border border-danger-line rounded-lg px-3 py-2.5 mb-4">
            <Icon name="alert" :size="14" />
            <span>{{ error }}</span>
          </div>
        </transition>

        <button type="button" class="btn-primary w-full py-2.5" :disabled="loading" @click="signIn">
          <Icon v-if="!loading" name="lock" :size="16" />
          <span v-else class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          {{ loading ? '正在跳转统一登录…' : '使用统一身份登录' }}
        </button>

        <transition name="fade">
          <p v-if="slow" class="text-[11px] text-warn mt-3 leading-relaxed">
            跳转比预期慢，可能统一登录服务不可达。可点击上方按钮重试，或检查网络后再试。
          </p>
        </transition>

        <div class="mt-5 pt-5 border-t border-line text-[11px] text-faint leading-relaxed">
          <p class="flex items-start gap-1.5">
            <Icon name="info" :size="13" class="mt-0.5 shrink-0" />
            <span>登录由 Logto 统一托管（账号密码 / 邮箱验证码 / GitHub），权限通过角色授予；控制台不再保存任何令牌输入。</span>
          </p>
        </div>
      </div>

      <p class="text-center text-[11px] text-faint mt-6">
        Vue 3 · Vite · UnoCSS · NestJS · Logto
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import Icon from '../components/Icon.vue';

/**
 * 登录页。MCP 网关后台用 Admin Token 单凭据登录（与 MCP 通道的 API Key 隔离）。
 * Token 由后端环境变量 ADMIN_TOKEN 决定，开发默认 mgw_admin_dev_token。
 */
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const token = ref('');
const user = ref('admin');
const showToken = ref(false);
const loading = ref(false);
const error = ref('');

async function submit(): Promise<void> {
  if (loading.value) return;
  error.value = '';
  loading.value = true;
  const res = await auth.login(token.value, user.value);
  loading.value = false;
  if (res.ok) {
    const redirect = (route.query.redirect as string) || '/dashboard';
    router.replace(redirect);
  } else {
    error.value = res.error ?? '登录失败';
  }
}
</script>

<template>
  <div class="h-full w-full flex items-center justify-center p-6">
    <div class="w-full max-w-md">
      <!-- 品牌区 -->
      <div class="text-center mb-8">
        <div class="inline-flex w-16 h-16 rounded-2xl bg-white text-black items-center justify-center text-3xl font-bold mb-5 shadow-[0_8px_40px_rgba(255,255,255,0.25)]">
          M
        </div>
        <h1 class="text-2xl font-semibold text-white/90 tracking-tight">MCP 网关治理控制台</h1>
        <p class="text-sm text-white/40 mt-2">企业级 MCP 工具网关 · 权限 / 限流 / 熔断 / 审计一体化治理</p>
      </div>

      <!-- 登录卡片 -->
      <form class="glass-card p-7 backdrop-blur-2xl" @submit.prevent="submit">
        <div class="mb-5">
          <label class="label">管理员标识</label>
          <div class="relative">
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-white/30"><Icon name="users" :size="16" /></span>
            <input v-model="user" class="input pl-9" placeholder="admin" autocomplete="username" />
          </div>
          <p class="text-[11px] text-white/25 mt-1.5">仅用于变更留痕（change_logs.actor），非账号体系</p>
        </div>

        <div class="mb-5">
          <label class="label">Admin Token</label>
          <div class="relative">
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-white/30"><Icon name="key" :size="16" /></span>
            <input
              v-model="token"
              :type="showToken ? 'text' : 'password'"
              class="input pl-9 pr-10 mono"
              placeholder="mgw_admin_..."
              autocomplete="current-password"
            />
            <button
              type="button"
              class="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/70 transition-colors cursor-pointer"
              @click="showToken = !showToken"
            >
              <Icon :name="showToken ? 'eyeOff' : 'eye'" :size="16" />
            </button>
          </div>
        </div>

        <transition name="fade">
          <div v-if="error" class="flex items-center gap-2 text-red-300/90 text-xs bg-red-500/10 border border-red-400/20 rounded-lg px-3 py-2.5 mb-4">
            <Icon name="alert" :size="14" />
            <span>{{ error }}</span>
          </div>
        </transition>

        <button type="submit" class="btn-primary w-full py-2.5" :disabled="loading || !token.trim()">
          <Icon v-if="!loading" name="lock" :size="16" />
          <span v-else class="inline-block w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
          {{ loading ? '校验中…' : '登录控制台' }}
        </button>

        <div class="mt-5 pt-5 border-t border-white/8 text-[11px] text-white/30 leading-relaxed">
          <p class="flex items-start gap-1.5">
            <Icon name="info" :size="13" class="mt-0.5 shrink-0" />
            <span>开发环境默认 Token 为 <code class="mono text-white/50">mgw_admin_dev_token</code>；生产请通过环境变量 <code class="mono text-white/50">ADMIN_TOKEN</code> 配置强随机值。</span>
          </p>
        </div>
      </form>

      <p class="text-center text-[11px] text-white/20 mt-6">
        Vue 3 · Vite · UnoCSS · NestJS · SQLite &nbsp;|&nbsp; 黑白毛玻璃主题
      </p>
    </div>
  </div>
</template>

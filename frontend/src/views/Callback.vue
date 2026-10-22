<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import Icon from '../components/Icon.vue';

/**
 * OIDC 回调页：Logto 登录成功后带 code 回到 /callback。
 * 交给 SDK 校验 state + 用 code_verifier 换 token（PKCE），然后回到登录前页面。
 */
const auth = useAuthStore();
const router = useRouter();
const error = ref('');

onMounted(async () => {
  try {
    const redirect = await auth.handleCallback();
    await router.replace(redirect);
  } catch (e) {
    error.value = (e as Error).message || '登录回调处理失败';
  }
});
</script>

<template>
  <div class="h-full w-full flex items-center justify-center p-6">
    <div class="text-center">
      <template v-if="!error">
        <span class="inline-block w-8 h-8 border-2 border-line-strong border-t-white rounded-full animate-spin" />
        <p class="text-sm text-muted mt-4">正在完成登录…</p>
      </template>
      <template v-else>
        <div class="inline-flex w-12 h-12 rounded-full bg-danger-soft border border-danger-line items-center justify-center text-danger mb-4">
          <Icon name="alert" :size="20" />
        </div>
        <p class="text-sm text-danger max-w-sm">{{ error }}</p>
        <router-link to="/login" class="btn-primary inline-flex mt-6 px-5 py-2">返回登录</router-link>
      </template>
    </div>
  </div>
</template>

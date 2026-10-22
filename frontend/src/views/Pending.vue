<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import Icon from '../components/Icon.vue';

/**
 * 待开通页：账号已在 Logto 注册成功，但还没被授予网关角色。
 * 管理员刚授权后，用户点「重新检查」即可换新 token 生效，无需退出重登。
 */
const auth = useAuthStore();
const router = useRouter();

const checking = ref(false);
const tip = ref('');

async function recheck(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  tip.value = '';
  const changed = await auth.refreshPermissions();
  checking.value = false;
  if (auth.hasAccess) {
    await router.replace('/dashboard');
    return;
  }
  tip.value = changed
    ? '检测到权限有变化，但还没有网关访问权限，请联系管理员确认角色'
    : '暂未检测到新权限，请确认管理员已完成授权';
}
</script>

<template>
  <div class="h-full w-full flex items-center justify-center p-6">
    <div class="w-full max-w-md">
      <div class="glass-card p-8 text-center">
        <div
          class="inline-flex w-14 h-14 rounded-2xl bg-surface-2 border border-line items-center justify-center mb-5">
          <Icon name="shield" :size="26" class="text-fg" />
        </div>
        <h1 class="text-lg font-semibold text-fg">等待管理员开通权限</h1>
        <p class="text-sm text-muted mt-3 leading-relaxed">
          账号 <span class="text-fg">{{ auth.user }}</span> 已创建成功，但尚未分配网关角色。
          请联系管理员为你授予「只读」或「管理员」权限。
        </p>

        <transition name="fade">
          <p v-if="tip" class="text-[11px] text-warn mt-4 leading-relaxed">{{ tip }}</p>
        </transition>

        <button class="btn-primary w-full mt-6 py-2.5" :disabled="checking" @click="recheck">
          <span v-if="checking"
            class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          <Icon v-else name="refresh" :size="15" />
          {{ checking ? '检查中…' : '重新检查权限' }}
        </button>
        <button class="btn-ghost w-full mt-2 py-2.5" @click="auth.logout()">
          <Icon name="logout" :size="15" /> 退出登录
        </button>
      </div>
      <p class="text-center text-[11px] text-faint mt-6">
        管理员授权后无需退出登录，点「重新检查权限」即可
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { navItems } from '../router';
import { useAuthStore } from '../stores/auth';
import { api, type Health } from '../api';
import { fmtUptime } from '../utils/format';
import Icon from '../components/Icon.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const collapsed = ref(false);
const health = ref<Health | null>(null);
const healthOk = computed(() => health.value?.status === 'ok');
const currentTitle = computed(() => (route.meta.title as string) ?? 'MCP 网关');

let timer: number | undefined;
async function pollHealth(): Promise<void> {
  try {
    health.value = await api.system.health();
  } catch {
    health.value = null;
  }
}
onMounted(() => {
  pollHealth();
  timer = window.setInterval(pollHealth, 8000);
});
onBeforeUnmount(() => timer && clearInterval(timer));

async function refreshRegistry(): Promise<void> {
  try {
    await api.system.refreshRegistry();
    await pollHealth();
  } catch {
    /* toast 由各页处理，此处静默 */
  }
}

function logout(): void {
  auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="flex h-full w-full overflow-hidden">
    <!-- ── 侧边栏 ── -->
    <aside
      class="glass-panel shrink-0 flex flex-col transition-all duration-200 border-r border-l-0 border-y-0 border-white/8"
      :style="{ width: collapsed ? '76px' : '248px' }"
    >
      <!-- 品牌 -->
      <div class="flex items-center gap-3 h-16 px-5 border-b border-white/8 shrink-0">
        <div class="w-9 h-9 rounded-xl bg-white text-black flex items-center justify-center font-bold text-lg shrink-0 shadow-[0_2px_12px_rgba(255,255,255,0.2)]">
          M
        </div>
        <div v-show="!collapsed" class="min-w-0">
          <div class="text-sm font-semibold text-white/90 truncate leading-tight">MCP 网关</div>
          <div class="text-[11px] text-white/35 truncate">治理控制台 v2.0</div>
        </div>
      </div>

      <!-- 导航 -->
      <nav class="flex-1 overflow-y-auto scrollbar-thin px-3 py-4 space-y-1">
        <router-link
          v-for="item in navItems"
          :key="item.name"
          :to="item.path"
          custom
          v-slot="{ isActive, navigate }"
        >
          <div
            :class="isActive ? 'nav-item-active' : 'nav-item'"
            :title="collapsed ? item.title : ''"
            @click="navigate"
          >
            <span class="shrink-0" :class="isActive ? 'text-white' : 'text-white/45'">
              <Icon :name="item.icon" :size="19" />
            </span>
            <span v-show="!collapsed" class="truncate">{{ item.title }}</span>
          </div>
        </router-link>
      </nav>

      <!-- 折叠按钮 -->
      <div class="px-3 py-3 border-t border-white/8 shrink-0">
        <div class="nav-item justify-center" @click="collapsed = !collapsed">
          <Icon :name="collapsed ? 'grid' : 'list'" :size="18" />
          <span v-show="!collapsed" class="text-xs">收起侧栏</span>
        </div>
      </div>
    </aside>

    <!-- ── 主区 ── -->
    <div class="flex-1 flex flex-col min-w-0">
      <!-- 顶栏 -->
      <header class="glass-panel h-16 shrink-0 flex items-center justify-between gap-4 px-6 border-t-0 border-x-0 border-b border-white/8">
        <div class="flex items-center gap-3 min-w-0">
          <h2 class="text-base font-semibold text-white/90 truncate">{{ currentTitle }}</h2>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <!-- 健康状态 -->
          <div
            class="chip"
            :class="healthOk ? 'chip-ok' : 'chip-err'"
            :title="health ? `运行 ${fmtUptime(health.uptime_s)} · 工具 ${health.tools} · 会话 ${health.sessions}` : '网关不可达'"
          >
            <span class="w-1.5 h-1.5 rounded-full" :class="healthOk ? 'bg-emerald-400' : 'bg-red-400'" />
            {{ healthOk ? '运行中' : '不可达' }}
            <span v-if="health" class="text-white/35 font-normal">· {{ health.tools }} 工具</span>
          </div>
          <button class="btn-ghost btn-icon" title="刷新注册表" @click="refreshRegistry">
            <Icon name="refresh" :size="16" />
          </button>
          <!-- 用户 -->
          <div class="flex items-center gap-2 pl-3 border-l border-white/10">
            <div class="w-8 h-8 rounded-lg bg-white/10 border border-white/12 flex items-center justify-center text-white/80">
              <Icon name="users" :size="16" />
            </div>
            <div class="hidden sm:block leading-tight">
              <div class="text-xs text-white/80 font-medium">{{ auth.user }}</div>
              <div class="text-[10px] text-white/35">管理员</div>
            </div>
            <button class="btn-ghost btn-icon ml-1" title="退出登录" @click="logout">
              <Icon name="logout" :size="16" />
            </button>
          </div>
        </div>
      </header>

      <!-- 内容 -->
      <main class="flex-1 overflow-y-auto scrollbar-thin px-6 py-6">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

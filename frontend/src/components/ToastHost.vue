<script setup lang="ts">
import { useToast } from '../composables/useToast';
import Icon from './Icon.vue';

const toast = useToast();

const KIND_STYLE: Record<string, { cls: string; icon: string }> = {
  success: { cls: 'border-ok-line bg-ok-soft text-ok', icon: 'check' },
  error: { cls: 'border-danger-line bg-danger-soft text-danger', icon: 'alert' },
  warn: { cls: 'border-warn-line bg-warn-soft text-warn', icon: 'alert' },
  info: { cls: 'border-line-strong bg-surface-2 text-fg', icon: 'info' },
};
</script>

<template>
  <div class="fixed top-5 right-5 z-100 flex flex-col gap-2.5 pointer-events-none" style="max-width: 26rem">
    <transition-group name="toast">
      <div
        v-for="t in toast.list"
        :key="t.id"
        class="pointer-events-auto glass flex items-start gap-2.5 px-4 py-3 backdrop-blur-2xl shadow-2xl"
        :class="KIND_STYLE[t.kind].cls"
      >
        <span class="mt-0.5 shrink-0 opacity-90"><Icon :name="KIND_STYLE[t.kind].icon" :size="16" /></span>
        <p class="text-sm leading-relaxed flex-1 break-words">{{ t.message }}</p>
        <button class="shrink-0 opacity-45 hover:opacity-90 transition-opacity cursor-pointer" @click="toast.dismiss(t.id)">
          <Icon name="close" :size="14" />
        </button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-enter-active { transition: all 0.24s cubic-bezier(0.16, 1, 0.3, 1); }
.toast-leave-active { transition: all 0.18s ease; position: absolute; right: 0; }
.toast-enter-from { opacity: 0; transform: translateX(24px) scale(0.96); }
.toast-leave-to { opacity: 0; transform: translateX(24px) scale(0.96); }
</style>

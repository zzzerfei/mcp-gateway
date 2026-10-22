<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';

/**
 * 通用弹窗。v-model:open 控制显隐；ESC / 点遮罩关闭（可禁用）。
 * 内容用默认插槽，底部按钮用 #footer 插槽。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    subtitle?: string;
    width?: string;
    closable?: boolean;
    closeOnMask?: boolean;
  }>(),
  { title: '', subtitle: '', width: '34rem', closable: true, closeOnMask: true },
);
const emit = defineEmits<{ 'update:open': [boolean]; close: [] }>();

function close(): void {
  if (!props.closable) return;
  emit('update:open', false);
  emit('close');
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <teleport to="body">
    <transition name="mask">
      <div v-if="open" class="fixed inset-0 z-90 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
        <!-- 遮罩 -->
        <div class="absolute inset-0 bg-overlay backdrop-blur-sm" @click="closeOnMask && close()" />
        <!-- 面板 -->
        <div
          class="glass-card relative z-1 my-auto w-full backdrop-blur-2xl"
          :style="{ maxWidth: width }"
          role="dialog"
          aria-modal="true"
        >
          <div v-if="title" class="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-line">
            <div>
              <h3 class="text-base font-semibold text-fg">{{ title }}</h3>
              <p v-if="subtitle" class="text-xs text-muted mt-1 leading-relaxed">{{ subtitle }}</p>
            </div>
            <button v-if="closable" class="text-muted hover:text-fg transition-colors cursor-pointer shrink-0" @click="close">
              <Icon name="close" :size="18" />
            </button>
          </div>
          <div class="px-6 py-5 max-h-[70vh] overflow-y-auto scrollbar-thin">
            <slot />
          </div>
          <div v-if="$slots.footer" class="flex items-center justify-end gap-2.5 px-6 py-4 border-t border-line">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </transition>
  </teleport>
</template>

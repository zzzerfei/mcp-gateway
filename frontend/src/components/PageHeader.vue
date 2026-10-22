<script setup lang="ts">
/** 页面头部：标题 + 描述 + 右侧操作区插槽。所有管理页统一用它，保证版式一致。 */
withDefaults(defineProps<{ title: string; subtitle?: string }>(), { subtitle: '' });
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-4 mb-6">
    <div>
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="subtitle" class="text-sm text-muted mt-1.5 leading-relaxed max-w-2xl">{{ subtitle }}</p>
    </div>
    <div class="flex items-center gap-2.5">
      <slot name="actions" />
    </div>
  </div>
</template>

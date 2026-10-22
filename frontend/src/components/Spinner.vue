<script setup lang="ts">
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 22, label: '' });
</script>

<template>
  <div class="flex items-center justify-center gap-2.5 py-10 text-muted">
    <svg :width="size" :height="size" viewBox="0 0 24 24" class="mgw-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.4" fill="none" opacity="0.18" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" />
    </svg>
    <span v-if="label" class="text-sm">{{ label }}</span>
  </div>
</template>

<style scoped>
.mgw-spin { animation: mgw-rotate 0.8s linear infinite; }
@keyframes mgw-rotate { to { transform: rotate(360deg); } }
</style>

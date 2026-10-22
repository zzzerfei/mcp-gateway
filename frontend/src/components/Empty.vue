<script setup lang="ts">
import Icon from './Icon.vue';
withDefaults(defineProps<{ text?: string; icon?: string }>(), { text: '暂无数据', icon: 'box' });
</script>

<template>
  <div class="flex flex-col items-center justify-center py-16 text-center">
    <div class="w-14 h-14 rounded-2xl glass-inset flex items-center justify-center text-faint mb-4">
      <Icon :name="icon" :size="24" />
    </div>
    <p class="text-sm text-faint">{{ text }}</p>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';

/**
 * 权限包裹组件：只有具备对应 scope 时才渲染插槽内容。
 * 用组件而不是自定义指令，因为 computed 会随权限变化重新求值，
 * 管理员刚被授予角色后按钮能立刻出现。
 *
 * 注意：这里只控制"看不看得见"，真正的拦截在后端 Guard。
 */
const props = withDefaults(defineProps<{ kind?: 'write' | 'sensitive' }>(), {
  kind: 'write',
});

const auth = useAuthStore();
const allowed = computed(() =>
  props.kind === 'sensitive' ? auth.canSensitive : auth.canWrite,
);
</script>

<template>
  <slot v-if="allowed" />
</template>

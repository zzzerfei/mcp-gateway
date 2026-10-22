<script setup lang="ts">
import ToastHost from './components/ToastHost.vue';
</script>

<template>
  <!-- 背景光晕层固定在视口，内容层在其上 -->
  <div class="mgw-backdrop" />
  <div class="relative z-1 h-full">
    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </div>
  <ToastHost />
</template>

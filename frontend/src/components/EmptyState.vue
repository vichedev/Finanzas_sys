<script setup lang="ts">
import type { Component } from 'vue';

defineProps<{ icon?: Component; title: string; text?: string }>();
</script>

<template>
  <div class="empty-state">
    <div v-if="icon" class="empty-state-illustration">
      <component :is="icon" :size="36" />
    </div>
    <strong>{{ title }}</strong>
    <p v-if="text">{{ text }}</p>
    <slot />
  </div>
</template>

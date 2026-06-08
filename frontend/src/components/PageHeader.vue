<script setup lang="ts">
// Cabecera de página: título + subtítulo + acciones (slot).
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
  <header class="dash-header">
    <div class="dash-header-left">
      <h1>{{ title }}</h1>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="dash-header-right">
      <slot name="actions" />
    </div>
  </header>
</template>

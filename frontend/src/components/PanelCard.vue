<script setup lang="ts">
// Contenedor .panel con cabecera opcional (título + hint o acciones).
defineProps<{ title?: string; hint?: string }>();
</script>

<template>
  <section class="panel">
    <div v-if="title || hint || $slots.actions" class="panel-header">
      <h2 v-if="title">{{ title }}</h2>
      <slot name="actions">
        <span v-if="hint" class="panel-hint">{{ hint }}</span>
      </slot>
    </div>
    <slot />
  </section>
</template>

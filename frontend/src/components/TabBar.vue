<script setup lang="ts" generic="V extends string | number">
// Barra de pestañas reutilizable (v-model con el valor activo).
defineProps<{ tabs: { value: V; label: string }[]; modelValue: V }>();
defineEmits<{ (e: 'update:modelValue', value: V): void }>();
</script>

<template>
  <div class="tabbar" role="tablist">
    <button
      v-for="t in tabs"
      :key="String(t.value)"
      type="button"
      role="tab"
      class="tabbar-btn"
      :class="{ 'is-active': t.value === modelValue }"
      :aria-selected="t.value === modelValue"
      @click="$emit('update:modelValue', t.value)"
    >
      {{ t.label }}
    </button>
  </div>
</template>

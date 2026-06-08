<script setup lang="ts">
// Botón reutilizable que mapea a las clases globales existentes
// (primario por defecto, .ghost, .secondary, .mini, .danger).
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'ghost' | 'secondary';
    type?: 'button' | 'submit';
    disabled?: boolean;
    loading?: boolean;
    danger?: boolean;
    mini?: boolean;
  }>(),
  { variant: 'primary', type: 'button' }
);

const classes = computed(() => [
  props.variant === 'ghost' ? 'ghost' : '',
  props.variant === 'secondary' ? 'secondary' : '',
  props.mini ? 'mini' : '',
  props.danger ? 'danger' : ''
]);
</script>

<template>
  <button :type="type" :class="classes" :disabled="disabled || loading">
    <slot name="icon" />
    <slot />
  </button>
</template>

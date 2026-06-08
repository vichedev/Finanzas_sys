<script setup lang="ts">
// Campo de formulario: label + control (slot) + hint/error.
defineProps<{
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor?: string;
  narrow?: boolean;
}>();
</script>

<template>
  <div class="field" :class="{ 'field-narrow': narrow }">
    <label v-if="label" :for="htmlFor">
      {{ label }}<span v-if="required" class="required-mark">*</span>
    </label>
    <slot />
    <small v-if="error" class="error">{{ error }}</small>
    <small v-else-if="hint" class="hint">{{ hint }}</small>
  </div>
</template>

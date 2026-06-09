<script setup lang="ts" generic="V extends string | number | null">
// Selector elegante: botón que muestra la opción elegida y abre un modal
// con la lista de opciones (tarjetas seleccionables). Reemplaza a un <select>
// nativo cuando queremos una experiencia más visual e intuitiva.
import { computed, ref } from 'vue';
import { ChevronDown, Check } from 'lucide-vue-next';
import AppModal from './AppModal.vue';

interface Opt { value: V; label: string; sublabel?: string; icon?: string; meta?: string }

const props = defineProps<{
  modelValue: V;
  options: Opt[];
  title?: string;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: V): void }>();

const open = ref(false);
const selected = computed(() => props.options.find((o) => o.value === props.modelValue) || null);

function choose(o: Opt) {
  emit('update:modelValue', o.value);
  open.value = false;
}
</script>

<template>
  <button
    type="button"
    class="picker-trigger"
    :class="{ 'is-empty': !selected, 'is-disabled': disabled }"
    :disabled="disabled"
    @click="open = true"
  >
    <span class="picker-trigger-main">
      <span v-if="selected?.icon" class="picker-ic">{{ selected.icon }}</span>
      <span class="picker-text">{{ selected ? selected.label : (placeholder || 'Selecciona…') }}</span>
      <span v-if="selected?.sublabel" class="picker-sub">· {{ selected.sublabel }}</span>
    </span>
    <ChevronDown :size="16" class="picker-chevron" />
  </button>

  <AppModal :open="open" :title="title || 'Selecciona una opción'" max-width="460px" @close="open = false">
    <div class="picker-list">
      <button
        v-for="o in options"
        :key="String(o.value)"
        type="button"
        class="picker-item"
        :class="{ active: o.value === modelValue }"
        @click="choose(o)"
      >
        <span v-if="o.icon" class="picker-item-ic">{{ o.icon }}</span>
        <span class="picker-item-body">
          <span class="picker-item-label">{{ o.label }}</span>
          <span v-if="o.sublabel" class="picker-item-sub">{{ o.sublabel }}</span>
        </span>
        <span v-if="o.meta" class="picker-item-meta">{{ o.meta }}</span>
        <Check v-if="o.value === modelValue" :size="18" class="picker-check" />
      </button>
      <p v-if="!options.length" class="picker-empty">{{ emptyText || 'No hay opciones disponibles.' }}</p>
    </div>
  </AppModal>
</template>

<style scoped>
.picker-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 10px 14px;
  border: 1.5px solid var(--color-border, #e2e8f0);
  background: var(--color-surface, #fff);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
  font-size: 14px;
  color: var(--color-text, #0f172a);
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.picker-trigger:hover:not(.is-disabled) { border-color: var(--color-border-strong, #cbd5e1); background: var(--color-surface-2, #f8fafc); }
.picker-trigger:focus-visible { outline: none; border-color: var(--color-primary, #2563eb); box-shadow: var(--shadow-focus, 0 0 0 3px rgba(37,99,235,.15)); }
.picker-trigger.is-disabled { opacity: .55; cursor: not-allowed; }
.picker-trigger-main { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.picker-ic { font-size: 17px; line-height: 1; }
.picker-text { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.picker-trigger.is-empty .picker-text { font-weight: 500; color: var(--color-text-muted, #94a3b8); }
.picker-sub { color: var(--color-text-muted, #94a3b8); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.picker-chevron { color: var(--color-text-muted, #94a3b8); flex-shrink: 0; }

.picker-list { display: flex; flex-direction: column; gap: 6px; }
.picker-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: 1.5px solid var(--color-border, #e2e8f0);
  background: var(--color-surface, #fff);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  transition: border-color .12s ease, background .12s ease, transform .12s ease;
}
.picker-item:hover { border-color: var(--color-border-strong, #cbd5e1); background: var(--color-surface-2, #f8fafc); }
.picker-item.active { border-color: var(--color-primary, #2563eb); background: var(--color-primary-soft, #eff6ff); }
.picker-item-ic {
  width: 38px; height: 38px; flex-shrink: 0;
  display: grid; place-items: center;
  border-radius: 10px;
  background: var(--color-surface-3, #f1f5f9);
  font-size: 19px;
}
.picker-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.picker-item-label { font-weight: 600; color: var(--color-text, #0f172a); }
.picker-item-sub { font-size: 12px; color: var(--color-text-muted, #94a3b8); }
.picker-item-meta { font-size: 13px; font-weight: 600; color: var(--color-text-soft, #475569); }
.picker-check { color: var(--color-primary, #2563eb); flex-shrink: 0; }
.picker-empty { padding: 16px; text-align: center; color: var(--color-text-muted, #94a3b8); }
</style>

<script setup lang="ts">
// Renderiza la cola global de toasts. Se monta una vez en App.vue.
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-vue-next';
import { useToast } from '../composables/useToast';
import type { ToastType } from '../composables/useToast';

const { toasts, dismiss } = useToast();
const iconFor = (t: ToastType) => (t === 'success' ? CheckCircle2 : t === 'error' ? AlertCircle : Info);
</script>

<template>
  <Teleport to="body">
    <div class="toast-host" aria-live="polite">
      <transition-group name="toast">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type" role="status">
          <component :is="iconFor(t.type)" :size="18" class="toast-icon" />
          <span class="toast-msg">{{ t.message }}</span>
          <button type="button" class="toast-x" aria-label="Cerrar" @click="dismiss(t.id)">
            <X :size="14" />
          </button>
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

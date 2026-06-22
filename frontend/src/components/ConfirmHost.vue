<script setup lang="ts">
// Modal global de confirmación/aviso. Montar una vez en App.vue.
import AppModal from './AppModal.vue';
import { AlertTriangle, HelpCircle } from 'lucide-vue-next';
import { confirmState, resolveConfirm } from '../composables/useConfirm';
</script>

<template>
  <AppModal :open="confirmState.open" :title="confirmState.title" @close="resolveConfirm(false)">
    <div class="confirm-body">
      <span class="confirm-ic" :class="{ danger: confirmState.danger }">
        <component :is="confirmState.danger ? AlertTriangle : HelpCircle" :size="22" />
      </span>
      <p class="confirm-msg">{{ confirmState.message }}</p>
    </div>
    <template #footer>
      <button v-if="!confirmState.alert" type="button" class="ghost" @click="resolveConfirm(false)">
        {{ confirmState.cancelText }}
      </button>
      <button
        type="button"
        class="confirm-ok"
        :style="confirmState.danger ? { background: '#dc2626' } : {}"
        @click="resolveConfirm(true)"
      >
        {{ confirmState.confirmText }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.confirm-body { display: flex; gap: 12px; align-items: flex-start; }
.confirm-ic { flex: none; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; background: #eff6ff; color: #2563eb; }
.confirm-ic.danger { background: #fef2f2; color: #dc2626; }
.confirm-msg { margin: 6px 0 0; font-size: 14.5px; color: #334155; line-height: 1.5; }
</style>

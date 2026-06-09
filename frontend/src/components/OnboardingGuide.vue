<script setup lang="ts">
// Guía de primeros pasos: detecta qué falta configurar (cuentas, categorías,
// bancos, primer movimiento) y muestra un checklist con enlaces directos.
// Se oculta sola cuando todo está listo, o si el usuario la descarta.
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ArrowRight, Check, X, Sparkles } from 'lucide-vue-next';
import { http } from '../api/http';
import { useAuthStore } from '../stores/auth';

type Counts = { accounts: number; banks: number; categories: number; cards: number; wallets: number; movements: number };

const auth = useAuthStore();
const counts = ref<Counts | null>(null);
const loaded = ref(false);

const dismissKey = computed(() => `finanzas_onboarding_dismissed_${auth.tenant?.id || 'default'}`);
const dismissed = ref(localStorage.getItem(`finanzas_onboarding_dismissed_${auth.tenant?.id || 'default'}`) === '1');

type Step = { key: keyof Counts; required: boolean; icon: string; title: string; desc: string; to: string; cta: string };
const STEPS: Step[] = [
  { key: 'accounts',   required: true,  icon: '🏦', title: 'Crea tu primera cuenta', desc: 'Efectivo, banco o billetera donde tienes tu dinero.', to: '/accounts', cta: 'Crear cuenta' },
  { key: 'categories', required: true,  icon: '🏷️', title: 'Crea tus categorías', desc: 'Para clasificar ingresos y gastos en los reportes.', to: '/settings?section=categories', cta: 'Crear categorías' },
  { key: 'banks',      required: false, icon: '🏛️', title: 'Agrega tus bancos', desc: 'Necesarios para transferencias y depósitos.', to: '/settings?section=banks', cta: 'Agregar banco' },
  { key: 'movements',  required: true,  icon: '🔁', title: 'Registra tu primer movimiento', desc: 'Un ingreso o un gasto para empezar a ver tus finanzas.', to: '/movements', cta: 'Registrar' }
];

const isDone = (s: Step) => !!counts.value && counts.value[s.key] > 0;
const steps = computed(() => STEPS.map((s) => ({ ...s, done: isDone(s) })));
const pendingSteps = computed(() => steps.value.filter((s) => !s.done));
const firstPendingKey = computed(() => pendingSteps.value[0]?.key);

const requiredTotal = computed(() => STEPS.filter((s) => s.required).length);
const requiredDone = computed(() => steps.value.filter((s) => s.required && s.done).length);
const progressPct = computed(() => Math.round((requiredDone.value / requiredTotal.value) * 100));
const allReady = computed(() => !!counts.value && requiredDone.value === requiredTotal.value);

const visible = computed(() => loaded.value && !dismissed.value && !allReady.value);

function dismiss() {
  dismissed.value = true;
  localStorage.setItem(dismissKey.value, '1');
}

onMounted(async () => {
  try {
    const { data } = await http.get<Counts>('/onboarding');
    counts.value = data;
  } catch {
    // si falla, no mostramos la guía (no bloqueamos el dashboard)
  } finally {
    loaded.value = true;
  }
});
</script>

<template>
  <div v-if="visible" class="onb-card">
    <button type="button" class="onb-close" aria-label="Ocultar guía" @click="dismiss"><X :size="16" /></button>

    <div class="onb-head">
      <div class="onb-spark"><Sparkles :size="20" /></div>
      <div class="onb-head-text">
        <h2>👋 ¡Bienvenido! Empecemos en 4 pasos</h2>
        <p>Configura lo básico para sacarle provecho a tu sistema de finanzas.</p>
      </div>
    </div>

    <div class="onb-progress">
      <div class="onb-progress-bar"><div class="onb-progress-fill" :style="{ width: progressPct + '%' }"></div></div>
      <span class="onb-progress-label">{{ requiredDone }} de {{ requiredTotal }} pasos esenciales</span>
    </div>

    <ul class="onb-steps">
      <li v-for="s in steps" :key="s.key" class="onb-step" :class="{ done: s.done, current: !s.done && s.key === firstPendingKey }">
        <span class="onb-step-check" :class="{ done: s.done }">
          <Check v-if="s.done" :size="15" />
          <span v-else>{{ s.icon }}</span>
        </span>
        <div class="onb-step-body">
          <div class="onb-step-title">
            <strong>{{ s.title }}</strong>
            <span v-if="!s.required" class="onb-tag">opcional</span>
            <span v-if="!s.done && s.key === firstPendingKey" class="onb-tag start">empieza aquí</span>
          </div>
          <small>{{ s.desc }}</small>
        </div>
        <RouterLink v-if="!s.done" :to="s.to" class="onb-step-cta">
          {{ s.cta }} <ArrowRight :size="14" />
        </RouterLink>
        <span v-else class="onb-step-ok">Listo</span>
      </li>
    </ul>

    <button type="button" class="onb-skip" @click="dismiss">Omitir guía</button>
  </div>
</template>

<style scoped>
.onb-card {
  position: relative;
  background: linear-gradient(135deg, #eef2ff 0%, #f0fdfa 100%);
  border: 1px solid #c7d2fe;
  border-radius: 16px;
  padding: 20px 22px;
  margin-bottom: 1rem;
}
.onb-close {
  position: absolute; top: 12px; right: 12px;
  width: 30px; height: 30px;
  display: grid; place-items: center;
  border: 1px solid #e2e8f0; background: #fff; color: #64748b;
  border-radius: 8px; cursor: pointer;
}
.onb-close:hover { background: #f8fafc; color: #0f172a; }

.onb-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.onb-spark { width: 42px; height: 42px; flex-shrink: 0; display: grid; place-items: center; border-radius: 12px; background: #6366f1; color: #fff; }
.onb-head-text h2 { font-size: 17px; color: #0f172a; margin: 0; }
.onb-head-text p { font-size: 13px; color: #475569; margin: 2px 0 0; }

.onb-progress { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.onb-progress-bar { flex: 1; height: 8px; background: #e0e7ff; border-radius: 999px; overflow: hidden; }
.onb-progress-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #22d3ee); border-radius: 999px; transition: width .35s ease; }
.onb-progress-label { font-size: 12px; font-weight: 600; color: #4338ca; white-space: nowrap; }

.onb-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.onb-step {
  display: flex; align-items: center; gap: 12px;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
  padding: 12px 14px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.onb-step.current { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
.onb-step.done { opacity: .72; }
.onb-step-check {
  width: 34px; height: 34px; flex-shrink: 0;
  display: grid; place-items: center;
  border-radius: 9px; background: #f1f5f9; font-size: 17px;
}
.onb-step-check.done { background: #dcfce7; color: #16a34a; }
.onb-step-body { flex: 1; min-width: 0; }
.onb-step-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.onb-step-title strong { font-size: 14px; color: #0f172a; }
.onb-step.done .onb-step-title strong { text-decoration: line-through; color: #64748b; }
.onb-step-body small { font-size: 12.5px; color: #64748b; }
.onb-tag { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 999px; background: #f1f5f9; color: #64748b; }
.onb-tag.start { background: #eef2ff; color: #4338ca; }

.onb-step-cta {
  display: inline-flex; align-items: center; gap: 5px;
  flex-shrink: 0;
  padding: 8px 14px; border-radius: 9px;
  background: #4f46e5; color: #fff;
  font-size: 13px; font-weight: 600;
  transition: background .15s ease;
}
.onb-step-cta:hover { background: #4338ca; }
.onb-step-ok { flex-shrink: 0; font-size: 12.5px; font-weight: 600; color: #16a34a; }

.onb-skip { margin-top: 12px; background: transparent; border: none; color: #64748b; font-size: 12.5px; cursor: pointer; text-decoration: underline; padding: 0; }
.onb-skip:hover { color: #0f172a; }

@media (max-width: 600px) {
  .onb-step { flex-wrap: wrap; }
  .onb-step-cta { width: 100%; justify-content: center; }
}
</style>

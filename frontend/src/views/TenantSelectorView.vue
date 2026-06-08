<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore, type TenantInfo } from '../stores/auth';
import { Building2, ShieldCheck, ChevronRight } from 'lucide-vue-next';

const auth = useAuthStore();
const router = useRouter();

const loadingChoice = ref<string | null>(null);
const error = ref('');

const tenants = computed<TenantInfo[]>(() => auth.pendingTenants ?? []);
const superAvailable = computed(() => auth.pendingSuperAvailable);

onMounted(() => {
  const hasTenants = (auth.pendingTenants?.length ?? 0) > 0;
  if (!auth.pendingToken || (!hasTenants && !auth.pendingSuperAvailable)) {
    router.replace('/login');
  }
});

async function chooseTenant(t: TenantInfo) {
  if (loadingChoice.value) return;
  loadingChoice.value = t.id;
  error.value = '';
  try {
    await auth.selectOption(t.id);
    router.push('/');
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    error.value = err?.response?.data?.message || 'No se pudo seleccionar la empresa.';
  } finally {
    loadingChoice.value = null;
  }
}

async function chooseSuper() {
  if (loadingChoice.value) return;
  loadingChoice.value = 'super';
  error.value = '';
  try {
    await auth.selectOption('super');
    router.push('/settings?section=super-admin');
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    error.value = err?.response?.data?.message || 'No se pudo entrar como Super Admin.';
  } finally {
    loadingChoice.value = null;
  }
}

function cancel() {
  auth.logout();
  router.replace('/login');
}
</script>

<template>
  <section class="selector-page">
    <div class="selector-shell">
      <header class="selector-head">
        <h1>¿Cómo quieres entrar?</h1>
        <p>Tu cuenta tiene varios accesos. Elige con cuál deseas trabajar ahora.</p>
      </header>

      <p v-if="error" class="selector-error" role="alert">{{ error }}</p>

      <ul class="selector-list">
        <li v-if="superAvailable">
          <button
            type="button"
            class="tenant-card super"
            :class="{ 'is-loading': loadingChoice === 'super' }"
            :disabled="!!loadingChoice"
            @click="chooseSuper"
          >
            <span class="card-icon">
              <ShieldCheck :size="26" />
            </span>
            <span class="card-body">
              <span class="card-title">Super Admin</span>
              <span class="card-sub">Gestionar empresas y accesos</span>
            </span>
            <span class="card-arrow">
              <span v-if="loadingChoice === 'super'" class="spinner" aria-hidden="true"></span>
              <ChevronRight v-else :size="20" />
            </span>
          </button>
        </li>

        <li v-for="t in tenants" :key="t.id">
          <button
            type="button"
            class="tenant-card"
            :class="{ 'is-loading': loadingChoice === t.id }"
            :disabled="!!loadingChoice"
            @click="chooseTenant(t)"
          >
            <span class="card-icon">
              <img v-if="t.logoUrl" :src="t.logoUrl" :alt="t.legalName" />
              <Building2 v-else :size="26" />
            </span>
            <span class="card-body">
              <span class="card-title">{{ t.legalName }}</span>
              <span class="card-sub">Empresa · {{ t.slug }}</span>
            </span>
            <span class="card-arrow">
              <span v-if="loadingChoice === t.id" class="spinner" aria-hidden="true"></span>
              <ChevronRight v-else :size="20" />
            </span>
          </button>
        </li>
      </ul>

      <footer class="selector-foot">
        <button type="button" class="link-btn" @click="cancel">Cancelar y volver al inicio de sesión</button>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.selector-page {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6, 24px) var(--space-4, 16px);
  background:
    radial-gradient(1200px 600px at 0% -10%, rgba(79, 140, 255, 0.08), transparent 60%),
    radial-gradient(900px 500px at 100% 110%, rgba(34, 197, 94, 0.07), transparent 60%),
    var(--color-bg, #0e1117);
}
.selector-shell {
  width: 100%;
  max-width: 520px;
  background: var(--color-surface, #161a23);
  border: 1px solid var(--color-border, #2a2f3a);
  border-radius: 18px;
  padding: 28px;
  box-shadow: 0 24px 60px -28px rgba(0, 0, 0, 0.5);
}
.selector-head h1 {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--color-text, #e7ebf3);
}
.selector-head p {
  margin: 0 0 20px;
  color: var(--color-text-muted, #8b94a7);
  font-size: 14px;
  line-height: 1.5;
}
.selector-error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #fca5a5;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  margin: 0 0 14px;
}
.selector-list {
  list-style: none;
  padding: 0;
  margin: 0 0 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tenant-card {
  width: 100%;
  display: grid;
  grid-template-columns: 44px 1fr 24px;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid var(--color-border, #2a2f3a);
  background: var(--color-surface-2, #1b1f2a);
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
  transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
}
.tenant-card:hover:not(:disabled) {
  border-color: var(--color-primary, #4f8cff);
  background: var(--color-surface-3, #232838);
  transform: translateY(-1px);
}
.tenant-card:focus-visible {
  outline: 2px solid var(--color-primary, #4f8cff);
  outline-offset: 2px;
}
.tenant-card:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.tenant-card.super {
  border-color: rgba(245, 158, 11, 0.4);
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.08), var(--color-surface-2, #1b1f2a));
}
.tenant-card.super:hover:not(:disabled) {
  border-color: #f59e0b;
  background: linear-gradient(180deg, rgba(245, 158, 11, 0.14), var(--color-surface-3, #232838));
}
.tenant-card.super .card-icon {
  background: rgba(245, 158, 11, 0.16);
  color: #f59e0b;
}

.card-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-surface-3, #232838);
  color: var(--color-text, #e7ebf3);
  overflow: hidden;
  flex-shrink: 0;
}
.card-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text, #e7ebf3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-sub {
  font-size: 12.5px;
  color: var(--color-text-muted, #8b94a7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted, #8b94a7);
}
.tenant-card:hover:not(:disabled) .card-arrow { color: var(--color-text, #e7ebf3); }
.tenant-card.super:hover:not(:disabled) .card-arrow { color: #f59e0b; }

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.selector-foot {
  text-align: center;
  border-top: 1px solid var(--color-border, #2a2f3a);
  padding-top: 16px;
}
.link-btn {
  background: transparent;
  border: 0;
  padding: 0;
  font: inherit;
  font-size: 13px;
  color: var(--color-text-muted, #8b94a7);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.link-btn:hover { color: var(--color-text, #e7ebf3); }

@media (max-width: 480px) {
  .selector-shell { padding: 22px 18px; border-radius: 14px; }
  .selector-head h1 { font-size: 19px; }
  .tenant-card { padding: 12px 12px; gap: 10px; grid-template-columns: 40px 1fr 20px; }
  .card-icon { width: 40px; height: 40px; }
}
</style>

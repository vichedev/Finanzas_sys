<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { Mail, Lock, Eye, EyeOff, ShieldCheck, LogIn, BarChart3 } from 'lucide-vue-next';

const auth = useAuthStore();
const router = useRouter();

const email = ref('');
const password = ref('');
const showPassword = ref(false);
const remember = ref(true);
const forgot = ref(false);
const error = ref('');
const loading = ref(false);

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    const result = await auth.login(email.value, password.value);
    if (result?.needsSelection) {
      router.push('/select-tenant');
    } else if (auth.isSuper) {
      router.push('/settings?section=super-admin');
    } else {
      router.push('/');
    }
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: { message?: string } } };
    const status = err?.response?.status;
    if (status === 403) {
      error.value = err?.response?.data?.message || 'Cuenta desactivada.';
    } else if (status === 400 || status === 401) {
      error.value = 'Credenciales inválidas';
    } else {
      error.value = err?.response?.data?.message || 'No se pudo iniciar sesión';
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth">
    <!-- ===================== Splash de intro ===================== -->
    <div class="splash" aria-hidden="true">
      <div class="splash-logo">
        <span class="sl-mark"><BarChart3 :size="36" :stroke-width="2.4" /></span>
        <span class="sl-name">Finanxi</span>
        <span class="sl-sub">Sistema de Finanzas</span>
      </div>
    </div>

    <!-- ===================== Login ===================== -->
    <div class="auth-inner">
      <!-- Panel hero (foto ciudad) -->
      <aside class="hero">
        <div class="hero-overlay"></div>
        <div class="hero-content">
          <div class="hero-logo"><BarChart3 :size="26" :stroke-width="2.4" /></div>
          <h1>Tu dinero,<br /><span>tu futuro.</span></h1>
          <p>Administra tus finanzas, controla tus gastos y toma decisiones inteligentes para crecer cada día.</p>
          <span class="hero-accent"></span>
        </div>

        <div class="hero-trust">
          <span class="ht-icon"><ShieldCheck :size="18" /></span>
          <span>Seguro, confiable y siempre pensado para ti.</span>
        </div>
      </aside>

      <!-- Panel formulario -->
      <section class="form-card">
        <div class="brand">
          <span class="brand-mark"><BarChart3 :size="26" :stroke-width="2.4" /></span>
          <div class="brand-text">
            <strong>Finanxi</strong>
            <small>Sistema de Finanzas</small>
          </div>
        </div>

        <h2 class="form-title">Bienvenido de vuelta</h2>
        <p class="form-sub">Ingresa tus credenciales para continuar</p>

        <form class="auth-form" @submit.prevent="submit" novalidate>
          <div class="field">
            <label for="login-email">Correo electrónico</label>
            <div class="input-icon">
              <Mail :size="18" class="ii-lead" />
              <input id="login-email" v-model="email" type="email" autocomplete="email" placeholder="tu@correo.com" required />
            </div>
          </div>

          <div class="field">
            <label for="login-password">Contraseña</label>
            <div class="input-icon">
              <Lock :size="18" class="ii-lead" />
              <input
                id="login-password"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="••••••••"
                required
              />
              <button type="button" class="ii-toggle" :aria-label="showPassword ? 'Ocultar' : 'Ver'" @click="showPassword = !showPassword">
                <EyeOff v-if="showPassword" :size="18" />
                <Eye v-else :size="18" />
              </button>
            </div>
          </div>

          <div class="row-between">
            <label class="remember">
              <input type="checkbox" v-model="remember" />
              <span>Recordarme</span>
            </label>
            <a href="#" class="forgot" @click.prevent="forgot = true">¿Olvidaste tu contraseña?</a>
          </div>

          <p v-if="forgot" class="forgot-msg">Pide a tu administrador que restablezca tu contraseña.</p>
          <p v-if="error" class="login-error">{{ error }}</p>

          <button :disabled="loading" class="login-btn">
            <LogIn :size="18" />
            <span>{{ loading ? 'Ingresando…' : 'Iniciar sesión' }}</span>
          </button>
        </form>

        <p class="copy">© 2026 Finanxi. Todos los derechos reservados.</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.auth { position: relative; min-height: 100vh; background: #eef2f7; }

/* ===================== Splash ===================== */
.splash {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: linear-gradient(150deg, #0b1226 0%, #15307a 55%, #0e7490 120%);
  animation: splash-out 1.9s ease forwards;
}
@keyframes splash-out {
  0%, 52% { opacity: 1; }
  100% { opacity: 0; visibility: hidden; }
}
.splash-logo { display: flex; flex-direction: column; align-items: center; gap: 10px; color: white; }
.sl-mark {
  width: 76px; height: 76px;
  border-radius: 22px;
  display: grid; place-items: center;
  background: rgba(255,255,255,0.14);
  border: 1px solid rgba(255,255,255,0.28);
  box-shadow: 0 16px 40px -12px rgba(0,0,0,0.5);
  color: #60a5fa;
  animation: pop 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) both, glow 2s ease-in-out infinite 0.6s;
}
.sl-name { font-size: 30px; font-weight: 800; letter-spacing: -0.02em; animation: rise 0.6s 0.28s both; }
.sl-sub { font-size: 13px; color: rgba(255,255,255,0.7); letter-spacing: 0.06em; animation: rise 0.6s 0.42s both; }
@keyframes pop { from { opacity: 0; transform: scale(0.5) rotate(-8deg); } to { opacity: 1; transform: scale(1) rotate(0); } }
@keyframes glow { 0%,100% { box-shadow: 0 16px 40px -12px rgba(0,0,0,0.5); } 50% { box-shadow: 0 0 0 8px rgba(96,165,250,0.14), 0 16px 40px -12px rgba(0,0,0,0.5); } }

/* ===================== Layout (hero + tarjeta superpuesta) ===================== */
.auth-inner {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 36px;
  max-width: 1160px;
  margin: 0 auto;
  animation: reveal 0.8s ease 1.45s both;
}
@keyframes reveal { from { opacity: 0; transform: translateY(12px) scale(0.99); } to { opacity: 1; transform: none; } }

/* ===================== Hero (foto) ===================== */
.hero {
  position: relative;
  flex: 1 1 54%;
  min-height: 640px;
  overflow: hidden;
  border-radius: 30px;
  padding: 54px 110px 54px 52px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  color: white;
  /* Capas: foto (con fallback a un degradado dusk si no carga). */
  background-image:
    url('https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?auto=format&fit=crop&w=1400&q=80'),
    linear-gradient(160deg, #0a1024 0%, #122a63 55%, #0c4a6e 100%);
  background-size: cover, cover;
  background-position: center, center;
  box-shadow: 0 34px 70px -28px rgba(13, 28, 64, 0.6);
}
/* Velo azul para legibilidad y tono nocturno. */
.hero-overlay {
  position: absolute; inset: 0;
  background:
    linear-gradient(180deg, rgba(10,18,45,0.45) 0%, rgba(9,24,66,0.62) 55%, rgba(8,30,80,0.78) 100%),
    radial-gradient(120% 70% at 78% 8%, rgba(56,189,248,0.22), transparent 60%);
}

.hero-content { position: relative; z-index: 1; }
.hero-logo {
  width: 58px; height: 58px;
  border-radius: 16px;
  display: grid; place-items: center;
  background: rgba(37,99,235,0.30);
  border: 1px solid rgba(255,255,255,0.28);
  color: #bfdbfe;
  margin-bottom: 30px;
  backdrop-filter: blur(4px);
  animation: rise 0.6s 1.6s both;
}
.hero h1 {
  font-size: 48px; font-weight: 800; line-height: 1.05; letter-spacing: -0.03em;
  text-shadow: 0 2px 18px rgba(0,0,0,0.25);
  animation: rise 0.6s 1.7s both;
}
.hero h1 span { color: #60a5fa; }
.hero p {
  margin-top: 18px; max-width: 360px;
  color: rgba(255,255,255,0.9); font-size: 16px; line-height: 1.6;
  text-shadow: 0 1px 10px rgba(0,0,0,0.3);
  animation: rise 0.6s 1.82s both;
}
.hero-accent {
  display: block; width: 56px; height: 5px; margin-top: 26px;
  border-radius: 999px;
  background: #2563eb;
  animation: rise 0.6s 1.95s both;
}

.hero-trust {
  position: relative; z-index: 1;
  margin-top: auto;
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px;
  background: rgba(15,23,42,0.42);
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 16px;
  backdrop-filter: blur(10px);
  font-size: 14px; color: rgba(255,255,255,0.95);
  max-width: 330px;
  animation: rise 0.6s 2.05s both, floaty 6s ease-in-out infinite 2.6s;
}
.ht-icon {
  width: 38px; height: 38px; flex-shrink: 0;
  border-radius: 11px;
  display: grid; place-items: center;
  background: linear-gradient(135deg, #2563eb, #1d4ed8);
  color: white;
}
@keyframes floaty { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }

/* ===================== Formulario (superpuesto) ===================== */
.form-card {
  position: relative;
  z-index: 2;
  flex: 1 1 46%;
  margin-left: -64px;
  min-height: 600px;
  background: var(--color-surface);
  border-radius: 28px;
  box-shadow: 0 34px 70px -26px rgba(13, 28, 64, 0.32);
  padding: 52px 56px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.brand { display: flex; align-items: center; gap: 13px; justify-content: center; margin-bottom: 28px; animation: rise 0.6s 1.6s both; }
.brand-mark {
  width: 50px; height: 50px;
  border-radius: 14px;
  display: grid; place-items: center;
  background: var(--color-primary-soft);
  border: 1px solid #bfdbfe;
  color: var(--color-primary);
}
.brand-text strong { display: block; font-size: 23px; font-weight: 800; color: var(--color-text); letter-spacing: -0.01em; line-height: 1.1; }
.brand-text small { color: var(--color-text-muted); font-size: 12.5px; }

.form-title { text-align: center; font-size: 27px; font-weight: 700; color: var(--color-text); letter-spacing: -0.02em; animation: rise 0.6s 1.7s both; }
.form-sub { text-align: center; margin-top: 6px; color: var(--color-text-muted); font-size: var(--text-md); animation: rise 0.6s 1.78s both; }

.auth-form { margin-top: 26px; display: grid; gap: var(--space-4); animation: rise 0.6s 1.86s both; }
.auth-form .field { margin-bottom: 0; }

.input-icon { position: relative; display: flex; align-items: center; }
.input-icon .ii-lead { position: absolute; left: 14px; color: var(--color-text-subtle); pointer-events: none; }
.input-icon input { padding-left: 42px; padding-right: 42px; height: 48px; }
.ii-toggle {
  position: absolute; right: 8px;
  background: transparent; border: none; cursor: pointer;
  color: var(--color-text-muted);
  padding: 8px; border-radius: var(--radius-md);
  display: inline-flex; align-items: center; justify-content: center;
}
.ii-toggle:hover { color: var(--color-text); background: var(--color-surface-3); }

.row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.remember { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: var(--text-sm); color: var(--color-text-soft); margin: 0; font-weight: 500; }
.remember input[type="checkbox"] {
  width: 17px; height: 17px; min-width: 17px;
  accent-color: var(--color-primary);
  cursor: pointer;
}
.forgot { font-size: var(--text-sm); color: var(--color-primary); font-weight: 600; cursor: pointer; }
.forgot:hover { color: var(--color-primary-hover); text-decoration: underline; }
.forgot-msg { margin: 0; font-size: var(--text-xs); color: var(--color-text-muted); background: var(--color-surface-2); border: 1px solid var(--color-border-soft); border-radius: var(--radius-md); padding: 8px 12px; }

.login-error {
  margin: 0;
  color: var(--color-danger-text);
  background: var(--color-danger-soft);
  border: 1px solid #fecaca;
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: var(--text-sm); font-weight: 500;
}

.login-btn {
  margin-top: 4px;
  height: 50px; width: 100%;
  border: none;
  border-radius: var(--radius-lg);
  background: var(--color-primary);
  color: white;
  font-size: var(--text-md); font-weight: 700;
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  box-shadow: 0 12px 24px -10px rgba(37, 99, 235, 0.7);
  transition: transform var(--t-fast), box-shadow var(--t-fast), background var(--t-fast);
}
.login-btn:hover:not(:disabled) { background: var(--color-primary-hover); transform: translateY(-1px); box-shadow: 0 16px 30px -10px rgba(37, 99, 235, 0.75); }
.login-btn:active:not(:disabled) { transform: translateY(0); background: var(--color-primary-active); }
.login-btn:disabled { opacity: 0.65; cursor: not-allowed; }

.copy { text-align: center; margin-top: 26px; font-size: var(--text-xs); color: var(--color-text-subtle); animation: rise 0.6s 2s both; }

@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }

/* ===================== Responsive ===================== */
@media (max-width: 920px) {
  .auth-inner { flex-direction: column; max-width: 480px; padding: 20px; }
  .hero { flex: none; width: 100%; min-height: 280px; padding: 32px 30px; border-radius: 24px; }
  .hero h1 { font-size: 34px; }
  .hero p { font-size: 14.5px; }
  .form-card { flex: none; width: 100%; margin-left: 0; margin-top: -40px; min-height: 0; padding: 40px 28px; border-radius: 24px; }
}
@media (max-width: 480px) {
  .hero { display: none; }
  .form-card { margin-top: 0; padding: 32px 22px; }
}

@media (prefers-reduced-motion: reduce) {
  .splash { animation-duration: 0.6s; }
  .auth-inner, .sl-mark, .sl-name, .sl-sub, .hero-logo, .hero h1, .hero p, .hero-accent, .hero-trust,
  .brand, .form-title, .form-sub, .auth-form, .copy { animation: none !important; }
}
</style>

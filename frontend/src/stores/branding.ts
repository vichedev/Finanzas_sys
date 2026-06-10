// =====================================================
// Identidad/branding de la empresa: título, subtítulo, colores y logo.
// Aplica los colores como variables CSS en :root y actualiza el título del
// documento. Se carga tras autenticarse y al guardar cambios.
// =====================================================
import { defineStore } from 'pinia';
import { brandingApi, type BrandingConfig, type BrandingPayload } from '../api/branding';

// ---- helpers de color ----
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function darken(hex: string, amt: number): string {
  const rgb = hexToRgb(hex); if (!rgb) return hex;
  return rgbToHex(rgb[0] * (1 - amt), rgb[1] * (1 - amt), rgb[2] * (1 - amt));
}
/** Mezcla con blanco: t=0 → color, t=1 → blanco. */
function mixWhite(hex: string, t: number): string {
  const rgb = hexToRgb(hex); if (!rgb) return hex;
  return rgbToHex(rgb[0] + (255 - rgb[0]) * t, rgb[1] + (255 - rgb[1]) * t, rgb[2] + (255 - rgb[2]) * t);
}

const PRIMARY_VARS = ['--color-primary', '--color-primary-hover', '--color-primary-active', '--color-primary-soft', '--color-primary-text'];
const ACCENT_VARS = ['--color-accent', '--color-accent-hover', '--color-accent-soft', '--color-accent-text'];

interface State {
  systemTitle: string | null;
  subtitle: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  hasLogo: boolean;
  logoUrl: string | null;
  loaded: boolean;
}

export const useBrandingStore = defineStore('branding', {
  state: (): State => ({
    systemTitle: null, subtitle: null, primaryColor: null, accentColor: null,
    hasLogo: false, logoUrl: null, loaded: false
  }),
  getters: {
    title: (s): string => s.systemTitle || 'Finanzas Mensuales',
    subtitleText: (s): string => s.subtitle || 'Finanzas mensuales'
  },
  actions: {
    applyColors() {
      if (typeof document === 'undefined') return;
      const root = document.documentElement;
      if (this.primaryColor && hexToRgb(this.primaryColor)) {
        const c = this.primaryColor;
        root.style.setProperty('--color-primary', c);
        root.style.setProperty('--color-primary-hover', darken(c, 0.1));
        root.style.setProperty('--color-primary-active', darken(c, 0.2));
        root.style.setProperty('--color-primary-soft', mixWhite(c, 0.9));
        root.style.setProperty('--color-primary-text', darken(c, 0.12));
      } else {
        PRIMARY_VARS.forEach((v) => root.style.removeProperty(v));
      }
      if (this.accentColor && hexToRgb(this.accentColor)) {
        const c = this.accentColor;
        root.style.setProperty('--color-accent', c);
        root.style.setProperty('--color-accent-hover', darken(c, 0.1));
        root.style.setProperty('--color-accent-soft', mixWhite(c, 0.9));
        root.style.setProperty('--color-accent-text', darken(c, 0.2));
      } else {
        ACCENT_VARS.forEach((v) => root.style.removeProperty(v));
      }
      if (typeof document !== 'undefined') document.title = this.title;
    },

    async loadLogo() {
      if (this.logoUrl) { URL.revokeObjectURL(this.logoUrl); this.logoUrl = null; }
      if (!this.hasLogo) return;
      try {
        const blob = await brandingApi.logoBlob();
        this.logoUrl = URL.createObjectURL(blob);
      } catch { this.logoUrl = null; }
    },

    setConfig(cfg: BrandingConfig) {
      this.systemTitle = cfg.systemTitle;
      this.subtitle = cfg.subtitle;
      this.primaryColor = cfg.primaryColor;
      this.accentColor = cfg.accentColor;
      this.hasLogo = cfg.hasLogo;
    },

    async load() {
      try {
        const cfg = await brandingApi.get();
        this.setConfig(cfg);
        this.applyColors();
        await this.loadLogo();
      } catch { /* sin branding: se usan los valores por defecto */ }
      finally { this.loaded = true; }
    },

    async save(payload: BrandingPayload) {
      const cfg = await brandingApi.save(payload);
      this.setConfig(cfg);
      this.applyColors();
    },

    async uploadLogo(mimeType: string, dataBase64: string) {
      await brandingApi.uploadLogo(mimeType, dataBase64);
      this.hasLogo = true;
      await this.loadLogo();
    },

    async removeLogo() {
      await brandingApi.removeLogo();
      this.hasLogo = false;
      await this.loadLogo();
    },

    /** Limpia el branding aplicado (al cerrar sesión). */
    clear() {
      if (this.logoUrl) { URL.revokeObjectURL(this.logoUrl); }
      this.$reset();
      this.applyColors();
    }
  }
});

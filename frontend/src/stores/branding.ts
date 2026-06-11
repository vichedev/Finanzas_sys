// =====================================================
// Identidad/branding de la empresa: título, subtítulo, colores y logo.
// Aplica los colores como variables CSS en :root y actualiza el título del
// documento. Persiste un snapshot en localStorage para mostrar la identidad
// de la última empresa usada en la pantalla de login (que es multi-empresa).
// =====================================================
import { defineStore } from 'pinia';
import { brandingApi, type BrandingConfig, type BrandingPayload } from '../api/branding';

const STORAGE_KEY = 'finanzas_branding';
const MAX_PERSIST_LOGO = 1_400_000; // ~1 MB de dataURL; logos más grandes no se guardan para login

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
function mixWhite(hex: string, t: number): string {
  const rgb = hexToRgb(hex); if (!rgb) return hex;
  return rgbToHex(rgb[0] + (255 - rgb[0]) * t, rgb[1] + (255 - rgb[1]) * t, rgb[2] + (255 - rgb[2]) * t);
}
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

const PRIMARY_VARS = ['--color-primary', '--color-primary-hover', '--color-primary-active', '--color-primary-soft', '--color-primary-text'];
const ACCENT_VARS = ['--color-accent', '--color-accent-hover', '--color-accent-soft', '--color-accent-text'];

// Favicon por defecto (se captura del index.html la primera vez).
let defaultFavicon: string | null = null;
function setFavicon(href: string | null) {
  if (typeof document === 'undefined') return;
  let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement | null;
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  if (defaultFavicon === null) defaultFavicon = link.getAttribute('href') || '/favicon.svg';
  if (href) {
    link.removeAttribute('type'); // dataURL: el navegador infiere el formato
    link.setAttribute('href', href);
  } else {
    link.setAttribute('type', 'image/svg+xml');
    link.setAttribute('href', defaultFavicon);
  }
}

interface State {
  systemTitle: string | null;
  subtitle: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  hasLogo: boolean;
  logoUrl: string | null; // dataURL (sirve para mostrar y persistir)
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
      document.title = this.systemTitle || 'Finanzas Mensuales';
      setFavicon(this.logoUrl);
    },

    persist() {
      try {
        const snap = {
          systemTitle: this.systemTitle,
          subtitle: this.subtitle,
          primaryColor: this.primaryColor,
          accentColor: this.accentColor,
          logo: this.logoUrl && this.logoUrl.length <= MAX_PERSIST_LOGO ? this.logoUrl : null
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
      } catch { /* cuota llena: ignoramos */ }
    },

    /** Aplica la identidad guardada (para el login, antes de autenticarse). */
    loadPersisted() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          this.systemTitle = s.systemTitle ?? null;
          this.subtitle = s.subtitle ?? null;
          this.primaryColor = s.primaryColor ?? null;
          this.accentColor = s.accentColor ?? null;
          this.logoUrl = s.logo ?? null;
          this.hasLogo = !!s.logo;
        }
      } catch { /* ignore */ }
      this.applyColors();
      this.loaded = true;
    },

    setConfig(cfg: BrandingConfig) {
      this.systemTitle = cfg.systemTitle;
      this.subtitle = cfg.subtitle;
      this.primaryColor = cfg.primaryColor;
      this.accentColor = cfg.accentColor;
      this.hasLogo = cfg.hasLogo;
    },

    async loadLogo() {
      if (!this.hasLogo) { this.logoUrl = null; setFavicon(null); return; }
      try {
        const blob = await brandingApi.logoBlob();
        this.logoUrl = await blobToDataUrl(blob);
      } catch { this.logoUrl = null; }
      setFavicon(this.logoUrl);
    },

    async load() {
      try {
        const cfg = await brandingApi.get();
        this.setConfig(cfg);
        this.applyColors();
        await this.loadLogo();
        this.persist();
      } catch { /* sin branding: valores por defecto */ }
      finally { this.loaded = true; }
    },

    async save(payload: BrandingPayload) {
      const cfg = await brandingApi.save(payload);
      this.setConfig(cfg);
      this.applyColors();
      this.persist();
    },

    async uploadLogo(mimeType: string, dataBase64: string) {
      await brandingApi.uploadLogo(mimeType, dataBase64);
      this.hasLogo = true;
      await this.loadLogo();
      this.persist();
    },

    async removeLogo() {
      await brandingApi.removeLogo();
      this.hasLogo = false;
      this.logoUrl = null;
      this.persist();
      setFavicon(null);
    },

    /** Vuelve al look por defecto en memoria (ej. super-admin). No borra el snapshot. */
    reset() {
      this.systemTitle = null; this.subtitle = null;
      this.primaryColor = null; this.accentColor = null;
      this.hasLogo = false; this.logoUrl = null;
      this.applyColors();
    }
  }
});

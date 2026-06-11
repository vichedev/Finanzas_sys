<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { User, Tags, Landmark, Smartphone, ShieldCheck, Users, Mail, Pencil, Trash2, Plus, X, Building2, Pause, Play, Key, Copy, Check, Archive, Download, Upload, Palette } from 'lucide-vue-next';
import { useAuthStore } from '../stores/auth';
import { useBrandingStore } from '../stores/branding';
import { useEntitiesStore } from '../stores/entities';
import { http } from '../api/http';
import { backupApi } from '../api/backup';
import AdminUsersPanel from './AdminUsersPanel.vue';
import RolesPanel from './RolesPanel.vue';

type Category = { id: number; name: string; type: 'INCOME' | 'EXPENSE'; color?: string | null; icon?: string | null };
type BankAccountKind = 'SAVINGS' | 'CHECKING';
type Bank = { id: number; name: string; accountNumber?: string | null; accountKind?: BankAccountKind | null; isActive: boolean; notes?: string | null };
type Wallet = { id: number; name: string; provider?: string | null; identifier?: string | null; isActive: boolean; notes?: string | null };
const BANK_KIND_LABEL: Record<BankAccountKind, string> = { SAVINGS: 'Ahorros', CHECKING: 'Corriente' };
type FilterType = 'ALL' | 'INCOME' | 'EXPENSE';
type Profile = { id?: number; name?: string; email?: string; currency?: string; role?: string; createdAt?: string };

type SmtpPublic = { host: string; port: number; user: string; hasPass: boolean; secure: boolean; from: string; publicUrl: string };

const auth = useAuthStore();
const entities = useEntitiesStore();
const categories = ref<Category[]>([]);
const filter = ref<FilterType>('ALL');
const emptyCategoryForm = () => ({ name: '', type: 'EXPENSE' as 'INCOME' | 'EXPENSE', icon: '' });

const ICON_GROUPS: { name: string; icons: { value: string; label: string }[] }[] = [
  {
    name: 'Dinero y finanzas',
    icons: [
      { value: '💵', label: 'Dinero' }, { value: '💰', label: 'Sueldo' }, { value: '💳', label: 'Tarjeta' },
      { value: '🏦', label: 'Banco' }, { value: '🏧', label: 'Cajero' }, { value: '📈', label: 'Ingresos' },
      { value: '📊', label: 'Inversiones' }, { value: '💹', label: 'Bolsa' }, { value: '🪙', label: 'Monedas' },
      { value: '💴', label: 'Yen' }, { value: '💶', label: 'Euro' }, { value: '💷', label: 'Libra' }
    ]
  },
  {
    name: 'Compras',
    icons: [
      { value: '🛒', label: 'Compras' }, { value: '🛍️', label: 'Tienda' }, { value: '🏪', label: 'Minimarket' },
      { value: '🏬', label: 'Centro comercial' }, { value: '🧾', label: 'Factura' }
    ]
  },
  {
    name: 'Comida y bebida',
    icons: [
      { value: '🍽️', label: 'Comida' }, { value: '🍔', label: 'Restaurante' }, { value: '🍕', label: 'Pizza' },
      { value: '☕', label: 'Café' }, { value: '🥗', label: 'Saludable' }, { value: '🍺', label: 'Bebidas' },
      { value: '🧉', label: 'Mate / té' }, { value: '🥖', label: 'Panadería' }, { value: '🎂', label: 'Pastelería' }
    ]
  },
  {
    name: 'Transporte',
    icons: [
      { value: '⛽', label: 'Combustible' }, { value: '🚗', label: 'Auto' }, { value: '🚙', label: 'SUV' },
      { value: '🛻', label: 'Camioneta' }, { value: '🚕', label: 'Taxi' }, { value: '🚌', label: 'Bus' },
      { value: '🛵', label: 'Moto' }, { value: '🚲', label: 'Bici' }, { value: '✈️', label: 'Viajes' },
      { value: '🚇', label: 'Metro' }, { value: '🚆', label: 'Tren' }, { value: '🛴', label: 'Patineta' }
    ]
  },
  {
    name: 'Vivienda y servicios',
    icons: [
      { value: '🏠', label: 'Vivienda' }, { value: '🏡', label: 'Casa propia' }, { value: '🏘️', label: 'Arriendo' },
      { value: '💡', label: 'Luz' }, { value: '💧', label: 'Agua' }, { value: '🔥', label: 'Gas' },
      { value: '🧹', label: 'Limpieza' }, { value: '🛏️', label: 'Hogar' }, { value: '🪑', label: 'Muebles' }
    ]
  },
  {
    name: 'Telecomunicaciones',
    icons: [
      { value: '📱', label: 'Teléfono' }, { value: '📞', label: 'Llamada' }, { value: '☎️', label: 'Fijo' },
      { value: '📡', label: 'Antena' }, { value: '🛰️', label: 'Satélite' }, { value: '📶', label: 'Señal' },
      { value: '🌐', label: 'Internet' }, { value: '📺', label: 'TV / Cable' }, { value: '📻', label: 'Radio' },
      { value: '📨', label: 'Email' }, { value: '💬', label: 'Mensajería' }
    ]
  },
  {
    name: 'Tecnología',
    icons: [
      { value: '💻', label: 'Computadora' }, { value: '🖥️', label: 'Escritorio' }, { value: '⌨️', label: 'Teclado' },
      { value: '🖱️', label: 'Mouse' }, { value: '🖨️', label: 'Impresora' }, { value: '📷', label: 'Cámara' },
      { value: '🎧', label: 'Audífonos' }, { value: '🔌', label: 'Electrónica' }, { value: '🔋', label: 'Energía' },
      { value: '☁️', label: 'Cloud / suscripción' }
    ]
  },
  {
    name: 'Trabajo y oficina',
    icons: [
      { value: '💼', label: 'Trabajo' }, { value: '🏢', label: 'Oficina' }, { value: '👔', label: 'Profesional' },
      { value: '📋', label: 'Tareas' }, { value: '📁', label: 'Archivos' }, { value: '📎', label: 'Documentos' },
      { value: '✏️', label: 'Notas' }, { value: '🖊️', label: 'Pluma' }, { value: '📅', label: 'Agenda' },
      { value: '📆', label: 'Calendario' }, { value: '⏰', label: 'Hora extra' }, { value: '🗂️', label: 'Carpetas' },
      { value: '🧑‍💼', label: 'Empleado' }, { value: '🤝', label: 'Negocios' }, { value: '🪪', label: 'Identificación' }
    ]
  },
  {
    name: 'Educación',
    icons: [
      { value: '📚', label: 'Educación' }, { value: '🎓', label: 'Estudios' }, { value: '🏫', label: 'Colegio' },
      { value: '📝', label: 'Materiales' }, { value: '🧮', label: 'Cursos' }
    ]
  },
  {
    name: 'Ropa y cuidado personal',
    icons: [
      { value: '👕', label: 'Ropa' }, { value: '👗', label: 'Ropa formal' }, { value: '👟', label: 'Calzado' },
      { value: '👠', label: 'Zapatos' }, { value: '💄', label: 'Cosméticos' }, { value: '🧴', label: 'Cuidado' },
      { value: '✂️', label: 'Peluquería' }, { value: '🛁', label: 'Spa' }
    ]
  },
  {
    name: 'Salud y bienestar',
    icons: [
      { value: '💊', label: 'Salud' }, { value: '🏥', label: 'Médico' }, { value: '🩺', label: 'Consulta' },
      { value: '💉', label: 'Vacunas' }, { value: '🦷', label: 'Dental' }, { value: '👁️', label: 'Óptica' }
    ]
  },
  {
    name: 'Familia y mascotas',
    icons: [
      { value: '👶', label: 'Familia' }, { value: '🧒', label: 'Hijos' }, { value: '🐾', label: 'Mascotas' },
      { value: '🐕', label: 'Perro' }, { value: '🐈', label: 'Gato' }
    ]
  },
  {
    name: 'Ocio y entretenimiento',
    icons: [
      { value: '🎬', label: 'Cine' }, { value: '🎮', label: 'Videojuegos' }, { value: '🎵', label: 'Música' },
      { value: '🎤', label: 'Conciertos' }, { value: '🎉', label: 'Eventos' }, { value: '🎁', label: 'Regalos' },
      { value: '⚽', label: 'Deportes' }, { value: '🏋️', label: 'Gimnasio' }, { value: '🏖️', label: 'Vacaciones' }
    ]
  },
  {
    name: 'Mantenimiento',
    icons: [
      { value: '🛠️', label: 'Mantenimiento' }, { value: '🔧', label: 'Reparación' }, { value: '🧰', label: 'Herramientas' }
    ]
  },
  {
    name: 'Otros',
    icons: [
      { value: '💝', label: 'Donaciones' }, { value: '🎯', label: 'Metas' }, { value: '🛡️', label: 'Seguros' },
      { value: '⚖️', label: 'Legal' }, { value: '🏷️', label: 'Otros' }
    ]
  }
];
const ICON_OPTIONS = ICON_GROUPS.flatMap((g) => g.icons);
const newCategory = ref(emptyCategoryForm());
const editingCategoryId = ref<number | null>(null);
const profile = ref<Profile | null>(null);

const profileForm = ref({ name: '', email: '', currency: 'USD', currentPassword: '', newPassword: '' });
const profileMsg = ref(''); const profileErr = ref(''); const profileSaving = ref(false);

type SectionKey = 'profile' | 'categories' | 'banks' | 'wallets' | 'identity' | 'smtp' | 'roles' | 'users' | 'backups' | 'super-admin';
const VALID_SECTIONS: SectionKey[] = ['profile', 'categories', 'banks', 'wallets', 'identity', 'smtp', 'roles', 'users', 'backups', 'super-admin'];
const ADMIN_SECTIONS: SectionKey[] = ['smtp', 'roles', 'users'];
const SUPER_SECTIONS: SectionKey[] = ['super-admin'];

const route = useRoute();
const router = useRouter();

function readSectionFromQuery(): SectionKey | null {
  const raw = route.query.section as string | undefined;
  if (!raw) return null;
  if (!VALID_SECTIONS.includes(raw as SectionKey)) return null;
  if (ADMIN_SECTIONS.includes(raw as SectionKey) && !auth.isAdmin) return null;
  if (SUPER_SECTIONS.includes(raw as SectionKey) && !auth.isSuper) return null;
  return raw as SectionKey;
}

const activeSection = ref<SectionKey | null>(readSectionFromQuery());

watch(() => route.query.section, () => {
  activeSection.value = readSectionFromQuery();
});

watch(activeSection, (val) => {
  if (val === 'super-admin' && auth.isSuper) {
    loadTenants();   // siempre recarga al entrar (refresca cambios externos)
  }
}, { immediate: true });

// Validación reactiva: si la sección activa ya no es accesible para el rol
// actual (ej. URL stale ?section=super-admin), volver al hub y limpiar URL.
// Sin immediate para evitar TDZ con SECTIONS (declarado más abajo).
// La validación inicial se hace en onMounted().

const smtp = ref<SmtpPublic>({ host: '', port: 587, user: '', hasPass: false, secure: false, from: '', publicUrl: '' });
const smtpForm = ref({ host: '', port: 587, user: '', pass: '', secure: false, from: '', publicUrl: '' });
const smtpMsg = ref(''); const smtpErr = ref(''); const smtpSaving = ref(false);
const showSmtpPass = ref(false);
const securityMode = computed<'NONE' | 'STARTTLS' | 'SSL'>(() => {
  if (smtpForm.value.secure) return 'SSL';
  if (smtpForm.value.port === 587) return 'STARTTLS';
  return 'NONE';
});
function onSecurityChange(mode: string) {
  if (mode === 'SSL') { smtpForm.value.secure = true; smtpForm.value.port = 465; }
  else if (mode === 'STARTTLS') { smtpForm.value.secure = false; smtpForm.value.port = 587; }
  else { smtpForm.value.secure = false; if (smtpForm.value.port !== 25) smtpForm.value.port = 25; }
}
const testTo = ref(''); const testResult = ref<{ ok: boolean; error?: string } | null>(null);

const catMsg = ref(''); const catErr = ref('');

const iconPickerOpen = ref(false);
const iconQuery = ref('');
const filteredGroups = computed(() => {
  const q = iconQuery.value.trim().toLowerCase();
  if (!q) return ICON_GROUPS;
  return ICON_GROUPS
    .map((g) => ({ name: g.name, icons: g.icons.filter((i) => i.label.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)) }))
    .filter((g) => g.icons.length > 0);
});
const hasFilterResults = computed(() => filteredGroups.value.some((g) => g.icons.length > 0));
const selectedIconLabel = computed(() => {
  if (!newCategory.value.icon) return '';
  return ICON_OPTIONS.find((i) => i.value === newCategory.value.icon)?.label || '';
});
function selectIcon(value: string) {
  newCategory.value.icon = newCategory.value.icon === value ? '' : value;
  iconPickerOpen.value = false;
  iconQuery.value = '';
}

const banks = ref<Bank[]>([]);
const emptyBankForm = () => ({ name: '', accountNumber: '', accountKind: '' as BankAccountKind | '', isActive: true, notes: '' });
const newBank = ref(emptyBankForm());
const editingBankId = ref<number | null>(null);
const bankMsg = ref(''); const bankErr = ref('');

const wallets = ref<Wallet[]>([]);
const emptyWalletForm = () => ({ name: '', provider: '', identifier: '', isActive: true, notes: '' });
const newWallet = ref(emptyWalletForm());
const editingWalletId = ref<number | null>(null);
const walletMsg = ref(''); const walletErr = ref('');

// --- Super Admin: tenants ---
type TenantRow = {
  id: string;
  legalName: string;
  ruc?: string | null;
  email?: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | string;
  usersCount?: number;
  createdAt?: string;
};
const tenants = ref<TenantRow[]>([]);
const loadingTenants = ref(false);
const tenantsError = ref('');
const tenantFilter = ref('');
const filteredTenants = computed(() => {
  const q = tenantFilter.value.trim().toLowerCase();
  if (!q) return tenants.value;
  return tenants.value.filter((t) =>
    t.legalName.toLowerCase().includes(q) ||
    (t.email || '').toLowerCase().includes(q) ||
    (t.ruc || '').toLowerCase().includes(q)
  );
});

const tenantStats = computed(() => {
  const total = tenants.value.length;
  const active = tenants.value.filter((t) => t.status === 'ACTIVE').length;
  const users = tenants.value.reduce((acc, t) => acc + (t.usersCount ?? 0), 0);
  return { total, active, suspended: total - active, users };
});

const tenantForm = ref({ legalName: '', ruc: '', email: '', adminName: '', adminPassword: '' });
const creatingTenant = ref(false);
const createTenantError = ref('');
const createTenantSuccess = ref('');
const showCreateTenant = ref(false);

async function loadTenants() {
  if (!auth.isSuper) return;
  loadingTenants.value = true;
  tenantsError.value = '';
  try {
    const { data } = await http.get('/super-admin/tenants');
    // Backend devuelve { tenants: [...] }
    tenants.value = Array.isArray(data) ? data : (data?.tenants ?? data?.items ?? []);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    tenantsError.value = err?.response?.data?.message || 'No se pudieron cargar las empresas.';
  } finally {
    loadingTenants.value = false;
  }
}

// --- Modal acciones sobre admin del tenant ---
type TenantModal =
  | { kind: 'reset-pwd'; tenant: TenantRow }
  | { kind: 'change-email'; tenant: TenantRow }
  | null;
const tenantModal = ref<TenantModal>(null);

const resetPwdMode = ref<'random' | 'manual'>('random');
const resetPwdInput = ref('');
const resetPwdSubmitting = ref(false);
const resetPwdError = ref('');
const resetPwdResult = ref<{ email: string; password?: string } | null>(null);
const resetPwdCopied = ref(false);

const emailInput = ref('');
const emailSubmitting = ref(false);
const emailError = ref('');

function openResetPwd(t: TenantRow) {
  tenantModal.value = { kind: 'reset-pwd', tenant: t };
  resetPwdMode.value = 'random';
  resetPwdInput.value = '';
  resetPwdError.value = '';
  resetPwdResult.value = null;
  resetPwdCopied.value = false;
}

function openChangeEmail(t: TenantRow) {
  tenantModal.value = { kind: 'change-email', tenant: t };
  emailInput.value = t.email || '';
  emailError.value = '';
}

function closeTenantModal() {
  tenantModal.value = null;
  resetPwdInput.value = '';
  resetPwdResult.value = null;
  resetPwdError.value = '';
  emailInput.value = '';
  emailError.value = '';
}

async function submitResetPwd() {
  if (!tenantModal.value || tenantModal.value.kind !== 'reset-pwd') return;
  if (resetPwdSubmitting.value) return;
  resetPwdError.value = '';
  if (resetPwdMode.value === 'manual') {
    if (resetPwdInput.value.length < 10) {
      resetPwdError.value = 'La contraseña debe tener al menos 10 caracteres.';
      return;
    }
  }
  resetPwdSubmitting.value = true;
  try {
    const payload: Record<string, unknown> = {};
    if (resetPwdMode.value === 'manual') payload.password = resetPwdInput.value;
    const { data } = await http.post(
      `/super-admin/tenants/${tenantModal.value.tenant.id}/reset-admin-password`,
      payload
    );
    resetPwdResult.value = { email: data?.email, password: data?.password };
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    resetPwdError.value = err?.response?.data?.message || 'No se pudo restablecer la contraseña.';
  } finally {
    resetPwdSubmitting.value = false;
  }
}

function selectPasswordText(ev: MouseEvent) {
  const el = ev.currentTarget as HTMLElement | null;
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

async function copyPassword() {
  const value = resetPwdResult.value?.password;
  if (!value) return;
  let ok = false;
  // 1) API moderna (solo HTTPS o localhost)
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch { /* cae al fallback */ }
  }
  // 2) Fallback con textarea + execCommand para HTTP plano
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  if (ok) {
    resetPwdCopied.value = true;
    setTimeout(() => (resetPwdCopied.value = false), 1800);
  } else {
    resetPwdError.value = 'No se pudo copiar al portapapeles. Selecciona y copia manualmente.';
  }
}

async function submitChangeEmail() {
  if (!tenantModal.value || tenantModal.value.kind !== 'change-email') return;
  if (emailSubmitting.value) return;
  emailError.value = '';
  const newEmail = emailInput.value.trim().toLowerCase();
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    emailError.value = 'Ingresa un email válido.';
    return;
  }
  if (newEmail === (tenantModal.value.tenant.email || '').toLowerCase()) {
    emailError.value = 'El nuevo email es igual al actual.';
    return;
  }
  emailSubmitting.value = true;
  try {
    await http.patch(`/super-admin/tenants/${tenantModal.value.tenant.id}/admin-email`, { newEmail });
    await loadTenants();
    closeTenantModal();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    emailError.value = err?.response?.data?.message || 'No se pudo cambiar el email.';
  } finally {
    emailSubmitting.value = false;
  }
}

async function toggleTenantStatus(t: TenantRow) {
  const next = t.status === 'ACTIVE' ? 'suspend' : 'reactivate';
  try {
    await http.post(`/super-admin/tenants/${t.id}/${next}`);
    await loadTenants();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    alert(err?.response?.data?.message || `No se pudo ${next === 'suspend' ? 'suspender' : 'reactivar'} la empresa.`);
  }
}

async function createTenant() {
  if (creatingTenant.value) return;
  createTenantError.value = '';
  createTenantSuccess.value = '';
  if (!tenantForm.value.legalName.trim()) { createTenantError.value = 'La razón social es obligatoria.'; return; }
  if (!tenantForm.value.email.trim()) { createTenantError.value = 'El email es obligatorio.'; return; }
  if (!tenantForm.value.adminName.trim()) { createTenantError.value = 'El nombre del admin es obligatorio.'; return; }
  if (!tenantForm.value.adminPassword) { createTenantError.value = 'La contraseña del admin es obligatoria.'; return; }
  creatingTenant.value = true;
  try {
    const payload: Record<string, unknown> = {
      legalName: tenantForm.value.legalName.trim(),
      email: tenantForm.value.email.trim(),
      adminName: tenantForm.value.adminName.trim(),
      adminPassword: tenantForm.value.adminPassword
    };
    if (tenantForm.value.ruc.trim()) payload.ruc = tenantForm.value.ruc.trim();
    const { data } = await http.post('/super-admin/tenants', payload);
    createTenantSuccess.value = `Empresa ${data?.legalName ?? tenantForm.value.legalName} creada correctamente.`;
    tenantForm.value = { legalName: '', ruc: '', email: '', adminName: '', adminPassword: '' };
    showCreateTenant.value = false;
    await loadTenants();
    setTimeout(() => (createTenantSuccess.value = ''), 3500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    createTenantError.value = err?.response?.data?.message || 'No se pudo crear la empresa.';
  } finally {
    creatingTenant.value = false;
  }
}

const filteredCategories = computed(() => filter.value === 'ALL' ? categories.value : categories.value.filter((c) => c.type === filter.value));

const formatDate = (iso?: string) => {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('es-EC', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(iso)); }
  catch { return iso; }
};
const formatRole = (r?: string) => r === 'SUPERADMIN' ? '👑 Super-administrador' : r === 'ADMIN' ? '🔧 Administrador' : '👤 Cliente';

async function loadCategories() {
  const { data } = await http.get<Category[]>('/categories');
  categories.value = data;
}

async function loadBanks() {
  // Fuente única: el store de entidades (reactivo y compartido entre vistas).
  banks.value = (await entities.ensureBanks(true)) as Bank[];
}

async function addBank() {
  bankErr.value = ''; bankMsg.value = '';
  if (!newBank.value.name.trim()) { bankErr.value = 'El nombre es obligatorio.'; return; }
  try {
    const payload: Record<string, unknown> = {
      name: newBank.value.name.trim(),
      accountNumber: newBank.value.accountNumber.trim() || null,
      accountKind: newBank.value.accountKind || null,
      isActive: newBank.value.isActive,
      notes: newBank.value.notes.trim() || null
    };
    if (editingBankId.value !== null) {
      await http.put(`/banks/${editingBankId.value}`, payload);
      bankMsg.value = 'Banco actualizado.';
    } else {
      await http.post('/banks', payload);
      bankMsg.value = 'Banco creado.';
    }
    newBank.value = emptyBankForm();
    editingBankId.value = null;
    await loadBanks();
    setTimeout(() => (bankMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    bankErr.value = err?.response?.data?.message || 'No se pudo guardar el banco.';
  }
}

function startEditBank(b: Bank) {
  editingBankId.value = b.id;
  newBank.value = {
    name: b.name,
    accountNumber: b.accountNumber || '',
    accountKind: (b.accountKind || '') as BankAccountKind | '',
    isActive: b.isActive,
    notes: b.notes || ''
  };
}

function cancelEditBank() {
  editingBankId.value = null;
  newBank.value = emptyBankForm();
}

async function removeBank(b: Bank, force = false) {
  if (!force && !confirm(`Eliminar el banco "${b.name}"? Los movimientos que lo referencian quedarán sin banco asociado.`)) return;
  try {
    await http.delete(`/banks/${b.id}`, { params: force ? { force: 1 } : undefined });
    bankMsg.value = 'Banco eliminado.';
    if (editingBankId.value === b.id) cancelEditBank();
    await loadBanks();
    setTimeout(() => (bankMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: { message?: string; code?: string } } };
    if (err?.response?.status === 409 && err.response.data?.code === 'BANK_IN_USE') {
      if (confirm(err.response.data.message || 'El banco está en uso. ¿Eliminar igual?')) { await removeBank(b, true); return; }
      return;
    }
    bankErr.value = err?.response?.data?.message || 'No se pudo eliminar el banco.';
  }
}

// ---- Billeteras digitales ----
async function loadWallets() {
  const { data } = await http.get<Wallet[]>('/wallets');
  wallets.value = data;
}

async function addWallet() {
  walletErr.value = ''; walletMsg.value = '';
  if (!newWallet.value.name.trim()) { walletErr.value = 'El nombre es obligatorio.'; return; }
  try {
    const payload: Record<string, unknown> = {
      name: newWallet.value.name.trim(),
      provider: newWallet.value.provider.trim() || null,
      identifier: newWallet.value.identifier.trim() || null,
      isActive: newWallet.value.isActive,
      notes: newWallet.value.notes.trim() || null
    };
    if (editingWalletId.value !== null) {
      await http.put(`/wallets/${editingWalletId.value}`, payload);
      walletMsg.value = 'Billetera actualizada.';
    } else {
      await http.post('/wallets', payload);
      walletMsg.value = 'Billetera creada.';
    }
    newWallet.value = emptyWalletForm();
    editingWalletId.value = null;
    await loadWallets();
    setTimeout(() => (walletMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    walletErr.value = err?.response?.data?.message || 'No se pudo guardar la billetera.';
  }
}

function startEditWallet(w: Wallet) {
  editingWalletId.value = w.id;
  newWallet.value = {
    name: w.name,
    provider: w.provider || '',
    identifier: w.identifier || '',
    isActive: w.isActive,
    notes: w.notes || ''
  };
}

function cancelEditWallet() {
  editingWalletId.value = null;
  newWallet.value = emptyWalletForm();
}

async function removeWallet(w: Wallet) {
  if (!confirm(`Eliminar la billetera "${w.name}"? Los movimientos que la referencian quedarán sin billetera asociada.`)) return;
  try {
    await http.delete(`/wallets/${w.id}`);
    walletMsg.value = 'Billetera eliminada.';
    if (editingWalletId.value === w.id) cancelEditWallet();
    await loadWallets();
    setTimeout(() => (walletMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    walletErr.value = err?.response?.data?.message || 'No se pudo eliminar la billetera.';
  }
}

// ---- Respaldos ----
const backupBusy = ref(false);
const importBusy = ref(false);
const backupMsg = ref('');
const backupErr = ref('');
const importInput = ref<HTMLInputElement | null>(null);

async function exportBackup() {
  backupBusy.value = true; backupErr.value = ''; backupMsg.value = '';
  try {
    const blob = await backupApi.exportData();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `respaldo-finanzas-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    backupMsg.value = 'Respaldo descargado correctamente.';
  } catch {
    backupErr.value = 'No se pudo generar el respaldo.';
  } finally { backupBusy.value = false; }
}

function pickImport() { importInput.value?.click(); }

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!confirm('Vas a IMPORTAR datos desde un respaldo. Se AGREGARÁN a la empresa actual (lo ideal es importar en una empresa vacía). ¿Continuar?')) return;
  importBusy.value = true; backupErr.value = ''; backupMsg.value = '';
  try {
    const json = JSON.parse(await file.text());
    const res = await backupApi.importData(json);
    const counts = res.imported || {};
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'sin registros nuevos';
    backupMsg.value = `Importación completa: ${summary}.`;
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    backupErr.value = err?.response?.data?.message || 'No se pudo importar (archivo inválido o corrupto).';
  } finally { importBusy.value = false; }
}

// ---- Identidad (branding) ----
const brandingStore = useBrandingStore();
const identity = ref({ systemTitle: '', subtitle: '', primaryColor: '#2563eb', accentColor: '#06b6d4' });
const identityBusy = ref(false);
const identityMsg = ref('');
const identityErr = ref('');
const logoInput = ref<HTMLInputElement | null>(null);
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
const COLOR_PRESETS = ['#2563eb', '#4f46e5', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a', '#0891b2', '#0f172a'];

function syncIdentityForm() {
  identity.value = {
    systemTitle: brandingStore.systemTitle || '',
    subtitle: brandingStore.subtitle || '',
    primaryColor: brandingStore.primaryColor || '#2563eb',
    accentColor: brandingStore.accentColor || '#06b6d4'
  };
}
async function loadIdentity() {
  if (!brandingStore.loaded) await brandingStore.load();
  syncIdentityForm();
}

async function saveIdentity() {
  identityBusy.value = true; identityErr.value = ''; identityMsg.value = '';
  try {
    await brandingStore.save({
      systemTitle: identity.value.systemTitle.trim() || null,
      subtitle: identity.value.subtitle.trim() || null,
      primaryColor: identity.value.primaryColor || null,
      accentColor: identity.value.accentColor || null
    });
    identityMsg.value = 'Identidad guardada y aplicada.';
    setTimeout(() => (identityMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    identityErr.value = err?.response?.data?.message || 'No se pudo guardar la identidad.';
  } finally { identityBusy.value = false; }
}

function pickLogo() { logoInput.value?.click(); }
async function onLogoFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  if (!LOGO_TYPES.includes(f.type)) { identityErr.value = 'Formato no permitido (PNG, JPG, WEBP o SVG).'; return; }
  if (f.size > 3 * 1024 * 1024) { identityErr.value = 'Logo demasiado grande (máx. 3 MB).'; return; }
  identityBusy.value = true; identityErr.value = '';
  try {
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    await brandingStore.uploadLogo(f.type, dataBase64);
    identityMsg.value = 'Logo actualizado.';
    setTimeout(() => (identityMsg.value = ''), 2500);
  } catch {
    identityErr.value = 'No se pudo subir el logo.';
  } finally { identityBusy.value = false; }
}
async function removeLogo() {
  if (!confirm('¿Quitar el logo actual?')) return;
  try {
    await brandingStore.removeLogo();
    identityMsg.value = 'Logo eliminado.';
    setTimeout(() => (identityMsg.value = ''), 2500);
  } catch { identityErr.value = 'No se pudo eliminar el logo.'; }
}

async function loadProfile() {
  try {
    const { data } = await http.get<Profile>('/auth/me');
    profile.value = data;
    profileForm.value.name = data.name || '';
    profileForm.value.email = data.email || '';
    profileForm.value.currency = data.currency || 'USD';
  }
  catch { profile.value = null; }
}

async function saveProfile() {
  profileErr.value = ''; profileMsg.value = ''; profileSaving.value = true;
  try {
    const payload: Record<string, unknown> = {
      name: profileForm.value.name.trim(),
      email: profileForm.value.email.trim(),
      currency: profileForm.value.currency.trim().toUpperCase()
    };
    if (profileForm.value.newPassword) {
      payload.currentPassword = profileForm.value.currentPassword;
      payload.newPassword = profileForm.value.newPassword;
    }
    const { data } = await http.put<{ token: string; user: { id: number; name: string; email: string; currency: string; role: 'SUPERADMIN' | 'ADMIN' | 'CLIENT'; permissions: import('../stores/auth').Permissions } }>('/auth/me', payload);
    auth.setSession({ token: data.token, kind: auth.kind ?? 'tenant', user: data.user, tenant: auth.tenant });
    profileForm.value.currentPassword = '';
    profileForm.value.newPassword = '';
    profileMsg.value = 'Perfil actualizado.';
    await loadProfile();
    setTimeout(() => (profileMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    profileErr.value = err?.response?.data?.message || 'No se pudo actualizar el perfil.';
  } finally { profileSaving.value = false; }
}

async function loadSmtp() {
  if (!auth.isAdmin) return;
  try {
    const { data } = await http.get<SmtpPublic>('/admin/settings/smtp');
    smtp.value = data;
    smtpForm.value = { host: data.host, port: data.port, user: data.user, pass: '', secure: data.secure, from: data.from, publicUrl: data.publicUrl };
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    smtpErr.value = err?.response?.data?.message || 'No se pudo cargar la config SMTP.';
  }
}

async function addCategory() {
  catErr.value = ''; catMsg.value = '';
  if (!newCategory.value.name.trim()) { catErr.value = 'El nombre es obligatorio.'; return; }
  try {
    const payload: Record<string, unknown> = { name: newCategory.value.name.trim(), type: newCategory.value.type };
    if (newCategory.value.icon.trim()) payload.icon = newCategory.value.icon.trim();
    if (editingCategoryId.value !== null) {
      await http.put(`/categories/${editingCategoryId.value}`, payload);
      catMsg.value = 'Categoría actualizada.';
    } else {
      await http.post('/categories', payload);
      catMsg.value = 'Categoría creada.';
    }
    newCategory.value = emptyCategoryForm();
    editingCategoryId.value = null;
    await loadCategories();
    setTimeout(() => (catMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    catErr.value = err?.response?.data?.message || 'No se pudo guardar.';
  }
}

function startEditCategory(c: Category) {
  editingCategoryId.value = c.id;
  newCategory.value = {
    name: c.name,
    type: c.type,
    icon: c.icon || ''
  };
}

function cancelEditCategory() {
  editingCategoryId.value = null;
  newCategory.value = emptyCategoryForm();
}

async function removeCategory(c: Category) {
  if (!confirm(`Eliminar la categoría "${c.name}"? Los movimientos que la usan quedarán sin categoría.`)) return;
  try {
    await http.delete(`/categories/${c.id}`);
    catMsg.value = 'Categoría eliminada.';
    if (editingCategoryId.value === c.id) cancelEditCategory();
    await loadCategories();
    setTimeout(() => (catMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    catErr.value = err?.response?.data?.message || 'No se pudo eliminar.';
  }
}

async function saveSmtp() {
  smtpErr.value = ''; smtpMsg.value = ''; smtpSaving.value = true;
  try {
    const payload: Record<string, unknown> = {
      host: smtpForm.value.host.trim(),
      port: smtpForm.value.port,
      user: smtpForm.value.user.trim(),
      secure: smtpForm.value.secure,
      from: smtpForm.value.from.trim(),
      publicUrl: smtpForm.value.publicUrl.trim()
    };
    if (smtpForm.value.pass) payload.pass = smtpForm.value.pass;
    await http.put('/admin/settings/smtp', payload);
    smtpMsg.value = 'Configuración SMTP guardada.';
    smtpForm.value.pass = '';
    await loadSmtp();
    setTimeout(() => (smtpMsg.value = ''), 3000);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    smtpErr.value = err?.response?.data?.message || 'No se pudo guardar.';
  } finally { smtpSaving.value = false; }
}

async function clearSmtp() {
  if (!confirm('¿Eliminar la configuración SMTP? Los emails dejarán de enviarse.')) return;
  await http.delete('/admin/settings/smtp');
  await loadSmtp();
  smtpMsg.value = 'Configuración eliminada.';
  setTimeout(() => (smtpMsg.value = ''), 2500);
}

async function testSmtp() {
  testResult.value = null;
  try {
    const { data } = await http.post<{ ok: boolean; error?: string }>('/admin/settings/smtp/test', testTo.value ? { to: testTo.value } : {});
    testResult.value = data;
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    testResult.value = { ok: false, error: err?.response?.data?.message || 'Error en la prueba' };
  }
}

type SectionCard = {
  key: SectionKey;
  title: string;
  description: string;
  icon: Component;
  accent: 'teal' | 'green' | 'cyan' | 'orange' | 'purple' | 'red' | 'gray' | 'blue' | 'indigo' | 'amber';
};

const SECTIONS = computed<SectionCard[]>(() => {
  // SUPER_ADMIN sin tenant activo: solo administra empresas
  if (auth.isSuper) {
    return [
      { key: 'super-admin', title: 'Empresas', description: 'Administra las empresas de la plataforma.', icon: Building2, accent: 'indigo' }
    ];
  }
  // ADMIN_EMPRESA o USUARIO_EMPRESA (sesión dentro de un tenant)
  const base: SectionCard[] = [
    { key: 'profile', title: 'Mi perfil', description: 'Tus datos, rol y moneda.', icon: User, accent: 'teal' },
    { key: 'categories', title: 'Categorías', description: 'Para clasificar ingresos y gastos.', icon: Tags, accent: 'orange' },
    { key: 'banks', title: 'Bancos', description: 'Catálogo de bancos para tus cuentas.', icon: Landmark, accent: 'blue' },
    { key: 'wallets', title: 'Billeteras digitales', description: 'Payphone, PayPal, Takenos y otras billeteras.', icon: Smartphone, accent: 'purple' }
  ];
  if (auth.isAdmin) {
    base.push({ key: 'roles', title: 'Roles', description: 'Plantillas de permisos.', icon: ShieldCheck, accent: 'indigo' });
    base.push({ key: 'users', title: 'Usuarios', description: 'Crear y administrar usuarios.', icon: Users, accent: 'purple' });
    base.push({ key: 'identity', title: 'Identidad', description: 'Logo, título y colores de tu sistema.', icon: Palette, accent: 'purple' });
    base.push({ key: 'smtp', title: 'Servidor de correo', description: 'Configura el SMTP para enviar emails (bienvenida, avisos).', icon: Mail, accent: 'cyan' });
    base.push({ key: 'backups', title: 'Respaldos', description: 'Exporta e importa todos tus datos para migrar o restaurar.', icon: Archive, accent: 'green' });
  }
  return base;
});

const currentSectionTitle = computed(() => {
  if (!activeSection.value) return '';
  const s = SECTIONS.value.find((x) => x.key === activeSection.value);
  return s ? s.title : '';
});

function openSection(key: SectionKey) {
  activeSection.value = key;
  router.push({ query: { ...route.query, section: key } });
}

function backToHub() {
  activeSection.value = null;
  const { section: _omit, ...rest } = route.query;
  router.push({ query: rest });
}

function validateActiveSection() {
  const val = activeSection.value;
  if (!val) return;
  const allowed = SECTIONS.value.some((s) => s.key === val);
  if (!allowed) {
    activeSection.value = null;
    const { section: _omit, ...rest } = route.query;
    router.replace({ query: rest });
  }
}

// Reactiva: si el rol cambia, valida la sección activa
watch([() => auth.isSuper, () => auth.isAdmin, activeSection], validateActiveSection);

onMounted(async () => {
  // Validar sección activa primero (corrige URL stale antes de hacer requests)
  validateActiveSection();

  if (auth.isSuper) {
    // Super-admin: solo carga lista de tenants si está en esa sección
    if (activeSection.value === 'super-admin') await loadTenants();
    return;   // NO hace requests a /categories, /banks, /auth/me, /admin/settings/smtp
  }

  // Tenant user: carga datos del tenant
  await Promise.all([
    loadCategories(),
    loadBanks(),
    loadWallets(),
    loadProfile(),
    auth.isAdmin ? loadSmtp() : Promise.resolve(),
    auth.isAdmin ? loadIdentity() : Promise.resolve()
  ]);
});
</script>

<template>
  <section class="dashboard">
    <div v-if="!activeSection" class="settings-hero">
      <small class="hero-eyebrow">ADMINISTRACIÓN · CONFIGURACIONES</small>
      <h1>Configuraciones</h1>
      <p>Centro de configuración del sistema — accede a cada módulo desde una sola vista.</p>
    </div>

    <div v-if="!activeSection" class="settings-grid">
      <button
        v-for="card in SECTIONS"
        :key="card.key"
        type="button"
        class="settings-card"
        :class="`accent-${card.accent}`"
        @click="openSection(card.key)"
      >
        <span class="settings-card-icon"><component :is="card.icon" :size="26" :stroke-width="2" /></span>
        <div class="settings-card-body">
          <strong>{{ card.title }}</strong>
          <span>{{ card.description }}</span>
        </div>
        <span class="settings-card-arrow">›</span>
      </button>
    </div>

    <div v-else class="section-detail">
      <div class="section-header">
        <button type="button" class="back-btn ghost" @click="backToHub">← Volver</button>
        <h1>{{ currentSectionTitle }}</h1>
      </div>

    <div v-if="activeSection === 'profile'" class="panel">
      <div class="panel-header"><h2>Mi perfil</h2></div>

      <div class="profile-meta">
        <div><small>Rol del sistema</small><strong>{{ formatRole(profile?.role || auth.user?.role || 'CLIENT') }}</strong></div>
        <div><small>Cuenta creada</small><strong>{{ formatDate(profile?.createdAt) }}</strong></div>
      </div>

      <form class="form" @submit.prevent="saveProfile">
        <div class="field-group">
          <div class="field">
            <label for="prof-name">Nombre completo</label>
            <input id="prof-name" v-model="profileForm.name" required minlength="2" maxlength="80" placeholder="Tu nombre" />
            <small class="hint">Como aparece en el menú lateral y al crear movimientos.</small>
          </div>
          <div class="field">
            <label for="prof-email">Correo electrónico</label>
            <input id="prof-email" v-model="profileForm.email" type="email" required maxlength="120" placeholder="tu@correo.com" />
            <small class="hint">Es el correo de inicio de sesión. Tras cambiarlo se renueva la sesión.</small>
          </div>
        </div>

        <div class="field">
          <label for="prof-cur">Moneda</label>
          <input id="prof-cur" v-model="profileForm.currency" maxlength="8" placeholder="USD" />
          <small class="hint">Código ISO de 3-4 letras. Ej. USD, EUR, COP.</small>
        </div>

        <div class="profile-section-divider">
          <strong>Cambiar contraseña</strong>
          <small>Opcional. Solo completa estos campos si quieres reemplazar tu contraseña actual.</small>
        </div>

        <div class="field-group">
          <div class="field">
            <label for="prof-cur-pwd">Contraseña actual</label>
            <input id="prof-cur-pwd" v-model="profileForm.currentPassword" type="password" autocomplete="current-password" placeholder="••••••••" />
            <small class="hint">Requerida para validar el cambio.</small>
          </div>
          <div class="field">
            <label for="prof-new-pwd">Nueva contraseña</label>
            <input id="prof-new-pwd" v-model="profileForm.newPassword" type="password" autocomplete="new-password" placeholder="Min 10, may/min/núm" />
            <small class="hint">Mínimo 10 caracteres con mayúscula, minúscula y número.</small>
          </div>
        </div>

        <p v-if="profileMsg" class="hint-msg">{{ profileMsg }}</p>
        <p v-if="profileErr" class="error">{{ profileErr }}</p>

        <div class="form-submit-row">
          <button type="submit" :disabled="profileSaving">{{ profileSaving ? 'Guardando…' : 'Guardar cambios' }}</button>
        </div>
      </form>
    </div>

    <div v-if="activeSection === 'categories'" class="panel">
      <div class="panel-header"><h2>{{ editingCategoryId !== null ? 'Editar categoría' : 'Nueva categoría' }}</h2></div>
      <form class="form" @submit.prevent="addCategory">
        <div class="field-group">
          <div class="field">
            <label for="cat-name">Nombre</label>
            <input id="cat-name" v-model="newCategory.name" required placeholder="ej. Combustible" />
            <small class="hint">Un nombre corto y descriptivo.</small>
          </div>
          <div class="field">
            <label for="cat-type">Tipo</label>
            <select id="cat-type" v-model="newCategory.type">
              <option value="INCOME">Ingreso</option>
              <option value="EXPENSE">Gasto</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label>Ícono</label>
          <button type="button" class="icon-trigger" @click="iconPickerOpen = !iconPickerOpen" :class="{ open: iconPickerOpen }">
            <span class="icon-trigger-preview">{{ newCategory.icon || '🏷️' }}</span>
            <span class="icon-trigger-text">{{ newCategory.icon ? selectedIconLabel : 'Elegir un ícono' }}</span>
            <span class="icon-trigger-chevron">{{ iconPickerOpen ? '▴' : '▾' }}</span>
          </button>

          <div v-if="iconPickerOpen" class="icon-picker-wrap">
            <input v-model="iconQuery" type="text" placeholder="Buscar por nombre o categoría…" class="icon-search" />
            <div class="icon-picker-scroll">
              <div v-for="group in filteredGroups" :key="group.name" class="icon-group">
                <div class="icon-group-header">{{ group.name }} <span class="icon-group-count">{{ group.icons.length }}</span></div>
                <div class="icon-picker">
                  <button v-for="ic in group.icons" :key="ic.value" type="button"
                          class="icon-option"
                          :class="{ selected: newCategory.icon === ic.value }"
                          :title="ic.label"
                          @click="selectIcon(ic.value)">
                    {{ ic.value }}
                  </button>
                </div>
              </div>
              <div v-if="!hasFilterResults" class="icon-empty">Sin resultados para "{{ iconQuery }}".</div>
            </div>
            <div v-if="newCategory.icon" class="icon-picker-actions">
              <button type="button" class="ghost" @click="selectIcon(newCategory.icon)"><X :size="14" /> Quitar ícono</button>
            </div>
          </div>

          <small class="hint">Opcional. Ayuda a identificar la categoría de un vistazo.</small>
        </div>

        <div class="actions-row">
          <button type="submit"><component :is="editingCategoryId !== null ? Pencil : Plus" :size="16" /> {{ editingCategoryId !== null ? 'Guardar cambios' : 'Agregar categoría' }}</button>
          <button v-if="editingCategoryId !== null" type="button" class="ghost" @click="cancelEditCategory"><X :size="16" /> Cancelar</button>
        </div>
        <p v-if="catMsg" class="hint-msg">{{ catMsg }}</p>
        <p v-if="catErr" class="error">{{ catErr }}</p>
      </form>

      <div class="tab-filter">
        <button type="button" class="tab-filter-btn" :class="{ active: filter === 'ALL' }" @click="filter = 'ALL'">Todas</button>
        <button type="button" class="tab-filter-btn" :class="{ active: filter === 'INCOME' }" @click="filter = 'INCOME'">Ingresos</button>
        <button type="button" class="tab-filter-btn" :class="{ active: filter === 'EXPENSE' }" @click="filter = 'EXPENSE'">Gastos</button>
      </div>

      <table class="recent-table" style="margin-top: 12px">
        <thead><tr><th>Nombre</th><th>Tipo</th><th class="right">Acciones</th></tr></thead>
        <tbody>
          <tr v-for="cat in filteredCategories" :key="cat.id">
            <td>
              <span v-if="cat.color" class="color-swatch" :style="{ backgroundColor: cat.color }"></span>
              <span v-if="cat.icon" class="cat-icon-text">{{ cat.icon }}</span>
              {{ cat.name }}
            </td>
            <td><span class="cat-pill">{{ cat.type === 'INCOME' ? 'Ingreso' : 'Gasto' }}</span></td>
            <td class="right">
              <div class="row-actions">
                <button type="button" class="ghost mini" @click="startEditCategory(cat)" :disabled="editingCategoryId === cat.id"><Pencil :size="14" /></button>
                <button type="button" class="ghost mini danger" @click="removeCategory(cat)"><Trash2 :size="14" /></button>
              </div>
            </td>
          </tr>
          <tr v-if="!filteredCategories.length"><td colspan="3">
            <div class="empty-state">
              <div class="empty-state-illustration"><Tags :size="36" /></div>
              <strong>Sin categorías</strong>
              <p>Crea categorías para clasificar tus ingresos y gastos.</p>
            </div>
          </td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="activeSection === 'banks'" class="panel">
      <div class="panel-header"><h2>{{ editingBankId !== null ? 'Editar banco' : 'Nuevo banco' }}</h2></div>
      <form class="form" @submit.prevent="addBank">
        <div class="form-grid">
          <div class="field">
            <label for="bank-name">Nombre del banco</label>
            <input id="bank-name" v-model="newBank.name" required minlength="2" maxlength="80" placeholder="ej. Banco Pichincha, BCP, Pacífico" />
            <small class="hint">Solo el nombre del banco. El titular, tipo y número de cuenta se configuran en <strong>Cuentas</strong>.</small>
          </div>
        </div>

        <div class="field">
          <label for="bank-notes">Notas</label>
          <textarea id="bank-notes" v-model="newBank.notes" rows="2" maxlength="300" placeholder="Sucursal, tipo de cuenta, etc. (opcional)"></textarea>
        </div>

        <div class="form-footer">
          <div class="field field-narrow">
            <label>Estado</label>
            <div class="bank-toggle-row">
              <button
                type="button"
                role="switch"
                :aria-checked="newBank.isActive"
                class="toggle-switch"
                :class="{ on: newBank.isActive }"
                @click="newBank.isActive = !newBank.isActive"
              >
                <span class="toggle-knob"></span>
              </button>
              <span class="toggle-label" :class="{ on: newBank.isActive }">
                {{ newBank.isActive ? 'Activo' : 'Inactivo' }}
              </span>
            </div>
            <small class="hint">Si está inactivo no aparece al registrar movimientos.</small>
          </div>
          <div class="form-actions">
            <button v-if="editingBankId !== null" type="button" class="ghost" @click="cancelEditBank"><X :size="16" /> Cancelar</button>
            <button type="submit"><component :is="editingBankId !== null ? Pencil : Plus" :size="16" /> {{ editingBankId !== null ? 'Guardar cambios' : 'Agregar banco' }}</button>
          </div>
        </div>

        <p v-if="bankMsg" class="hint-msg">{{ bankMsg }}</p>
        <p v-if="bankErr" class="error">{{ bankErr }}</p>
      </form>

      <table class="recent-table banks-table" style="margin-top: 12px">
        <thead>
          <tr>
            <th class="col-name">Banco</th>
            <th class="col-status center">Estado</th>
            <th class="col-notes">Notas</th>
            <th class="col-actions center">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in banks" :key="b.id">
            <td>🏦 <strong>{{ b.name }}</strong></td>
            <td class="center">
              <span v-if="b.isActive" class="cat-pill" style="background:#dcfce7;color:#166534">Activo</span>
              <span v-else class="cat-pill" style="background:#fee2e2;color:#991b1b">Inactivo</span>
            </td>
            <td><small class="hint">{{ b.notes || '—' }}</small></td>
            <td class="center">
              <div class="row-actions">
                <button type="button" class="ghost mini" @click="startEditBank(b)" :disabled="editingBankId === b.id"><Pencil :size="14" /></button>
                <button type="button" class="ghost mini danger" @click="removeBank(b)"><Trash2 :size="14" /></button>
              </div>
            </td>
          </tr>
          <tr v-if="!banks.length"><td colspan="4">
            <div class="empty-state">
              <div class="empty-state-illustration"><Landmark :size="36" /></div>
              <strong>Sin bancos</strong>
              <p>Crea el primero para usarlo en cuentas y transferencias.</p>
            </div>
          </td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="activeSection === 'wallets'" class="panel">
      <div class="panel-header"><h2>{{ editingWalletId !== null ? 'Editar billetera' : 'Nueva billetera digital' }}</h2></div>
      <form class="form" @submit.prevent="addWallet">
        <div class="form-grid">
          <div class="field">
            <label for="wallet-name">Nombre</label>
            <input id="wallet-name" v-model="newWallet.name" required minlength="2" maxlength="80" placeholder="ej. Payphone personal, PayPal negocio" />
            <small class="hint">Aparecerá al registrar movimientos con billetera.</small>
          </div>
          <div class="field">
            <label for="wallet-provider">Proveedor</label>
            <input id="wallet-provider" v-model="newWallet.provider" maxlength="60" list="wallet-providers" placeholder="ej. Payphone, PayPal, Takenos" />
            <datalist id="wallet-providers">
              <option value="Payphone"></option>
              <option value="PayPal"></option>
              <option value="Takenos"></option>
              <option value="Mercado Pago"></option>
              <option value="Binance Pay"></option>
            </datalist>
            <small class="hint">Opcional. Plataforma de la billetera.</small>
          </div>
          <div class="field">
            <label for="wallet-id">Usuario / Correo / Teléfono</label>
            <input id="wallet-id" v-model="newWallet.identifier" maxlength="120" placeholder="ej. correo@ejemplo.com, 0991234567" />
            <small class="hint">Opcional. Identificador de la cuenta.</small>
          </div>
        </div>

        <div class="field">
          <label for="wallet-notes">Notas</label>
          <textarea id="wallet-notes" v-model="newWallet.notes" rows="2" maxlength="300" placeholder="Detalles adicionales (opcional)"></textarea>
        </div>

        <div class="form-footer">
          <div class="field field-narrow">
            <label>Estado</label>
            <div class="bank-toggle-row">
              <button
                type="button"
                role="switch"
                :aria-checked="newWallet.isActive"
                class="toggle-switch"
                :class="{ on: newWallet.isActive }"
                @click="newWallet.isActive = !newWallet.isActive"
              >
                <span class="toggle-knob"></span>
              </button>
              <span class="toggle-label" :class="{ on: newWallet.isActive }">
                {{ newWallet.isActive ? 'Activa' : 'Inactiva' }}
              </span>
            </div>
            <small class="hint">Si está inactiva no aparece al registrar movimientos.</small>
          </div>
          <div class="form-actions">
            <button v-if="editingWalletId !== null" type="button" class="ghost" @click="cancelEditWallet"><X :size="16" /> Cancelar</button>
            <button type="submit"><component :is="editingWalletId !== null ? Pencil : Plus" :size="16" /> {{ editingWalletId !== null ? 'Guardar cambios' : 'Agregar billetera' }}</button>
          </div>
        </div>

        <p v-if="walletMsg" class="hint-msg">{{ walletMsg }}</p>
        <p v-if="walletErr" class="error">{{ walletErr }}</p>
      </form>

      <table class="recent-table banks-table" style="margin-top: 12px">
        <thead>
          <tr>
            <th class="col-name">Billetera</th>
            <th class="col-kind center">Proveedor</th>
            <th class="col-num">Identificador</th>
            <th class="col-status center">Estado</th>
            <th class="col-notes">Notas</th>
            <th class="col-actions center">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="w in wallets" :key="w.id">
            <td>👛 <strong>{{ w.name }}</strong></td>
            <td class="center">
              <span v-if="w.provider" class="cat-pill">{{ w.provider }}</span>
              <small v-else class="hint">—</small>
            </td>
            <td>
              <span v-if="w.identifier" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">{{ w.identifier }}</span>
              <small v-else class="hint">—</small>
            </td>
            <td class="center">
              <span v-if="w.isActive" class="cat-pill" style="background:#dcfce7;color:#166534">Activa</span>
              <span v-else class="cat-pill" style="background:#fee2e2;color:#991b1b">Inactiva</span>
            </td>
            <td><small class="hint">{{ w.notes || '—' }}</small></td>
            <td class="center">
              <div class="row-actions">
                <button type="button" class="ghost mini" @click="startEditWallet(w)" :disabled="editingWalletId === w.id"><Pencil :size="14" /></button>
                <button type="button" class="ghost mini danger" @click="removeWallet(w)"><Trash2 :size="14" /></button>
              </div>
            </td>
          </tr>
          <tr v-if="!wallets.length"><td colspan="6">
            <div class="empty-state">
              <div class="empty-state-illustration"><Smartphone :size="36" /></div>
              <strong>Sin billeteras digitales</strong>
              <p>Agrega Payphone, PayPal, Takenos u otras para usarlas al registrar movimientos.</p>
            </div>
          </td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="activeSection === 'identity'" class="panel">
      <div class="panel-header"><h2>Identidad del sistema</h2></div>
      <p class="hint" style="margin-bottom:16px">Personaliza el logo, el nombre y los colores. Los cambios se aplican al instante en toda la app.</p>

      <div class="identity-block">
        <div class="identity-logo-preview">
          <img v-if="brandingStore.logoUrl" :src="brandingStore.logoUrl" alt="Logo" />
          <div v-else class="identity-logo-empty"><Palette :size="30" /></div>
        </div>
        <div class="identity-logo-actions">
          <strong>Logo</strong>
          <small class="hint">PNG, JPG, WEBP o SVG, hasta 3 MB. Se muestra en el menú lateral.</small>
          <input ref="logoInput" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" class="backup-file" @change="onLogoFile" />
          <div class="identity-logo-btns">
            <button type="button" @click="pickLogo" :disabled="identityBusy">
              <Upload :size="15" /> {{ brandingStore.hasLogo ? 'Cambiar logo' : 'Subir logo' }}
            </button>
            <button v-if="brandingStore.hasLogo" type="button" class="ghost" @click="removeLogo"><Trash2 :size="15" /> Quitar</button>
          </div>
        </div>
      </div>

      <form class="form" @submit.prevent="saveIdentity" style="margin-top:18px">
        <div class="form-grid">
          <div class="field">
            <label for="id-title">Título del sistema</label>
            <input id="id-title" v-model="identity.systemTitle" maxlength="60" placeholder="ej. Finanzas Acme" />
            <small class="hint">Aparece en el menú lateral y en la pestaña del navegador.</small>
          </div>
          <div class="field">
            <label for="id-sub">Subtítulo</label>
            <input id="id-sub" v-model="identity.subtitle" maxlength="80" placeholder="ej. Gestión financiera" />
            <small class="hint">Texto pequeño bajo el título.</small>
          </div>
        </div>

        <div class="form-grid">
          <div class="field">
            <label>Color principal</label>
            <div class="color-row">
              <input type="color" v-model="identity.primaryColor" class="color-input" aria-label="Color principal" />
              <input type="text" v-model="identity.primaryColor" maxlength="7" class="color-hex" />
              <div class="color-presets">
                <button v-for="c in COLOR_PRESETS" :key="'p' + c" type="button" class="color-dot" :style="{ background: c }" :title="c" @click="identity.primaryColor = c"></button>
              </div>
            </div>
            <small class="hint">Botones, enlaces y elementos activos.</small>
          </div>
          <div class="field">
            <label>Color de acento</label>
            <div class="color-row">
              <input type="color" v-model="identity.accentColor" class="color-input" aria-label="Color de acento" />
              <input type="text" v-model="identity.accentColor" maxlength="7" class="color-hex" />
            </div>
            <small class="hint">Detalles secundarios.</small>
          </div>
        </div>

        <div class="form-actions">
          <button type="submit" :disabled="identityBusy"><Check :size="16" /> {{ identityBusy ? 'Guardando…' : 'Guardar identidad' }}</button>
        </div>
        <p v-if="identityMsg" class="hint-msg">{{ identityMsg }}</p>
        <p v-if="identityErr" class="error">{{ identityErr }}</p>
      </form>
    </div>

    <div v-if="activeSection === 'backups'" class="panel">
      <div class="panel-header"><h2>Respaldos y migración</h2></div>
      <p class="hint" style="margin-bottom:16px">
        Exporta toda tu información (cuentas, movimientos, facturas, comprobantes, deudas, etc.) a un archivo,
        o impórtala en otra empresa para migrar o restaurar.
      </p>

      <div class="backup-cards">
        <div class="backup-card">
          <div class="backup-ic"><Download :size="22" /></div>
          <strong>Exportar respaldo</strong>
          <small>Descarga un archivo JSON con TODOS tus datos, incluidos los comprobantes adjuntos.</small>
          <button type="button" @click="exportBackup" :disabled="backupBusy">
            <Download :size="16" /> {{ backupBusy ? 'Generando…' : 'Descargar respaldo' }}
          </button>
        </div>
        <div class="backup-card">
          <div class="backup-ic up"><Upload :size="22" /></div>
          <strong>Importar respaldo</strong>
          <small>Restaura desde un archivo de respaldo. Los datos se agregan a la empresa actual.</small>
          <input ref="importInput" type="file" accept="application/json,.json" class="backup-file" @change="onImportFile" />
          <button type="button" class="secondary" @click="pickImport" :disabled="importBusy">
            <Upload :size="16" /> {{ importBusy ? 'Importando…' : 'Seleccionar archivo…' }}
          </button>
        </div>
      </div>

      <p v-if="backupMsg" class="hint-msg" style="margin-top:14px">{{ backupMsg }}</p>
      <p v-if="backupErr" class="error" style="margin-top:14px">{{ backupErr }}</p>

      <div class="backup-note">
        <strong>⚠️ Recomendación para migrar</strong>
        <p>Crea la empresa destino, entra en ella y luego importa el respaldo estando vacía, para evitar duplicados.</p>
      </div>
    </div>

    <div v-if="activeSection === 'super-admin' && auth.isSuper" class="panel">
      <div class="panel-header" style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <h2 style="margin:0;">Empresas</h2>
        <button type="button" @click="showCreateTenant = !showCreateTenant">
          <Plus :size="16" /> {{ showCreateTenant ? 'Cancelar' : 'Nueva empresa' }}
        </button>
      </div>

      <div v-if="tenants.length" class="tn-stats">
        <div class="tn-stat">
          <span class="tn-stat-icon all"><Building2 :size="18" /></span>
          <div class="tn-stat-body"><strong>{{ tenantStats.total }}</strong><small>Empresas</small></div>
        </div>
        <div class="tn-stat">
          <span class="tn-stat-icon ok"><Check :size="18" /></span>
          <div class="tn-stat-body"><strong>{{ tenantStats.active }}</strong><small>Activas</small></div>
        </div>
        <div class="tn-stat">
          <span class="tn-stat-icon warn"><Pause :size="18" /></span>
          <div class="tn-stat-body"><strong>{{ tenantStats.suspended }}</strong><small>Suspendidas</small></div>
        </div>
        <div class="tn-stat">
          <span class="tn-stat-icon users"><Users :size="18" /></span>
          <div class="tn-stat-body"><strong>{{ tenantStats.users }}</strong><small>Usuarios</small></div>
        </div>
      </div>

      <p v-if="tenantsError" class="error">{{ tenantsError }}</p>
      <p v-if="createTenantSuccess" class="hint-msg">{{ createTenantSuccess }}</p>

      <form v-if="showCreateTenant" class="form" style="margin-bottom: 18px;" @submit.prevent="createTenant">
        <div class="field-group">
          <div class="field">
            <label for="ten-legal">Razón social *</label>
            <input id="ten-legal" v-model="tenantForm.legalName" required placeholder="Mi Empresa S.A." />
          </div>
          <div class="field">
            <label for="ten-ruc">RUC</label>
            <input id="ten-ruc" v-model="tenantForm.ruc" placeholder="1790000000001 (opcional)" />
          </div>
        </div>
        <div class="field-group">
          <div class="field">
            <label for="ten-email">Email del admin *</label>
            <input id="ten-email" v-model="tenantForm.email" type="email" required placeholder="admin@miempresa.com" />
          </div>
          <div class="field">
            <label for="ten-aname">Nombre del admin *</label>
            <input id="ten-aname" v-model="tenantForm.adminName" required placeholder="Juan Pérez" />
          </div>
        </div>
        <div class="field">
          <label for="ten-apwd">Contraseña del admin *</label>
          <input id="ten-apwd" v-model="tenantForm.adminPassword" type="password" required minlength="10" placeholder="Min 10, may/min/núm" />
          <small class="hint">Mínimo 10 caracteres con mayúscula, minúscula y número.</small>
        </div>

        <p v-if="createTenantError" class="error">{{ createTenantError }}</p>

        <div class="form-submit-row">
          <button type="submit" :disabled="creatingTenant">
            <Plus :size="16" /> {{ creatingTenant ? 'Creando…' : 'Crear empresa' }}
          </button>
        </div>
      </form>

      <div class="toolbar" style="display:flex; gap:8px; margin: 8px 0 12px; flex-wrap:wrap;">
        <input v-model="tenantFilter" type="search" placeholder="Filtrar por razón social, email o RUC..." style="flex:1; min-width: 220px;" />
        <button type="button" class="ghost" @click="loadTenants" :disabled="loadingTenants">
          {{ loadingTenants ? 'Cargando…' : 'Recargar' }}
        </button>
      </div>

      <table class="recent-table">
        <thead>
          <tr>
            <th>Razón social</th>
            <th>Email</th>
            <th>RUC</th>
            <th class="center">Estado</th>
            <th class="center"># usuarios</th>
            <th>Creado</th>
            <th class="right">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!loadingTenants && filteredTenants.length === 0">
            <td colspan="7">
              <div class="empty-state tn-empty">
                <div class="empty-state-illustration"><Building2 :size="36" /></div>
                <strong>{{ tenantFilter ? 'Sin resultados' : 'Aún no hay empresas' }}</strong>
                <p>{{ tenantFilter ? 'Ninguna empresa coincide con tu búsqueda.' : 'Crea tu primera empresa para empezar a usar la plataforma. Cada empresa tendrá su propia base de datos aislada.' }}</p>
                <button v-if="!tenantFilter && !showCreateTenant" type="button" class="tn-cta" @click="showCreateTenant = true">
                  <Plus :size="16" /> Crear mi primera empresa
                </button>
              </div>
            </td>
          </tr>
          <tr v-for="t in filteredTenants" :key="t.id">
            <td><strong>{{ t.legalName }}</strong></td>
            <td>{{ t.email || '—' }}</td>
            <td>{{ t.ruc || '—' }}</td>
            <td class="center">
              <span v-if="t.status === 'ACTIVE'" class="cat-pill" style="background:#dcfce7;color:#166534">Activa</span>
              <span v-else class="cat-pill" style="background:#fee2e2;color:#991b1b">{{ t.status }}</span>
            </td>
            <td class="center">{{ t.usersCount ?? '—' }}</td>
            <td>{{ formatDate(t.createdAt) }}</td>
            <td class="right">
              <div class="row-actions">
                <button
                  type="button"
                  class="ghost mini"
                  title="Restablecer contraseña del admin"
                  @click="openResetPwd(t)"
                >
                  <Key :size="14" />
                </button>
                <button
                  type="button"
                  class="ghost mini"
                  title="Cambiar email del admin"
                  @click="openChangeEmail(t)"
                >
                  <Mail :size="14" />
                </button>
                <button
                  v-if="t.status === 'ACTIVE'"
                  type="button"
                  class="ghost mini"
                  title="Suspender"
                  @click="toggleTenantStatus(t)"
                >
                  <Pause :size="14" />
                </button>
                <button
                  v-else
                  type="button"
                  class="ghost mini"
                  title="Reactivar"
                  @click="toggleTenantStatus(t)"
                >
                  <Play :size="14" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <RolesPanel v-if="activeSection === 'roles' && auth.isAdmin" />

    <AdminUsersPanel v-if="activeSection === 'users' && auth.isAdmin" />

    <div v-if="activeSection === 'smtp' && auth.isAdmin" class="smtp-card">
      <div class="smtp-banner">
        <h3>Datos del servidor de correo</h3>
        <span class="smtp-status-pill" :class="smtp.hasPass && smtp.host ? 'ok' : 'warn'">
          {{ smtp.hasPass && smtp.host ? '✓ Configurado' : '⚠ No configurado' }}
        </span>
      </div>

      <form class="smtp-form" @submit.prevent="saveSmtp">
        <div class="smtp-grid">
          <div class="smtp-field">
            <label for="smtp-host">Host/servidor:</label>
            <input id="smtp-host" v-model="smtpForm.host" required placeholder="webmail.tudominio.com" />
          </div>
          <div class="smtp-field">
            <label for="smtp-port">Puerto:</label>
            <input id="smtp-port" v-model.number="smtpForm.port" type="number" min="1" max="65535" required />
          </div>

          <div class="smtp-field">
            <label for="smtp-user">Usuario/Correo:</label>
            <input id="smtp-user" v-model="smtpForm.user" required placeholder="noreply@dominio.com" />
          </div>
          <div class="smtp-field">
            <label for="smtp-pass">Contraseña:</label>
            <div class="smtp-pwd-wrap">
              <span class="smtp-input-icon">🔑</span>
              <input id="smtp-pass" v-model="smtpForm.pass" :type="showSmtpPass ? 'text' : 'password'" autocomplete="off" :placeholder="smtp.hasPass ? '••••••••' : 'Contraseña'" />
              <button type="button" class="smtp-eye" @click="showSmtpPass = !showSmtpPass" :title="showSmtpPass ? 'Ocultar' : 'Ver'">{{ showSmtpPass ? '🙈' : '👁️' }}</button>
            </div>
          </div>

          <div class="smtp-field">
            <label for="smtp-sec">Seguridad:</label>
            <select id="smtp-sec" :value="securityMode" @change="onSecurityChange(($event.target as HTMLSelectElement).value)">
              <option value="NONE">NONE</option>
              <option value="STARTTLS">STARTTLS</option>
              <option value="SSL">SSL/TLS</option>
            </select>
            <small class="smtp-sec-hint"><span class="dot-ssl">●</span> SSL=465 · <span class="dot-tls">●</span> TLS/STARTTLS=587 · <span class="dot-none">●</span> NONE=sin cifrado</small>
          </div>
          <div class="smtp-field">
            <label for="smtp-from">Remitente "From":</label>
            <input id="smtp-from" v-model="smtpForm.from" placeholder='Finanzas Mensuales <noreply@dominio.com>' />
          </div>

          <div class="smtp-field smtp-field-wide">
            <label for="smtp-url">URL pública del sistema:</label>
            <input id="smtp-url" v-model="smtpForm.publicUrl" placeholder="http://204.168.129.129 o https://finanzas.tudominio.com" />
            <small class="smtp-hint">Se usa en los correos de bienvenida para construir el enlace de login.</small>
          </div>
        </div>

        <p v-if="smtpMsg" class="hint-msg">{{ smtpMsg }}</p>
        <p v-if="smtpErr" class="error">{{ smtpErr }}</p>
        <p v-if="testResult?.ok" class="hint-msg">✓ Conexión SMTP exitosa{{ testTo ? ' y email enviado a ' + testTo : '' }}.</p>
        <p v-else-if="testResult && !testResult.ok" class="error">✗ {{ testResult.error || 'Error desconocido' }}</p>

        <div class="smtp-actions-bar">
          <input v-model="testTo" type="email" placeholder="Email para prueba (opcional)" class="smtp-test-input" />
          <button type="button" class="smtp-btn-test" :disabled="!smtp.host || !smtp.hasPass" @click="testSmtp">PROBAR CONFIGURACIÓN ➤</button>
          <button type="submit" class="smtp-btn-save" :disabled="smtpSaving">{{ smtpSaving ? 'GUARDANDO…' : 'GUARDAR 💾' }}</button>
          <button type="button" class="smtp-btn-clear" :disabled="!smtp.host || !smtp.hasPass" @click="clearSmtp" title="Eliminar configuración">🗑️</button>
        </div>
      </form>
    </div>
    </div>

    <!-- Modal acciones sobre admin del tenant -->
    <div v-if="tenantModal" class="ta-overlay" role="dialog" aria-modal="true" @click.self="closeTenantModal">
      <div class="ta-modal">
        <div class="ta-head">
          <div class="ta-head-icon" :class="tenantModal.kind === 'reset-pwd' ? 'is-key' : 'is-mail'">
            <Key v-if="tenantModal.kind === 'reset-pwd'" :size="18" />
            <Mail v-else :size="18" />
          </div>
          <div class="ta-head-text">
            <h3 v-if="tenantModal.kind === 'reset-pwd'">Restablecer contraseña</h3>
            <h3 v-else>Cambiar email del admin</h3>
            <small>Empresa: <strong>{{ tenantModal.tenant.legalName }}</strong></small>
          </div>
          <button type="button" class="icon-btn ta-close" aria-label="Cerrar" @click="closeTenantModal"><X :size="16" /></button>
        </div>

        <!-- Reset password -->
        <div v-if="tenantModal.kind === 'reset-pwd'">
          <div v-if="!resetPwdResult">
            <p class="ta-hint">
              Se restablecerá la contraseña del usuario
              <strong>{{ tenantModal.tenant.email }}</strong>
              (administrador de esta empresa). Su sesión activa quedará cerrada;
              tu sesión de Super Admin se mantiene.
            </p>

            <div class="ta-radio-group">
              <label class="ta-radio" :class="{ selected: resetPwdMode === 'random' }">
                <input type="radio" v-model="resetPwdMode" value="random" />
                <span class="ta-radio-dot" aria-hidden="true"></span>
                <span class="ta-radio-text">
                  <strong>Generar contraseña aleatoria</strong>
                  <small>Se mostrará una sola vez para copiarla.</small>
                </span>
              </label>
              <label class="ta-radio" :class="{ selected: resetPwdMode === 'manual' }">
                <input type="radio" v-model="resetPwdMode" value="manual" />
                <span class="ta-radio-dot" aria-hidden="true"></span>
                <span class="ta-radio-text">
                  <strong>Escribirla manualmente</strong>
                  <small>Mínimo 10 caracteres.</small>
                </span>
              </label>
            </div>

            <div v-if="resetPwdMode === 'manual'" class="field ta-manual-field">
              <label for="rpwd-input">Nueva contraseña</label>
              <input id="rpwd-input" v-model="resetPwdInput" type="text" autocomplete="new-password" minlength="10" placeholder="Mínimo 10 caracteres" />
            </div>

            <p v-if="resetPwdError" class="error ta-error">{{ resetPwdError }}</p>

            <div class="ta-actions">
              <button type="button" class="ghost" @click="closeTenantModal">Cancelar</button>
              <button type="button" @click="submitResetPwd" :disabled="resetPwdSubmitting">
                {{ resetPwdSubmitting ? 'Restableciendo…' : 'Restablecer contraseña' }}
              </button>
            </div>
          </div>

          <div v-else>
            <p class="ta-hint">
              Contraseña restablecida para <strong>{{ resetPwdResult.email }}</strong>.
            </p>
            <div v-if="resetPwdResult.password" class="ta-pwd-box">
              <code @click="selectPasswordText">{{ resetPwdResult.password }}</code>
              <button type="button" class="icon-btn ta-pwd-copy" @click="copyPassword" :title="resetPwdCopied ? 'Copiado' : 'Copiar'">
                <Check v-if="resetPwdCopied" :size="14" />
                <Copy v-else :size="14" />
              </button>
            </div>
            <p v-if="resetPwdResult.password" class="ta-warn">Guárdala ahora. No se volverá a mostrar.</p>
            <p v-else class="ta-hint">La contraseña que ingresaste fue aplicada correctamente.</p>
            <div class="ta-actions">
              <button type="button" @click="closeTenantModal">Cerrar</button>
            </div>
          </div>
        </div>

        <!-- Change email -->
        <div v-else-if="tenantModal.kind === 'change-email'">
          <p class="ta-hint">
            Email actual del usuario: <strong>{{ tenantModal.tenant.email }}</strong>.
            Al guardar, ese usuario deberá iniciar sesión con el nuevo email;
            tu sesión de Super Admin se mantiene.
          </p>

          <div class="field ta-manual-field">
            <label for="email-input">Nuevo email</label>
            <input id="email-input" v-model="emailInput" type="email" autocomplete="off" placeholder="nuevo@correo.com" />
          </div>

          <p v-if="emailError" class="error ta-error">{{ emailError }}</p>

          <div class="ta-actions">
            <button type="button" class="ghost" @click="closeTenantModal">Cancelar</button>
            <button type="button" @click="submitChangeEmail" :disabled="emailSubmitting">
              {{ emailSubmitting ? 'Guardando…' : 'Guardar cambio' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bank-toggle-row {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0 2px;
}
button.toggle-switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  width: 48px;
  height: 28px;
  min-width: 48px;
  border-radius: 999px;
  background: #cbd5e1;
  background-image: none;
  border: 1px solid #b1bbcb;
  cursor: pointer;
  padding: 0;
  margin: 0;
  box-shadow: inset 0 1px 2px rgba(15,23,42,0.08);
  transition: background-color 0.18s ease, border-color 0.18s ease;
  flex-shrink: 0;
  color: transparent;
  font-size: 0;
  line-height: 0;
  vertical-align: middle;
}
button.toggle-switch:hover { background: #b1bbcb; border-color: #94a3b8; }
button.toggle-switch.on { background: #2563eb; border-color: #1d4ed8; box-shadow: inset 0 1px 2px rgba(0,0,0,0.12); }
button.toggle-switch.on:hover { background: #1d4ed8; border-color: #1e40af; }
button.toggle-switch:focus-visible {
  outline: none;
  box-shadow: inset 0 1px 2px rgba(15,23,42,0.08), 0 0 0 3px rgba(37,99,235,0.22);
}
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 22px;
  height: 22px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 1px 2px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.06);
  transition: transform 0.2s cubic-bezier(.2,.7,.3,1);
}
.toggle-switch.on .toggle-knob { transform: translateX(20px); }
.toggle-label {
  font-size: 14px;
  font-weight: 600;
  color: #64748b;
  letter-spacing: -0.005em;
}
.toggle-label.on { color: #047857; }

.banks-table { table-layout: fixed; width: 100%; }
.banks-table .col-name { width: 22%; }
.banks-table .col-kind { width: 12%; }
.banks-table .col-num { width: 14%; }
.banks-table .col-status { width: 12%; }
.banks-table .col-notes { width: 26%; }
.banks-table .col-actions { width: 14%; }
.banks-table th.center, .banks-table td.center { text-align: center; }
.banks-table td { vertical-align: middle; word-break: break-word; }
.banks-table .row-actions { justify-content: center; }
@media (max-width: 1000px) {
  .banks-table { table-layout: auto; }
  .banks-table .col-name,
  .banks-table .col-kind,
  .banks-table .col-num,
  .banks-table .col-status,
  .banks-table .col-notes,
  .banks-table .col-actions { width: auto; }
}

.settings-hero {
  background: linear-gradient(135deg, #1e40af 0%, #2563eb 50%, #0891b2 100%);
  border-radius: 16px;
  padding: 28px 32px;
  color: white;
  margin-bottom: 22px;
  box-shadow: 0 12px 30px rgba(37, 99, 235, 0.22);
}

/* Empresas (SuperAdmin) — tira de estadísticas */
.tn-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin: 4px 0 18px;
}
.tn-stat {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 14px;
}
.tn-stat-icon {
  width: 40px; height: 40px;
  border-radius: 11px;
  display: grid; place-items: center;
  flex-shrink: 0;
}
.tn-stat-icon.all   { background: var(--color-primary-soft); color: var(--color-primary-active); }
.tn-stat-icon.ok    { background: var(--color-success-soft); color: var(--color-success-text); }
.tn-stat-icon.warn  { background: var(--color-warning-soft); color: var(--color-warning-text); }
.tn-stat-icon.users { background: var(--color-accent-soft); color: var(--color-accent-text); }
.tn-stat-body { display: flex; flex-direction: column; line-height: 1.1; }
.tn-stat-body strong { font-size: 22px; color: var(--color-text); font-variant-numeric: tabular-nums; }
.tn-stat-body small { font-size: 12px; color: var(--color-text-muted); }
@media (max-width: 720px) { .tn-stats { grid-template-columns: repeat(2, 1fr); } }

/* Onboarding empresas */
.tn-empty .tn-cta {
  margin-top: 6px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.hero-eyebrow {
  display: inline-block;
  font-size: 11px;
  letter-spacing: 0.18em;
  font-weight: 700;
  opacity: 0.85;
  margin-bottom: 8px;
}
.settings-hero h1 { margin: 0 0 6px; font-size: 28px; font-weight: 700; }
.settings-hero p { margin: 0; opacity: 0.92; font-size: 14px; max-width: 720px; }

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 20px;
}
.settings-card {
  display: flex !important;
  align-items: center;
  gap: 18px;
  padding: 24px 26px !important;
  background: white !important;
  border: 1px solid #e6e9ef !important;
  border-left: 4px solid var(--accent, #94a3b8) !important;
  border-radius: 16px !important;
  text-align: left;
  cursor: pointer;
  transition: box-shadow 0.18s ease, border-left-width 0.18s ease, border-color 0.18s ease;
  font: inherit !important;
  color: inherit !important;
  position: relative;
  overflow: hidden;
  min-height: 92px;
}
.settings-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--accent-bg, transparent);
  opacity: 0;
  transition: opacity 0.18s ease;
  pointer-events: none;
}
.settings-card:hover {
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.06);
  border-left-width: 6px !important;
}
.settings-card:hover::before { opacity: 0.4; }
.settings-card > * { position: relative; z-index: 1; }

.settings-card-icon {
  width: 56px; height: 56px;
  border-radius: 14px;
  background: var(--accent-bg, #f1f5f9);
  color: var(--accent, #475569);
  display: grid; place-items: center;
  flex-shrink: 0;
  border: 1px solid var(--accent-border, #e2e8f0);
}
.settings-card-icon svg { width: 28px; height: 28px; }
.settings-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.settings-card-body strong { font-size: 16.5px; color: #0f172a; font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; }
.settings-card-body span { color: #475569; font-size: 13.5px; line-height: 1.5; }
.settings-card-arrow { font-size: 24px; color: var(--accent, #94a3b8); font-weight: 700; opacity: 0.7; transition: transform 0.18s ease, opacity 0.18s ease; }
.settings-card:hover .settings-card-arrow { transform: translateX(4px); opacity: 1; }

.accent-teal { --accent: #0d9488; --accent-bg: #ccfbf1; --accent-border: #99f6e4; }
.accent-green { --accent: #16a34a; --accent-bg: #dcfce7; --accent-border: #bbf7d0; }
.accent-cyan { --accent: #0891b2; --accent-bg: #cffafe; --accent-border: #a5f3fc; }
.accent-orange { --accent: #ea580c; --accent-bg: #ffedd5; --accent-border: #fed7aa; }
.accent-purple { --accent: #7c3aed; --accent-bg: #ede9fe; --accent-border: #ddd6fe; }

@media (max-width: 900px) {
  .settings-grid { gap: 12px; grid-template-columns: 1fr; }
  .settings-card {
    padding: 14px 16px !important;
    gap: 14px;
    min-height: auto;
    height: auto !important;
    border-radius: 12px !important;
    align-items: center;
  }
  .settings-card-icon { width: 44px; height: 44px; border-radius: 11px; }
  .settings-card-icon svg { width: 22px; height: 22px; }
  .settings-card-body { gap: 4px; }
  .settings-card-body strong { font-size: 15px; line-height: 1.3; }
  .settings-card-body span {
    font-size: 12.5px;
    line-height: 1.4;
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    display: block;
  }
  .settings-card-arrow { font-size: 20px; }
  .settings-hero { padding: 18px 20px !important; margin-bottom: 14px !important; }
  .settings-hero h1 { font-size: 24px !important; }
  .settings-hero p { font-size: 13px !important; }
  .hero-eyebrow { font-size: 10px !important; }
}
.accent-red { --accent: #dc2626; --accent-bg: #fee2e2; --accent-border: #fecaca; }
.accent-gray { --accent: #475569; --accent-bg: #e2e8f0; --accent-border: #cbd5e1; }
.accent-blue { --accent: #2563eb; --accent-bg: #dbeafe; --accent-border: #bfdbfe; }
.accent-indigo { --accent: #4f46e5; --accent-bg: #e0e7ff; --accent-border: #c7d2fe; }
.accent-amber { --accent: #d97706; --accent-bg: #fef3c7; --accent-border: #fde68a; }

.section-detail { max-width: 1000px; margin: 0 auto; }
.section-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 0 16px;
  flex-wrap: wrap;
}
.section-header h1 { margin: 0; font-size: 20px; color: #0f172a; font-weight: 700; }
.section-detail .panel { max-width: 100%; }
.section-detail .row-2 { max-width: 100%; }
.back-btn {
  background: white !important;
  border: 1px solid #e2e8f0 !important;
  color: #475569 !important;
  border-radius: 999px !important;
  padding: 7px 14px !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  cursor: pointer;
  flex-shrink: 0;
}
.back-btn:hover { background: #f1f5f9 !important; color: #0f172a !important; }
.profile-meta { display: flex; gap: 24px; flex-wrap: wrap; padding: 12px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 16px; }
.profile-meta div { display: flex; flex-direction: column; gap: 2px; }
.profile-meta small { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.profile-meta strong { color: #0f172a; font-size: 14px; }
.profile-section-divider { padding: 12px 0; border-top: 1px solid #e2e8f0; margin-top: 8px; }
.form-submit-row { display: flex; justify-content: flex-end; padding-top: 8px; }
.form-submit-row button { min-width: 160px; }
.profile-section-divider strong { display: block; font-size: 14px; color: #0f172a; margin-bottom: 2px; }
.profile-section-divider small { color: #64748b; font-size: 12px; }
.actions-row { display: flex; gap: 8px; }
/* .actions-row .ghost: usar valores globales de style.css (padding 9px 18px / font-size 14px) */
.row-actions { display: flex; gap: 4px; justify-content: flex-end; }
/* .row-actions button.mini: usar valores globales de style.css (font-size 13px / padding 6px 11px) */
.row-actions button.mini { background: white; border: 1px solid #e2e8f0; color: #475569; border-radius: 6px; cursor: pointer; }
.row-actions button.mini:hover:not(:disabled) { background: #f8fafc; }
.row-actions button.mini:disabled { opacity: 0.4; cursor: not-allowed; }
.row-actions button.mini.danger { color: #dc2626; border-color: #fecaca; }
.row-actions button.mini.danger:hover { background: #fef2f2; }
/* .field, .field label, .field .hint, .field-group: usar valores globales de style.css */
.field { flex: 1; min-width: 0; }
.required-mark { color: #ef4444; font-weight: 700; }
.check-field .inline-check { display: flex; align-items: center; gap: 8px; color: #1f2937; cursor: pointer; padding: 8px 0; }
.tab-filter { display: flex; gap: 6px; margin-top: 16px; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px; }
.tab-filter-btn { background: transparent; border: 1px solid #e5e7eb; border-radius: 999px; padding: 5px 14px; font-size: 13px; font-weight: 600; cursor: pointer; color: #475569; transition: all .15s ease; }
.tab-filter-btn:hover { background: #f1f5f9; border-color: #cbd5e1; }
.tab-filter-btn.active { background: #0f172a; color: #fff; border-color: #0f172a; }

/* Identidad */
.identity-block { display: flex; align-items: center; gap: 18px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; }
.identity-logo-preview { width: 88px; height: 88px; flex-shrink: 0; border-radius: 14px; background: #fff; border: 1px solid #e2e8f0; display: grid; place-items: center; overflow: hidden; }
.identity-logo-preview img { max-width: 100%; max-height: 100%; object-fit: contain; }
.identity-logo-empty { color: #cbd5e1; }
.identity-logo-actions { display: flex; flex-direction: column; gap: 2px; }
.identity-logo-btns { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.color-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.color-input { width: 46px; height: 38px; padding: 2px; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; background: #fff; }
.color-hex { width: 96px; text-transform: uppercase; }
.color-presets { display: flex; gap: 6px; flex-wrap: wrap; }
.color-dot { width: 24px; height: 24px; border-radius: 999px; border: 2px solid #fff; box-shadow: 0 0 0 1px #e2e8f0; cursor: pointer; padding: 0; transition: transform .1s ease; }
.color-dot:hover { transform: scale(1.15); }

/* Respaldos */
.backup-cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
.backup-card { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; border: 1px solid #e2e8f0; border-radius: 14px; padding: 18px; background: #fff; }
.backup-ic { width: 44px; height: 44px; display: grid; place-items: center; border-radius: 12px; background: #ecfdf5; color: #059669; }
.backup-ic.up { background: #eff6ff; color: #2563eb; }
.backup-card strong { font-size: 15px; color: #0f172a; }
.backup-card small { font-size: 12.5px; color: #64748b; }
.backup-card button { margin-top: 6px; }
.backup-file { display: none; }
.backup-note { margin-top: 18px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 12px 14px; }
.backup-note strong { color: #92400e; font-size: 13px; }
.backup-note p { color: #b45309; font-size: 12.5px; margin: 4px 0 0; }
@media (max-width: 640px) { .backup-cards { grid-template-columns: 1fr; } }
.color-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; vertical-align: middle; border: 1px solid rgba(0,0,0,0.1); }
.cat-icon-text { display: inline-block; margin-right: 6px; color: #6b7280; font-size: 12px; }
.icon-trigger {
  display: inline-flex !important;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 360px;
  height: 44px;
  padding: 0 12px !important;
  background: white !important;
  border: 1px solid #e2e8f0 !important;
  border-radius: 10px !important;
  cursor: pointer;
  font: inherit;
  color: var(--color-text);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  text-align: left;
}
.icon-trigger:hover { border-color: #cbd5e1 !important; }
.icon-trigger.open { border-color: var(--color-primary) !important; box-shadow: 0 0 0 3px rgba(16,185,129,0.15); }
.icon-trigger-preview {
  width: 32px; height: 32px;
  display: grid; place-items: center;
  font-size: 20px;
  background: var(--color-surface-3);
  border-radius: 8px;
}
.icon-trigger-text { flex: 1; font-size: 14px; font-weight: 500; color: var(--color-text-soft); }
.icon-trigger-chevron { color: var(--color-text-muted); font-size: 12px; }

.icon-picker-wrap {
  margin-top: 8px;
  padding: 12px;
  background: white;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: var(--shadow-md);
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.icon-search {
  height: 38px !important;
  font-size: 14px !important;
  padding: 0 12px !important;
  border-radius: 8px !important;
}
.icon-picker-scroll { max-height: 340px; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; gap: 12px; }
.icon-picker-scroll::-webkit-scrollbar { width: 6px; }
.icon-picker-scroll::-webkit-scrollbar-thumb { background: var(--color-border-strong); border-radius: 999px; }
.icon-group { display: flex; flex-direction: column; gap: 6px; }
.icon-group-header {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 2px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.icon-group-count {
  background: var(--color-surface-3);
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 999px;
  letter-spacing: 0;
}
.icon-picker { display: grid; grid-template-columns: repeat(auto-fill, minmax(46px, 1fr)); gap: 6px; }
.icon-option { width: 100%; aspect-ratio: 1; display: grid; place-items: center; background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: 8px; cursor: pointer; font-size: 22px; transition: all 0.12s; padding: 0; }
.icon-option:hover { background: #eff6ff; border-color: #bfdbfe; }
.icon-option.selected { background: var(--color-primary-soft); border-color: var(--color-primary); box-shadow: var(--shadow-focus); }
.icon-empty { grid-column: 1 / -1; text-align: center; padding: 20px; color: var(--color-text-muted); font-size: 13px; }
.icon-picker-actions { display: flex; justify-content: flex-end; padding-top: 4px; border-top: 1px solid var(--color-border-soft); }
.icon-picker-actions .ghost { height: 32px; padding: 0 12px; font-size: 13px; }
.info-text { color: #64748b; font-size: 13px; line-height: 1.5; margin-bottom: 16px; }
.smtp-card { background: white; border: 1px solid #e6e9ef; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 12px rgba(15,23,42,0.04); }
.smtp-banner { background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: white; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
.smtp-banner h3 { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.smtp-status-pill { font-size: 12px; padding: 4px 12px; border-radius: 999px; font-weight: 600; background: rgba(255,255,255,0.25); border: 1px solid rgba(255,255,255,0.4); }
.smtp-status-pill.ok { background: rgba(16,185,129,0.25); border-color: rgba(167,243,208,0.6); }
.smtp-status-pill.warn { background: rgba(245,158,11,0.25); border-color: rgba(253,230,138,0.6); }
.smtp-form { padding: 22px 24px; }
.smtp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; margin-bottom: 16px; }
.smtp-field { display: grid; grid-template-columns: 130px 1fr; align-items: center; gap: 10px; }
.smtp-field-wide { grid-column: 1 / -1; }
.smtp-field > label { font-size: 13px; color: #475569; font-weight: 600; text-align: right; }
.smtp-field input, .smtp-field select { padding: 7px 11px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px; height: 34px; }
.smtp-field input:focus, .smtp-field select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
.smtp-pwd-wrap { position: relative; display: flex; align-items: center; }
.smtp-pwd-wrap input { padding-left: 32px; padding-right: 36px; flex: 1; }
.smtp-input-icon { position: absolute; left: 10px; font-size: 13px; color: #94a3b8; pointer-events: none; }
.smtp-eye { position: absolute; right: 6px; background: transparent; border: 0; cursor: pointer; font-size: 14px; padding: 4px; line-height: 1; }
.smtp-sec-hint { grid-column: 2; font-size: 11px; color: #64748b; margin-top: 2px; line-height: 1.4; }
.smtp-sec-hint .dot-ssl { color: #ef4444; }
.smtp-sec-hint .dot-tls { color: #2563eb; }
.smtp-sec-hint .dot-none { color: #94a3b8; }
.smtp-hint { grid-column: 2; font-size: 11px; color: #94a3b8; margin-top: 2px; }

.smtp-actions-bar { display: flex; gap: 10px; align-items: center; padding-top: 14px; border-top: 1px solid #e6e9ef; flex-wrap: wrap; }
.smtp-test-input { flex: 1; min-width: 200px; padding: 7px 11px; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 13px; height: 34px; }
.smtp-btn-test, .smtp-btn-save, .smtp-btn-clear { padding: 8px 18px !important; border-radius: 999px !important; font-size: 12px !important; font-weight: 700 !important; letter-spacing: 0.04em !important; cursor: pointer; transition: all 0.15s; }
.smtp-btn-test { background: white !important; color: #2563eb !important; border: 1.5px solid #2563eb !important; }
.smtp-btn-test:hover:not(:disabled) { background: #2563eb !important; color: white !important; }
.smtp-btn-save { background: white !important; color: #0f172a !important; border: 1.5px solid #0f172a !important; }
.smtp-btn-save:hover:not(:disabled) { background: #0f172a !important; color: white !important; }
.smtp-btn-clear { background: white !important; color: #dc2626 !important; border: 1.5px solid #fecaca !important; padding: 8px 14px !important; }
.smtp-btn-clear:hover:not(:disabled) { background: #fef2f2 !important; }
.smtp-btn-test:disabled, .smtp-btn-save:disabled, .smtp-btn-clear:disabled { opacity: 0.4 !important; cursor: not-allowed; }

.smtp-test-card { display: none; }
.smtp-test-card strong { display: block; margin-bottom: 4px; color: #0f172a; }
.smtp-test-card p { color: #64748b; font-size: 13px; margin: 0 0 12px; }
.smtp-test-action { justify-content: flex-end; display: flex; flex-direction: column; }
.smtp-test-action button { padding: 10px 16px; }
.pill-active { background: #ecfdf5; color: #047857; }
.pill-warn { background: #fff7ed; color: #c2410c; }
button[type=submit]:disabled, .ghost:disabled { opacity: 0.5; cursor: not-allowed; }

/* ------- Modal acciones admin tenant ------- */
.ta-overlay {
  position: fixed; inset: 0;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  z-index: 1000;
  animation: ta-fade-in 140ms ease-out;
}
@keyframes ta-fade-in { from { opacity: 0; } to { opacity: 1; } }
.ta-modal {
  width: 100%; max-width: 460px;
  background: #ffffff;
  border-radius: 16px;
  padding: 20px 22px 18px;
  box-shadow: 0 30px 60px -20px rgba(0,0,0,0.35);
  border: 1px solid #e2e8f0;
  animation: ta-pop 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes ta-pop { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }

.ta-head {
  display: flex; align-items: flex-start; gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f1f5f9;
  margin-bottom: 16px;
}
.ta-head-icon {
  width: 40px; height: 40px;
  border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.ta-head-icon.is-key { background: rgba(245, 158, 11, 0.14); color: #d97706; }
.ta-head-icon.is-mail { background: rgba(37, 99, 235, 0.12); color: #2563eb; }
.ta-head-text { flex: 1; min-width: 0; padding-top: 2px; }
.ta-head-text h3 { margin: 0; font-size: 16px; line-height: 1.2; color: #0f172a; font-weight: 600; }
.ta-head-text small { display: block; margin-top: 4px; font-size: 12.5px; color: #64748b; }
.ta-head-text small strong { color: #334155; font-weight: 600; }

.ta-close.icon-btn {
  width: 32px !important; height: 32px !important;
  padding: 0 !important;
  border-radius: 8px !important;
  background: transparent !important;
  border: 0 !important;
  color: #94a3b8 !important;
  flex-shrink: 0;
}
.ta-close.icon-btn:hover { background: #f1f5f9 !important; color: #0f172a !important; border-color: transparent !important; }

.ta-hint { color: #475569; font-size: 13px; line-height: 1.55; margin: 0 0 14px; }
.ta-hint strong { color: #0f172a; font-weight: 600; }
.ta-warn {
  display: flex; align-items: center; gap: 8px;
  color: #92400e; background: #fffbeb; border: 1px solid #fde68a;
  padding: 10px 12px; border-radius: 8px; font-size: 13px;
  margin: 12px 0 0;
}
.ta-warn::before { content: '⚠'; font-size: 14px; }
.ta-error { margin: 10px 0 0; font-size: 13px; }

.ta-radio-group { display: flex; flex-direction: column; gap: 8px; margin: 6px 0 0; }
.ta-radio {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
  position: relative;
}
.ta-radio:hover { border-color: #cbd5e1; background: #f8fafc; }
.ta-radio.selected {
  border-color: #2563eb;
  background: #eff6ff;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.08);
}
.ta-radio input[type="radio"] {
  position: absolute; opacity: 0; pointer-events: none;
  width: 0 !important; height: 0 !important;
}
.ta-radio-dot {
  width: 18px; height: 18px;
  border-radius: 50%;
  border: 2px solid #cbd5e1;
  background: #ffffff;
  flex-shrink: 0;
  position: relative;
  transition: border-color 140ms ease;
}
.ta-radio.selected .ta-radio-dot { border-color: #2563eb; }
.ta-radio.selected .ta-radio-dot::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: #2563eb;
}
.ta-radio-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ta-radio-text strong { font-size: 14px; color: #0f172a; font-weight: 600; line-height: 1.3; }
.ta-radio-text small { font-size: 12.5px; color: #64748b; line-height: 1.4; }

.ta-manual-field { margin-top: 14px; }
.ta-manual-field label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: #334155; }
.ta-manual-field input { width: 100%; }

.ta-pwd-box {
  display: flex; align-items: center; gap: 8px;
  background: #0f172a; color: #f1f5f9;
  padding: 12px 14px;
  border-radius: 10px;
  margin: 10px 0 4px;
}
.ta-pwd-box code {
  flex: 1;
  font-family: 'JetBrains Mono', 'Fira Code', Menlo, monospace;
  font-size: 14px;
  letter-spacing: 0.02em;
  word-break: break-all;
  cursor: text;
  user-select: all;
}
.ta-pwd-copy.icon-btn {
  width: 32px !important; height: 32px !important;
  padding: 0 !important;
  border-radius: 8px !important;
  background: rgba(255,255,255,0.08) !important;
  border: 1px solid rgba(255,255,255,0.16) !important;
  color: #f1f5f9 !important;
  flex-shrink: 0;
}
.ta-pwd-copy.icon-btn:hover { background: rgba(255,255,255,0.16) !important; border-color: rgba(255,255,255,0.24) !important; color: #ffffff !important; }

.ta-actions {
  display: flex; justify-content: flex-end; gap: 8px;
  margin-top: 20px; padding-top: 14px;
  border-top: 1px solid #f1f5f9;
}
</style>

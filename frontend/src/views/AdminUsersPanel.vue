<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { http } from '../api/http';
import { useAuthStore, type Permissions, type ModuleName, type PermissionLevel } from '../stores/auth';

type SystemRole = 'ADMIN_EMPRESA' | 'USUARIO_EMPRESA';
const ROLE_LABEL: Record<SystemRole, string> = { ADMIN_EMPRESA: 'Administrador', USUARIO_EMPRESA: 'Usuario normal' };

interface UserRow {
  id: number;
  name: string;
  username: string | null;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  role: SystemRole;
  isActive: boolean;
  permissions: Permissions;
  createdAt: string;
  updatedAt: string;
  _count?: { accounts: number; movements: number; debts: number };
}

interface RoleTemplate {
  id: number;
  name: string;
  description: string | null;
  permissions: Permissions;
  isBuiltIn: boolean;
}

interface CreateResponse {
  user: UserRow;
  mail: { sent: boolean; error: string | null; configured: boolean };
  initialPassword: string | null;
}

const auth = useAuthStore();
const users = ref<UserRow[]>([]);
const rolesTpl = ref<RoleTemplate[]>([]);
const mailerConfigured = ref(false);
const errorMsg = ref('');
const successMsg = ref('');
const lastCreated = ref<CreateResponse | null>(null);
const saving = ref(false);

// Modal state
const modalOpen = ref(false);
const editingId = ref<number | null>(null);

// Search + columns
const searchQuery = ref('');
const allColumns = ['acciones', 'foto', 'nombre', 'usuario', 'email', 'celular', 'rol', 'estado'] as const;
type ColKey = typeof allColumns[number];
const visibleColumns = ref<ColKey[]>([...allColumns]);
const columnsDropdownOpen = ref(false);
const COLUMN_LABEL: Record<ColKey, string> = {
  acciones: 'Acciones', foto: 'Foto', nombre: 'Nombre', usuario: 'Usuario',
  email: 'Email', celular: 'Celular', rol: 'Rol', estado: 'Estado'
};

const DEFAULT_PERMS: Permissions = {
  movements: 'edit', accounts: 'edit', cards: 'edit',
  debts: 'edit', recurrings: 'edit', invoices: 'edit', reports: 'view'
};

const MODULES: Array<{ key: ModuleName; label: string; icon: string }> = [
  { key: 'movements', label: 'Movimientos', icon: '🔁' },
  { key: 'accounts', label: 'Cuentas', icon: '🏛️' },
  { key: 'cards', label: 'Tarjetas', icon: '💳' },
  { key: 'debts', label: 'Deudas / Préstamos', icon: '🏦' },
  { key: 'recurrings', label: 'Recurrentes', icon: '🔂' },
  { key: 'invoices', label: 'Facturas / IVA', icon: '🧾' },
  { key: 'reports', label: 'Reportes', icon: '📊' }
];

const LEVEL_LABEL: Record<PermissionLevel, string> = { edit: 'Editar', view: 'Ver', none: 'Sin acceso' };

const emptyForm = () => ({
  name: '', username: '', email: '', phone: '',
  password: '', confirmPassword: '',
  role: 'USUARIO_EMPRESA' as SystemRole,
  roleTemplateId: null as number | null,
  permissions: { ...DEFAULT_PERMS } as Permissions,
  isActive: true,
  avatarUrl: '',
  sendEmail: true
});

const form = ref(emptyForm());
const expandedModule = ref<ModuleName | null>(null);

const checks = computed(() => ({
  length: form.value.password.length >= 10,
  upper: /[A-Z]/.test(form.value.password),
  lower: /[a-z]/.test(form.value.password),
  number: /[0-9]/.test(form.value.password),
  symbol: /[^A-Za-z0-9]/.test(form.value.password)
}));
const allOk = computed(() => Object.values(checks.value).every(Boolean));
const passwordsMatch = computed(() => !form.value.password || form.value.password === form.value.confirmPassword);
const isCreating = computed(() => editingId.value === null);
const canSubmit = computed(() => {
  if (saving.value) return false;
  if (!form.value.name.trim() || !form.value.email.includes('@')) return false;
  if (isCreating.value && (!allOk.value || !passwordsMatch.value)) return false;
  if (!isCreating.value && form.value.password && (!allOk.value || !passwordsMatch.value)) return false;
  return true;
});

const filteredUsers = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return users.value;
  return users.value.filter((u) =>
    u.name.toLowerCase().includes(q) ||
    u.email.toLowerCase().includes(q) ||
    (u.username || '').toLowerCase().includes(q) ||
    (u.phone || '').toLowerCase().includes(q)
  );
});

function isColVisible(c: ColKey) { return visibleColumns.value.includes(c); }
function toggleColumn(c: ColKey) {
  if (visibleColumns.value.includes(c)) {
    visibleColumns.value = visibleColumns.value.filter((x) => x !== c);
  } else {
    visibleColumns.value = [...visibleColumns.value, c];
  }
}

const formatDate = (iso: string) => {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso)); }
  catch { return iso; }
};

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const num = '23456789';
  const sym = '!@#$%&*?-_';
  const all = upper + lower + num + sym;
  const pick = (s: string) => s.charAt(Math.floor(Math.random() * s.length));
  // Garantiza al menos uno de cada tipo (incluido símbolo, que el backend exige).
  let pwd = pick(upper) + pick(lower) + pick(num) + pick(sym);
  while (pwd.length < 12) pwd += pick(all);
  // Mezcla para que el símbolo no quede siempre en la misma posición
  pwd = pwd.split('').sort(() => Math.random() - 0.5).join('');
  form.value.password = pwd;
  form.value.confirmPassword = pwd;
}

function applyTemplate(templateId: number | null) {
  form.value.roleTemplateId = templateId;
  if (templateId === null) return;
  const tpl = rolesTpl.value.find((r) => r.id === templateId);
  if (tpl) form.value.permissions = { ...DEFAULT_PERMS, ...tpl.permissions };
}

function avatarText(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '?';
}

function activePermsCount(perms: Permissions): number {
  return MODULES.filter((m) => perms[m.key] !== 'none').length;
}

function levelBadge(level: PermissionLevel): string {
  if (level === 'edit') return 'Editor';
  if (level === 'view') return 'Solo ver';
  return 'Sin acceso';
}

async function load() {
  errorMsg.value = '';
  const [usersRes, rolesRes] = await Promise.allSettled([
    http.get<{ users: UserRow[]; mailerConfigured: boolean }>('/admin/users'),
    http.get<RoleTemplate[] | { roles: RoleTemplate[] }>('/admin/roles')
  ]);
  if (usersRes.status === 'fulfilled') {
    users.value = usersRes.value.data.users;
    mailerConfigured.value = usersRes.value.data.mailerConfigured;
  } else {
    const err = usersRes.reason as { response?: { data?: { message?: string } } };
    errorMsg.value = err?.response?.data?.message || 'No se pudieron cargar los usuarios.';
  }
  if (rolesRes.status === 'fulfilled') {
    const body = rolesRes.value.data;
    rolesTpl.value = Array.isArray(body) ? body : (body?.roles ?? []);
  } else {
    rolesTpl.value = [];
  }
}

function openCreate() {
  editingId.value = null;
  form.value = emptyForm();
  expandedModule.value = null;
  modalOpen.value = true;
}

function openEdit(u: UserRow) {
  editingId.value = u.id;
  form.value = {
    name: u.name,
    username: u.username || '',
    email: u.email,
    phone: u.phone || '',
    password: '',
    confirmPassword: '',
    role: u.role,
    roleTemplateId: null,
    permissions: { ...DEFAULT_PERMS, ...u.permissions },
    isActive: u.isActive,
    avatarUrl: u.avatarUrl || '',
    sendEmail: false
  };
  expandedModule.value = null;
  modalOpen.value = true;
}

function closeModal() {
  modalOpen.value = false;
  editingId.value = null;
  form.value = emptyForm();
}

async function submitForm() {
  errorMsg.value = ''; successMsg.value = ''; saving.value = true;
  try {
    const payload: Record<string, unknown> = {
      name: form.value.name.trim(),
      username: form.value.username.trim() || null,
      email: form.value.email.trim(),
      phone: form.value.phone.trim() || null,
      avatarUrl: form.value.avatarUrl || null,
      role: form.value.role,
      permissions: form.value.permissions
    };
    if (form.value.password) payload.password = form.value.password;
    if (isCreating.value) {
      payload.sendEmail = form.value.sendEmail;
      const { data } = await http.post<CreateResponse>('/admin/users', payload);
      lastCreated.value = data;
      successMsg.value = `Usuario ${data.user.email} creado correctamente.`;
    } else {
      payload.isActive = form.value.isActive;
      await http.put(`/admin/users/${editingId.value}`, payload);
      successMsg.value = 'Usuario actualizado.';
    }
    closeModal();
    await load();
    setTimeout(() => (successMsg.value = ''), 3000);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    errorMsg.value = err?.response?.data?.message || 'No se pudo guardar el usuario.';
  } finally { saving.value = false; }
}

async function changeRole(u: UserRow, newRole: SystemRole) {
  if (u.id === auth.user?.id || u.role === newRole) return;
  if (!confirm(`¿Cambiar el rol de ${u.email} a "${ROLE_LABEL[newRole] || newRole}"?`)) return;
  try {
    await http.put(`/admin/users/${u.id}`, { role: newRole });
    await load();
    successMsg.value = 'Rol actualizado.';
    setTimeout(() => (successMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    errorMsg.value = err?.response?.data?.message || 'No se pudo cambiar el rol.';
  }
}

async function toggleActive(u: UserRow) {
  if (u.id === auth.user?.id) return;
  try { await http.put(`/admin/users/${u.id}`, { isActive: !u.isActive }); await load(); }
  catch { errorMsg.value = 'No se pudo cambiar el estado.'; }
}

async function removeUser(u: UserRow) {
  if (u.id === auth.user?.id) return;
  if (!confirm(`¿Eliminar a ${u.email} y TODOS sus datos? No se puede deshacer.`)) return;
  try {
    await http.delete(`/admin/users/${u.id}`);
    successMsg.value = 'Usuario eliminado.';
    await load();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    errorMsg.value = err?.response?.data?.message || 'No se pudo eliminar.';
  }
}

function onAvatarUpload(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5_000_000) { errorMsg.value = 'La imagen no puede pesar más de 5 MB.'; return; }
  if (!file.type.startsWith('image/')) { errorMsg.value = 'El archivo debe ser una imagen.'; return; }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || '');
    const img = new Image();
    img.onload = () => {
      const MAX_SIZE = 256;
      const ratio = Math.min(1, MAX_SIZE / Math.max(img.width, img.height));
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { form.value.avatarUrl = dataUrl; return; }
      ctx.drawImage(img, 0, 0, w, h);
      // calidad 0.85 jpeg para que pese poco; si la imagen original tenía transparencia, usa png
      const out = file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
      form.value.avatarUrl = out;
    };
    img.onerror = () => { form.value.avatarUrl = dataUrl; };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

function clearAvatar() { form.value.avatarUrl = ''; }

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && modalOpen.value) closeModal();
}

watch(modalOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : '';
});

onMounted(() => {
  load();
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.body.style.overflow = '';
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div>
    <p v-if="errorMsg" class="banner-error">{{ errorMsg }}</p>
    <p v-if="successMsg" class="banner-success">{{ successMsg }}</p>

    <div v-if="lastCreated && lastCreated.initialPassword" class="password-banner">
      <div>
        <strong>⚠️ Anota la contraseña inicial — no se mostrará de nuevo</strong>
        <p>Email: <code>{{ lastCreated.user.email }}</code></p>
        <p>Password: <code class="password-shown">{{ lastCreated.initialPassword }}</code></p>
      </div>
      <button class="btn-ghost" @click="lastCreated = null">Cerrar</button>
    </div>

    <div class="users-toolbar">
      <button type="button" class="btn-create" @click="openCreate">+ CREAR USUARIO</button>

      <div class="dropdown" :class="{ open: columnsDropdownOpen }">
        <button type="button" class="btn-ghost-light" @click="columnsDropdownOpen = !columnsDropdownOpen">
          OCULTAR COLUMNAS ▾
        </button>
        <div v-if="columnsDropdownOpen" class="dropdown-menu" @click.stop>
          <label v-for="c in allColumns" :key="c" class="dropdown-item">
            <input type="checkbox" :checked="isColVisible(c)" @change="toggleColumn(c)" />
            {{ COLUMN_LABEL[c] }}
          </label>
        </div>
      </div>

      <div class="search-wrap">
        <input v-model="searchQuery" type="text" placeholder="Buscar..." />
        <span class="search-icon">🔍</span>
      </div>
    </div>

    <div class="users-table-wrap">
      <table class="users-table">
        <thead>
          <tr>
            <th v-if="isColVisible('acciones')">ACCIONES</th>
            <th v-if="isColVisible('foto')">FOTO</th>
            <th v-if="isColVisible('nombre')">NOMBRE</th>
            <th v-if="isColVisible('usuario')">USUARIO</th>
            <th v-if="isColVisible('email')">EMAIL</th>
            <th v-if="isColVisible('celular')">CELULAR</th>
            <th v-if="isColVisible('rol')">ROL</th>
            <th v-if="isColVisible('estado')">ESTADO</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!filteredUsers.length">
            <td :colspan="visibleColumns.length" class="empty-row">No se encontró ningún resultado</td>
          </tr>
          <tr v-for="u in filteredUsers" :key="u.id">
            <td v-if="isColVisible('acciones')">
              <div class="row-actions">
                <button type="button" class="icon-btn" title="Editar" @click="openEdit(u)">✏️</button>
                <button type="button" class="icon-btn danger" title="Eliminar" :disabled="u.id === auth.user?.id" @click="removeUser(u)">🗑️</button>
              </div>
            </td>
            <td v-if="isColVisible('foto')">
              <div class="avatar-cell">
                <img v-if="u.avatarUrl" :src="u.avatarUrl" :alt="u.name" />
                <div v-else class="avatar-fallback">{{ avatarText(u.name) }}</div>
              </div>
            </td>
            <td v-if="isColVisible('nombre')"><strong>{{ u.name }}</strong></td>
            <td v-if="isColVisible('usuario')"><span class="cell-mono">{{ u.username || '—' }}</span></td>
            <td v-if="isColVisible('email')">{{ u.email }}</td>
            <td v-if="isColVisible('celular')">{{ u.phone || '—' }}</td>
            <td v-if="isColVisible('rol')">
              <select class="role-select-inline" :class="`role-${u.role.toLowerCase()}`"
                      :disabled="u.id === auth.user?.id"
                      :value="u.role"
                      @change="changeRole(u, ($event.target as HTMLSelectElement).value as SystemRole)">
                <option value="USUARIO_EMPRESA">👤 Usuario normal</option>
                <option value="ADMIN_EMPRESA">🔧 Administrador</option>
              </select>
            </td>
            <td v-if="isColVisible('estado')">
              <button type="button" class="status-pill" :class="u.isActive ? 'active' : 'inactive'"
                      :disabled="u.id === auth.user?.id"
                      @click="toggleActive(u)">
                {{ u.isActive ? '● Activo' : '○ Inactivo' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Modal Create/Edit -->
    <div v-if="modalOpen" class="modal-overlay" @click.self="closeModal">
      <div class="modal-shell">
        <div class="modal-header">
          <h2>{{ isCreating ? 'Crear nuevo usuario' : `Editar usuario: ${form.name}` }}</h2>
          <button type="button" class="icon-btn" @click="closeModal" title="Cerrar">✕</button>
        </div>

        <form class="modal-body" @submit.prevent="submitForm">
          <div class="modal-cols">
            <!-- Columna izquierda -->
            <div class="col-left">
              <section class="section-block">
                <h3>Datos:</h3>
                <div class="field-row">
                  <label>Nombre:</label>
                  <input v-model="form.name" required maxlength="80" placeholder="Ej. Juan Pérez" />
                </div>
                <div class="field-row">
                  <label>Usuario:</label>
                  <input v-model="form.username" maxlength="40" placeholder="ej. juanp" />
                </div>
                <div class="field-row">
                  <label>Email:</label>
                  <input v-model="form.email" type="email" required maxlength="120" placeholder="usuario@dominio.com" />
                </div>
                <div class="field-row">
                  <label>Teléfono móvil:</label>
                  <input v-model="form.phone" maxlength="20" placeholder="0999123456" />
                  <small class="char-counter">{{ (form.phone || '').length }} / 20</small>
                </div>
              </section>

              <section class="section-block">
                <h3>Configuración:</h3>
                <div class="field-row">
                  <label>Rol:</label>
                  <select v-model="form.role">
                    <option value="USUARIO_EMPRESA">👤 Usuario normal</option>
                    <option value="ADMIN_EMPRESA">🔧 Administrador</option>
                  </select>
                </div>
                <div v-if="form.role === 'USUARIO_EMPRESA' && rolesTpl.length" class="field-row">
                  <label>Plantilla:</label>
                  <select :value="form.roleTemplateId"
                          @change="applyTemplate(($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : null)">
                    <option :value="''">Permisos personalizados</option>
                    <option v-for="r in rolesTpl" :key="r.id" :value="r.id">{{ r.isBuiltIn ? '🛡️ ' : '' }}{{ r.name }}</option>
                  </select>
                </div>
                <div v-if="!isCreating" class="field-row">
                  <label>Estado:</label>
                  <select v-model="form.isActive">
                    <option :value="true">Activo</option>
                    <option :value="false">Inactivo</option>
                  </select>
                </div>
                <div class="field-row avatar-row">
                  <label>Foto:</label>
                  <div class="avatar-control">
                    <div class="avatar-preview">
                      <img v-if="form.avatarUrl" :src="form.avatarUrl" alt="" />
                      <div v-else class="avatar-fallback large">{{ avatarText(form.name || '?') }}</div>
                    </div>
                    <div class="avatar-input">
                      <input type="file" accept="image/*" @change="onAvatarUpload" id="avatar-upload" class="visually-hidden" />
                      <label for="avatar-upload" class="file-input-label">🖼️ {{ form.avatarUrl ? 'Cambiar imagen' : 'Cargar imagen' }}</label>
                      <button v-if="form.avatarUrl" type="button" class="btn-link" @click="clearAvatar">Quitar</button>
                    </div>
                  </div>
                </div>

              </section>

              <section class="section-block">
                <h3>{{ isCreating ? 'Contraseña:' : 'Cambiar contraseña (opcional):' }}</h3>
                <div class="field-row">
                  <label>Contraseña:</label>
                  <div class="pwd-row-modal">
                    <input v-model="form.password" type="text" :required="isCreating" placeholder="" />
                    <button type="button" class="btn-pwd" @click="generatePassword">↻</button>
                  </div>
                </div>
                <div class="field-row">
                  <label>Confirmar clave:</label>
                  <input v-model="form.confirmPassword" type="text" :required="isCreating || !!form.password" placeholder="" />
                </div>
                <ul v-if="form.password" class="checks-modal">
                  <li :class="checks.length ? 'met' : 'unmet'">{{ checks.length ? '✓' : '○' }} Mínimo 10 caracteres</li>
                  <li :class="checks.upper ? 'met' : 'unmet'">{{ checks.upper ? '✓' : '○' }} Una mayúscula</li>
                  <li :class="checks.lower ? 'met' : 'unmet'">{{ checks.lower ? '✓' : '○' }} Una minúscula</li>
                  <li :class="checks.number ? 'met' : 'unmet'">{{ checks.number ? '✓' : '○' }} Un número</li>
                  <li :class="checks.symbol ? 'met' : 'unmet'">{{ checks.symbol ? '✓' : '○' }} Un símbolo (ej. !@#$)</li>
                  <li :class="passwordsMatch ? 'met' : 'unmet'">{{ passwordsMatch ? '✓' : '○' }} Las contraseñas coinciden</li>
                </ul>

                <label v-if="isCreating" class="send-email-row" :class="{ disabled: !mailerConfigured }">
                  <input type="checkbox" v-model="form.sendEmail" :disabled="!mailerConfigured" />
                  <span>{{ mailerConfigured ? 'Enviar credenciales por correo al usuario' : 'SMTP no configurado — la contraseña se mostrará al admin' }}</span>
                </label>
              </section>
            </div>

            <!-- Columna derecha: Permisos -->
            <div class="col-right">
              <h3 class="permissions-title">Permisos:</h3>
              <p v-if="form.role === 'ADMIN_EMPRESA'" class="permissions-disabled-note">
                Los administradores tienen acceso total a todos los módulos. La matriz de permisos solo aplica a "Usuario normal".
              </p>
              <div v-else class="permissions-list">
                <div v-for="m in MODULES" :key="m.key" class="perm-module">
                  <button type="button" class="perm-module-header" @click="expandedModule = expandedModule === m.key ? null : m.key">
                    <span class="perm-icon-wrap">{{ m.icon }}</span>
                    <span class="perm-name">{{ m.label }}</span>
                    <span class="perm-status" :class="form.permissions[m.key]">{{ levelBadge(form.permissions[m.key]) }}</span>
                    <span class="perm-chevron">{{ expandedModule === m.key ? '▴' : '▾' }}</span>
                  </button>
                  <div v-if="expandedModule === m.key" class="perm-module-body">
                    <label class="perm-radio">
                      <input type="radio" :name="'perm-'+m.key" value="edit" v-model="form.permissions[m.key]" />
                      <span class="perm-text"><strong>Editar</strong><em>crear, modificar y eliminar</em></span>
                    </label>
                    <label class="perm-radio">
                      <input type="radio" :name="'perm-'+m.key" value="view" v-model="form.permissions[m.key]" />
                      <span class="perm-text"><strong>Ver</strong><em>solo lectura</em></span>
                    </label>
                    <label class="perm-radio">
                      <input type="radio" :name="'perm-'+m.key" value="none" v-model="form.permissions[m.key]" />
                      <span class="perm-text"><strong>Sin acceso</strong><em>el módulo se oculta</em></span>
                    </label>
                  </div>
                </div>

                <div class="permissions-summary">
                  <strong>{{ activePermsCount(form.permissions) }} / {{ MODULES.length }}</strong> módulos con acceso
                </div>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button type="button" class="btn-ghost-light" @click="closeModal">Cancelar</button>
            <button type="submit" class="btn-create" :disabled="!canSubmit">
              {{ saving ? 'Guardando…' : isCreating ? '+ Crear usuario' : 'Guardar cambios' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.banner-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; }
.banner-success { background: #ecfdf5; border: 1px solid #a7f3d0; color: #047857; padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; }

.password-banner { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; background: #fff7ed; border: 1px solid #fdba74; padding: 16px; border-radius: 12px; margin-bottom: 16px; }
.password-banner code { background: #fff; padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, monospace; }
.password-banner .password-shown { font-size: 14px; font-weight: 700; color: #c2410c; }

/* Toolbar */
.users-toolbar { display: flex; justify-content: flex-end; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
/* .btn-create / .btn-ghost-light: usar tamaño global (font-size 14.5px, padding 10px 18px, border-radius 10px), conservar identidad visual */
.btn-create { background: white; color: #2563eb; border: 1.5px solid #2563eb; font-weight: 700; cursor: pointer; letter-spacing: 0.5px; transition: all 0.15s; }
.btn-create:hover:not(:disabled) { background: #2563eb; color: white; }
.btn-create:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost-light { background: white; color: #475569; border: 1px solid #e2e8f0; font-weight: 600; cursor: pointer; letter-spacing: 0.5px; }
.btn-ghost-light:hover { background: #f8fafc; }

.dropdown { position: relative; }
.dropdown-menu { position: absolute; top: 110%; right: 0; min-width: 180px; background: white; border: 1px solid #e2e8f0; border-radius: 8px; box-shadow: 0 8px 24px rgba(15,23,42,0.1); padding: 6px; z-index: 10; }
.dropdown-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 13px; cursor: pointer; border-radius: 4px; }
.dropdown-item:hover { background: #f1f5f9; }

.search-wrap { position: relative; }
/* .search-wrap input: usar font-size y altura globales; conservar padding-right para icono */
.search-wrap input { padding-right: 36px; min-width: 220px; }
.search-wrap input:focus { outline: none; border-color: #2563eb; }
.search-icon { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: #94a3b8; pointer-events: none; }

/* Tabla */
.users-table-wrap { background: white; border: 1px solid #e6e9ef; border-radius: 10px; overflow: hidden; }
.users-table { width: 100%; border-collapse: collapse; }
.users-table thead th { padding: 14px 16px; font-size: 11px; font-weight: 700; color: #94a3b8; letter-spacing: 0.08em; text-align: left; background: #f8fafc; border-bottom: 1px solid #e6e9ef; }
.users-table tbody td { padding: 12px 16px; font-size: 13px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
.users-table tbody tr:last-child td { border-bottom: 0; }
.users-table tbody tr:hover { background: #fafbfc; }
.empty-row { text-align: center; color: #d97706; padding: 40px !important; font-size: 13px; }

.row-actions { display: flex; gap: 6px; }
.icon-btn { width: 32px; height: 32px; display: grid; place-items: center; background: white; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 14px; transition: all 0.15s; }
.icon-btn:hover:not(:disabled) { background: #f1f5f9; border-color: #cbd5e1; }
.icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.icon-btn.danger { color: #dc2626; }
.icon-btn.danger:hover:not(:disabled) { background: #fef2f2; border-color: #fecaca; }

.avatar-cell { width: 36px; height: 36px; }
.avatar-cell img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
.avatar-fallback { width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; display: grid; place-items: center; font-size: 12px; font-weight: 700; }
.avatar-fallback.large { width: 64px; height: 64px; font-size: 20px; }

.cell-mono { font-family: ui-monospace, monospace; color: #475569; font-size: 12px; }

.role-select-inline { padding: 3px 22px 3px 8px; border: 1px solid #e2e8f0; border-radius: 999px; font-size: 11px; cursor: pointer; background: white; font-weight: 600; line-height: 1.4; max-width: 130px; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path fill='%2394a3b8' d='M2 4l3 3 3-3z'/></svg>"); background-repeat: no-repeat; background-position: right 6px center; }
.role-select-inline:disabled { opacity: 0.5; cursor: not-allowed; }
.role-select-inline.role-admin_empresa { background-color: #f5f3ff; color: #6d28d9; border-color: #ddd6fe; }
.role-select-inline.role-usuario_empresa { background-color: #f1f5f9; color: #475569; }

.status-pill { padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 700; cursor: pointer; border: 1px solid; transition: all 0.15s; }
.status-pill.active { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.status-pill.inactive { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
.status-pill:hover:not(:disabled) { filter: brightness(0.95); }
.status-pill:disabled { opacity: 0.6; cursor: not-allowed; }

/* Modal */
.modal-overlay { position: fixed; inset: 0; background: rgba(15,23,42,0.55); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; padding: 20px 16px; z-index: 100; }
.modal-shell { width: 100%; max-width: 1080px; max-height: calc(100vh - 40px); background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(15,23,42,0.2); display: flex; flex-direction: column; overflow: hidden; }
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 22px; border-bottom: 1px solid #e6e9ef; flex-shrink: 0; }
.modal-header h2 { margin: 0; font-size: 16px; font-weight: 700; color: #0f172a; }
.modal-body { padding: 18px 22px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
.modal-cols { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(340px, 1fr); gap: 22px; }

.section-block { margin-bottom: 16px; }
.section-block:last-child { margin-bottom: 0; }
.section-block h3 { margin: 0 0 10px; font-size: 13px; font-weight: 700; color: #0f172a; padding-bottom: 6px; border-bottom: 1px solid #e6e9ef; }

.field-row { display: grid; grid-template-columns: 120px 1fr; align-items: center; gap: 10px; margin-bottom: 8px; }
.field-row > label { font-size: 12px; color: #475569; font-weight: 600; text-align: right; }
/* .field-row input/select: usar valores globales (font-size 14.5px, padding 9px 12px, height 40px, border-radius 8px) */
.field-row input, .field-row select { background: white; width: 100%; }
.field-row input:focus, .field-row select:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
.char-counter { color: #94a3b8; font-size: 11px; grid-column: 2; justify-self: end; margin-top: -4px; }

.avatar-row .avatar-control { display: flex; gap: 12px; align-items: center; }
.avatar-preview { flex-shrink: 0; width: 64px; height: 64px; border-radius: 50%; overflow: hidden; border: 2px solid #e6e9ef; background: #f8fafc; display: grid; place-items: center; }
.avatar-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.avatar-fallback.large { width: 100%; height: 100%; font-size: 18px; }
.avatar-input { display: flex; gap: 8px; align-items: center; flex: 1; flex-wrap: wrap; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
.file-input-label { padding: 8px 14px; background: #f1f5f9; border: 1px dashed #cbd5e1; border-radius: 6px; font-size: 12px; color: #475569; cursor: pointer; flex: 1; text-align: center; transition: background 0.15s; }
.file-input-label:hover { background: #e2e8f0; }
.btn-link { background: transparent; border: 0; color: #2563eb; cursor: pointer; font-size: 12px; font-weight: 600; padding: 4px 8px; }
.btn-link:hover { color: #1d4ed8; }

.pwd-row-modal { display: flex; gap: 6px; align-items: stretch; }
.pwd-row-modal input { flex: 1; min-width: 0; }
.btn-pwd { padding: 0 12px; background: white; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; color: #2563eb; font-size: 14px; font-weight: 700; transition: all 0.15s; flex-shrink: 0; }
.btn-pwd:hover { background: #eff6ff; border-color: #bfdbfe; }
.checks-modal { list-style: none; padding: 8px 12px; margin: 6px 0 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 11px; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 2px 12px; }
.checks-modal li.met { color: #047857; font-weight: 600; }
.checks-modal li.unmet { color: #94a3b8; }

.send-email-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; font-size: 12px; }
.send-email-row.disabled { background: #fef2f2; border-color: #fecaca; color: #c2410c; cursor: not-allowed; }
.send-email-row input { accent-color: #2563eb; }

.col-right { background: #fafbfc; border: 1px solid #e6e9ef; border-radius: 10px; padding: 14px; align-self: flex-start; }
.permissions-title { margin: 0 0 10px; font-size: 13px; font-weight: 700; color: #0f172a; }
.permissions-disabled-note { color: #6d28d9; background: #f5f3ff; border: 1px solid #ddd6fe; padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5; }

.permissions-list { display: flex; flex-direction: column; gap: 5px; }
.perm-module { background: white; border: 1px solid #e6e9ef; border-radius: 8px; overflow: hidden; }
.perm-module-header { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: white; border: 0; cursor: pointer; transition: background 0.15s; text-align: left; }
.perm-module-header:hover { background: #f8fafc; }
.perm-icon-wrap { font-size: 18px; }
.perm-name { flex: 1; font-size: 13px; font-weight: 600; color: #0f172a; }
.perm-status { font-size: 11px; padding: 3px 8px; border-radius: 999px; font-weight: 700; }
.perm-status.edit { background: #ecfdf5; color: #047857; }
.perm-status.view { background: #eff6ff; color: #1d4ed8; }
.perm-status.none { background: #fef2f2; color: #b91c1c; }
.perm-chevron { color: #94a3b8; font-size: 12px; }
.perm-module-body { padding: 4px 8px 8px; border-top: 1px solid #f1f5f9; display: flex; flex-direction: column; gap: 1px; background: #fafbfc; }
.perm-radio { display: grid; grid-template-columns: 22px 1fr; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: background 0.15s; }
.perm-radio:hover { background: white; }
.perm-radio input[type="radio"] { width: 18px; height: 18px; margin: 0; accent-color: #2563eb; cursor: pointer; }
.perm-text { display: flex; flex-direction: column; line-height: 1.3; min-width: 0; }
.perm-text strong { color: #0f172a; font-weight: 600; font-size: 13px; }
.perm-text em { color: #94a3b8; font-style: normal; font-size: 11px; margin-top: 2px; }
.perm-radio:has(input:checked) { background: white; box-shadow: 0 0 0 1px #bfdbfe inset; }
.perm-radio:has(input:checked) .perm-text strong { color: #1e40af; }

.permissions-summary { margin-top: 10px; padding: 8px 12px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; font-size: 12px; color: #1e40af; text-align: center; }

.modal-footer { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 22px; border-top: 1px solid #e6e9ef; background: #fafbfc; flex-shrink: 0; }

@media (max-width: 900px) {
  .modal-cols { grid-template-columns: 1fr; }
  .field-row { grid-template-columns: 1fr; }
  .field-row > label { text-align: left; }
}
</style>

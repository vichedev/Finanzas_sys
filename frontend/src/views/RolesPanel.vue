<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { http } from '../api/http';
import { useConfirm } from '../composables/useConfirm';
import type { Permissions, ModuleName, PermissionLevel } from '../stores/auth';

const { confirm } = useConfirm();

interface Role {
  id: number;
  name: string;
  description: string | null;
  permissions: Permissions;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

const MODULES: Array<{ key: ModuleName; label: string; icon: string }> = [
  { key: 'movements', label: 'Movimientos', icon: '🔁' },
  { key: 'accounts', label: 'Cuentas', icon: '🏛️' },
  { key: 'cards', label: 'Tarjetas', icon: '💳' },
  { key: 'debts', label: 'Deudas / Préstamos', icon: '🏦' },
  { key: 'recurrings', label: 'Recurrentes', icon: '🔂' },
  { key: 'invoices', label: 'Facturas / IVA', icon: '🧾' },
  { key: 'reports', label: 'Reportes', icon: '📊' }
];

const LEVEL_LABEL: Record<PermissionLevel, string> = {
  edit: 'Editar', view: 'Ver', none: 'Sin acceso'
};

const DEFAULT_PERMS: Permissions = {
  movements: 'edit', accounts: 'edit', cards: 'edit',
  debts: 'edit', recurrings: 'edit', invoices: 'edit', reports: 'view'
};

const roles = ref<Role[]>([]);
const errorMsg = ref('');
const successMsg = ref('');
const editingId = ref<number | null>(null);
const editForm = ref<{ name: string; description: string; permissions: Permissions }>({
  name: '', description: '', permissions: { ...DEFAULT_PERMS }
});
const showCreate = ref(false);
const createForm = ref<{ name: string; description: string; permissions: Permissions }>({
  name: '', description: '', permissions: { ...DEFAULT_PERMS }
});

const builtinRoles = computed(() => roles.value.filter((r) => r.isBuiltIn));
const customRoles = computed(() => roles.value.filter((r) => !r.isBuiltIn));

async function load() {
  errorMsg.value = '';
  try {
    const { data } = await http.get<Role[]>('/admin/roles');
    roles.value = data;
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    errorMsg.value = err?.response?.data?.message || 'No se pudieron cargar los roles.';
  }
}

function applyPreset(target: 'create' | 'edit', preset: 'full' | 'readonly' | 'none') {
  const obj = target === 'create' ? createForm.value.permissions : editForm.value.permissions;
  for (const m of MODULES) {
    if (preset === 'full') obj[m.key] = 'edit';
    else if (preset === 'readonly') obj[m.key] = 'view';
    else obj[m.key] = 'none';
  }
}

async function createRole() {
  errorMsg.value = ''; successMsg.value = '';
  if (createForm.value.name.trim().length < 2) { errorMsg.value = 'El nombre debe tener al menos 2 caracteres.'; return; }
  try {
    await http.post('/admin/roles', {
      name: createForm.value.name.trim(),
      description: createForm.value.description.trim() || null,
      permissions: createForm.value.permissions
    });
    successMsg.value = 'Rol creado correctamente.';
    showCreate.value = false;
    createForm.value = { name: '', description: '', permissions: { ...DEFAULT_PERMS } };
    await load();
    setTimeout(() => (successMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    errorMsg.value = err?.response?.data?.message || 'No se pudo crear el rol.';
  }
}

function startEdit(r: Role) {
  if (r.isBuiltIn) return;
  editingId.value = r.id;
  editForm.value = {
    name: r.name,
    description: r.description || '',
    permissions: { ...DEFAULT_PERMS, ...r.permissions }
  };
}

function cancelEdit() {
  editingId.value = null;
}

async function saveEdit() {
  if (editingId.value === null) return;
  errorMsg.value = ''; successMsg.value = '';
  try {
    await http.put(`/admin/roles/${editingId.value}`, {
      name: editForm.value.name.trim(),
      description: editForm.value.description.trim() || null,
      permissions: editForm.value.permissions
    });
    successMsg.value = 'Rol actualizado.';
    editingId.value = null;
    await load();
    setTimeout(() => (successMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    errorMsg.value = err?.response?.data?.message || 'No se pudo actualizar.';
  }
}

async function removeRole(r: Role) {
  if (r.isBuiltIn) return;
  if (!(await confirm({ message: `¿Eliminar el rol "${r.name}"? Los usuarios que ya tenían sus permisos los conservarán.`, danger: true, confirmText: 'Eliminar' }))) return;
  try {
    await http.delete(`/admin/roles/${r.id}`);
    successMsg.value = 'Rol eliminado.';
    await load();
    setTimeout(() => (successMsg.value = ''), 2500);
  } catch (e: unknown) {
    const err = e as { response?: { data?: { message?: string } } };
    errorMsg.value = err?.response?.data?.message || 'No se pudo eliminar.';
  }
}

function permsCellLabel(p: Permissions, m: ModuleName) {
  if (p[m] === 'edit') return '✏️';
  if (p[m] === 'view') return '👁️';
  return '✕';
}

onMounted(load);
</script>

<template>
  <div>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
    <p v-if="successMsg" class="hint-msg">{{ successMsg }}</p>

    <div class="panel">
      <div class="panel-header">
        <div>
          <h2>Roles del sistema</h2>
          <p class="info-text">Plantillas reutilizables de permisos. Aplica un rol al crear o editar un usuario para configurar la matriz rápidamente.</p>
        </div>
        <button type="button" @click="showCreate = !showCreate">{{ showCreate ? 'Cancelar' : '+ Nuevo rol' }}</button>
      </div>

      <div v-if="showCreate" class="role-card create-card">
        <div class="field-group">
          <div class="field">
            <label for="role-name">Nombre <span class="required-mark">*</span></label>
            <input id="role-name" v-model="createForm.name" required maxlength="80" placeholder="ej. Contador, Asistente, Solo informes" />
            <small class="hint">Identifica el rol claramente. Debe ser único.</small>
          </div>
          <div class="field">
            <label for="role-desc">Descripción</label>
            <input id="role-desc" v-model="createForm.description" maxlength="500" placeholder="Para qué tipo de usuario es" />
          </div>
        </div>

        <div class="permissions-block">
          <div class="permissions-header">
            <strong>Permisos por módulo</strong>
            <div class="presets">
              <button type="button" class="ghost mini" @click="applyPreset('create', 'full')">Todo edición</button>
              <button type="button" class="ghost mini" @click="applyPreset('create', 'readonly')">Solo lectura</button>
              <button type="button" class="ghost mini" @click="applyPreset('create', 'none')">Sin acceso</button>
            </div>
          </div>
          <table class="perms-table">
            <thead><tr><th>Módulo</th><th>Editar</th><th>Ver</th><th>Sin acceso</th></tr></thead>
            <tbody>
              <tr v-for="m in MODULES" :key="m.key">
                <td>{{ m.icon }} {{ m.label }}</td>
                <td><input type="radio" :name="'perm-create-'+m.key" value="edit" v-model="createForm.permissions[m.key]" /></td>
                <td><input type="radio" :name="'perm-create-'+m.key" value="view" v-model="createForm.permissions[m.key]" /></td>
                <td><input type="radio" :name="'perm-create-'+m.key" value="none" v-model="createForm.permissions[m.key]" /></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="actions-row">
          <button type="button" @click="createRole">Guardar rol</button>
          <button type="button" class="ghost" @click="showCreate = false">Cancelar</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><h2>Roles del sistema (built-in)</h2></div>
      <div class="table-scroll">
        <table class="recent-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th v-for="m in MODULES" :key="m.key" class="perm-col" :title="m.label">{{ m.icon }}</th>
              <th>Descripción</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in builtinRoles" :key="r.id">
              <td>
                <strong>🛡️ {{ r.name }}</strong>
                <div><small class="hint builtin-badge">Sistema · no editable</small></div>
              </td>
              <td v-for="m in MODULES" :key="m.key" class="perm-col">
                <span class="perm-icon" :class="r.permissions[m.key]" :title="LEVEL_LABEL[r.permissions[m.key]]">{{ permsCellLabel(r.permissions, m.key) }}</span>
              </td>
              <td><small class="hint">{{ r.description }}</small></td>
            </tr>
            <tr v-if="!builtinRoles.length"><td :colspan="MODULES.length + 2" class="empty">Aún no se cargan los roles del sistema.</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <h2>Roles personalizados</h2>
        <span class="panel-hint">{{ customRoles.length }} rol{{ customRoles.length === 1 ? '' : 'es' }}</span>
      </div>
      <div class="table-scroll">
        <table class="recent-table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th v-for="m in MODULES" :key="m.key" class="perm-col" :title="m.label">{{ m.icon }}</th>
              <th>Descripción</th>
              <th class="right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in customRoles" :key="r.id">
              <tr>
                <td><strong>{{ r.name }}</strong></td>
                <td v-for="m in MODULES" :key="m.key" class="perm-col">
                  <span class="perm-icon" :class="r.permissions[m.key]" :title="LEVEL_LABEL[r.permissions[m.key]]">{{ permsCellLabel(r.permissions, m.key) }}</span>
                </td>
                <td><small class="hint">{{ r.description || '—' }}</small></td>
                <td class="right">
                  <div class="actions">
                    <button type="button" class="ghost mini" @click="startEdit(r)">Editar</button>
                    <button type="button" class="ghost mini danger" @click="removeRole(r)">Eliminar</button>
                  </div>
                </td>
              </tr>
              <tr v-if="editingId === r.id" class="edit-row">
                <td :colspan="MODULES.length + 3">
                  <div class="role-card">
                    <div class="field-group">
                      <div class="field">
                        <label>Nombre</label>
                        <input v-model="editForm.name" maxlength="80" />
                      </div>
                      <div class="field">
                        <label>Descripción</label>
                        <input v-model="editForm.description" maxlength="500" />
                      </div>
                    </div>
                    <div class="permissions-block">
                      <div class="permissions-header">
                        <strong>Permisos</strong>
                        <div class="presets">
                          <button type="button" class="ghost mini" @click="applyPreset('edit', 'full')">Todo edición</button>
                          <button type="button" class="ghost mini" @click="applyPreset('edit', 'readonly')">Solo lectura</button>
                          <button type="button" class="ghost mini" @click="applyPreset('edit', 'none')">Sin acceso</button>
                        </div>
                      </div>
                      <table class="perms-table">
                        <thead><tr><th>Módulo</th><th>Editar</th><th>Ver</th><th>Sin acceso</th></tr></thead>
                        <tbody>
                          <tr v-for="m in MODULES" :key="m.key">
                            <td>{{ m.icon }} {{ m.label }}</td>
                            <td><input type="radio" :name="'perm-edit-'+r.id+'-'+m.key" value="edit" v-model="editForm.permissions[m.key]" /></td>
                            <td><input type="radio" :name="'perm-edit-'+r.id+'-'+m.key" value="view" v-model="editForm.permissions[m.key]" /></td>
                            <td><input type="radio" :name="'perm-edit-'+r.id+'-'+m.key" value="none" v-model="editForm.permissions[m.key]" /></td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div class="actions-row">
                      <button type="button" @click="saveEdit">Guardar cambios</button>
                      <button type="button" class="ghost" @click="cancelEdit">Cancelar</button>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!customRoles.length"><td :colspan="MODULES.length + 3" class="empty">No has creado roles personalizados. Usa "+ Nuevo rol" arriba para crear el primero.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* .field, .field label, .field .hint, .field-group: usar valores globales de style.css */
.field { flex: 1; min-width: 0; }
.required-mark { color: #ef4444; font-weight: 700; }
.info-text { color: #64748b; font-size: 13px; margin: 4px 0 0; }
.role-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
.create-card { margin-top: 14px; }
.permissions-block { margin-top: 10px; }
.permissions-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
.presets { display: flex; gap: 4px; }
.presets button.mini { font-size: 11px; padding: 4px 8px; }
.perms-table { width: 100%; border-collapse: collapse; }
.perms-table th, .perms-table td { padding: 6px 10px; font-size: 13px; text-align: center; }
.perms-table th { color: #94a3b8; font-weight: 500; border-bottom: 1px solid #e2e8f0; }
.perms-table th:first-child, .perms-table td:first-child { text-align: left; }
.perm-col { width: 36px; text-align: center; padding: 6px 4px; }
.perm-icon { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; font-size: 11px; }
.perm-icon.edit { background: #ecfdf5; color: #047857; }
.perm-icon.view { background: #eff6ff; color: #1d4ed8; }
.perm-icon.none { background: #fef2f2; color: #b91c1c; }
.builtin-badge { color: #6d28d9; }
.actions { display: flex; gap: 4px; justify-content: flex-end; }
.actions button.mini { font-size: 11px; padding: 4px 8px; background: white; border: 1px solid #e2e8f0; color: #475569; border-radius: 6px; cursor: pointer; }
.actions button.mini:hover { background: #f8fafc; }
.actions button.mini.danger { color: #dc2626; border-color: #fecaca; }
.actions-row { display: flex; gap: 8px; margin-top: 12px; }
.edit-row td { background: #f1f5f9; padding: 12px; }
.table-scroll { overflow-x: auto; }
.ghost { background: white; border: 1px solid #e2e8f0; color: #64748b; }
</style>

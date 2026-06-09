// =====================================================
// CRUD genérico: estado de lista + formulario (crear/editar) +
// guardar/eliminar con toasts. Elimina el copy-paste que había
// en cada vista (rows/errorMsg/successMsg/editingId/save/startEdit...).
// =====================================================
import { ref, type Ref } from 'vue';
import { useToast } from './useToast';
import type { RestResource } from '../api/resource';

export interface CrudLabels {
  created?: string;
  updated?: string;
  removed?: string;
  loadError?: string;
  saveError?: string;
  removeError?: string;
}

export interface UseCrudOptions<T extends { id: number }, F> {
  service: Pick<RestResource<T, F>, 'list' | 'create' | 'update' | 'remove'>;
  emptyForm: () => F;
  /** Mapea un item existente al formulario editable. */
  toForm: (item: T) => F;
  /** Transforma el formulario antes de enviarlo (trim, números, etc.). */
  toPayload?: (form: F) => F;
  /** Devuelve un mensaje de error si el formulario es inválido, o null. */
  validate?: (form: F) => string | null;
  labels?: CrudLabels;
}

export interface UseCrud<T extends { id: number }, F> {
  rows: Ref<T[]>;
  form: Ref<F>;
  editingId: Ref<number | null>;
  loading: Ref<boolean>;
  saving: Ref<boolean>;
  isEditing: Ref<boolean>;
  /** Última entidad creada/actualizada por save() (o null). */
  lastSaved: Ref<T | null>;
  load: () => Promise<void>;
  save: () => Promise<void>;
  startEdit: (item: T) => void;
  cancelEdit: () => void;
  remove: (item: T, confirmMsg?: string) => Promise<void>;
}

export function useCrud<T extends { id: number }, F>(opts: UseCrudOptions<T, F>): UseCrud<T, F> {
  const toast = useToast();
  const rows = ref([]) as Ref<T[]>;
  const form = ref(opts.emptyForm()) as Ref<F>;
  const editingId = ref<number | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const isEditing = ref(false);
  const lastSaved = ref(null) as Ref<T | null>;

  async function load() {
    loading.value = true;
    try {
      rows.value = await opts.service.list();
    } catch {
      toast.error(opts.labels?.loadError ?? 'No se pudieron cargar los datos.');
    } finally {
      loading.value = false;
    }
  }

  function resetForm() {
    editingId.value = null;
    isEditing.value = false;
    form.value = opts.emptyForm();
  }

  async function save() {
    const err = opts.validate?.(form.value);
    if (err) {
      toast.error(err);
      return;
    }
    saving.value = true;
    try {
      const payload = opts.toPayload ? opts.toPayload(form.value) : form.value;
      if (editingId.value !== null) {
        lastSaved.value = await opts.service.update(editingId.value, payload);
        toast.success(opts.labels?.updated ?? 'Cambios guardados.');
      } else {
        lastSaved.value = await opts.service.create(payload);
        toast.success(opts.labels?.created ?? 'Creado correctamente.');
      }
      resetForm();
      await load();
    } catch {
      toast.error(opts.labels?.saveError ?? 'No se pudo guardar.');
    } finally {
      saving.value = false;
    }
  }

  function startEdit(item: T) {
    editingId.value = item.id;
    isEditing.value = true;
    form.value = opts.toForm(item);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function remove(item: T, confirmMsg?: string) {
    if (confirmMsg && typeof window !== 'undefined' && !window.confirm(confirmMsg)) return;
    try {
      await opts.service.remove(item.id);
      toast.success(opts.labels?.removed ?? 'Eliminado.');
      if (editingId.value === item.id) resetForm();
      await load();
    } catch {
      toast.error(opts.labels?.removeError ?? 'No se pudo eliminar.');
    }
  }

  return {
    rows,
    form,
    editingId,
    loading,
    saving,
    isEditing,
    lastSaved,
    load,
    save,
    startEdit,
    cancelEdit: resetForm,
    remove
  };
}

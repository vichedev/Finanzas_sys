// =====================================================
// Acceso a permisos por módulo desde cualquier vista.
// =====================================================
import { useAuthStore, type ModuleName } from '../stores/auth';

export function usePermissions(defaultModule?: ModuleName) {
  const auth = useAuthStore();
  return {
    canRead: (mod: ModuleName | undefined = defaultModule) => (mod ? auth.canRead(mod) : true),
    canWrite: (mod: ModuleName | undefined = defaultModule) => (mod ? auth.canWrite(mod) : true)
  };
}

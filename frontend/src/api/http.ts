import axios from 'axios';

// URL base del API. Configurable por VITE_API_URL (frontend/.env), leída en build.
// Por defecto "/api" (mismo dominio; nginx hace de proxy al backend).
const apiBase = (import.meta.env as Record<string, string | undefined>).VITE_API_URL || '/api';

export const http = axios.create({
  baseURL: apiBase,
  timeout: 15000
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('finanzas_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const message = error?.response?.data?.message;
    const url = (error?.config?.url || '') as string;
    const isAuthEndpoint =
      url.startsWith('/auth/login') || url.startsWith('/auth/select-tenant');

    const isSessionLost =
      status === 401 || (status === 403 && message === 'Sesión inválida');

    if (isSessionLost && !isAuthEndpoint) {
      localStorage.removeItem('finanzas_token');
      localStorage.removeItem('finanzas_user');
      localStorage.removeItem('finanzas_kind');
      localStorage.removeItem('finanzas_tenant');
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
      // Suprime el error en handlers downstream: la sesion ya no es valida.
      // Evita que aparezca como AxiosError ruidoso en consola tras logout/expiracion.
      return new Promise(() => {});
    }
    return Promise.reject(error);
  }
);

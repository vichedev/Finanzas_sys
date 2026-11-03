// Se importa primero: la medición informa por su cuenta y no debe mezclarse con los registros.
// Con LOG_LEVEL=error se puede ver el motivo que da el proveedor cuando falla.
process.env.LOG_LEVEL ??= 'silent';
process.env.NODE_ENV ??= 'production';

export {};

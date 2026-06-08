# Propuesta técnica - Sistema mensual de finanzas personales

## Objetivo

Construir un sistema web para controlar de forma mensual ingresos, egresos, tarjetas de crédito, tarjetas de débito, efectivo, cuentas bancarias, cuentas por cobrar, cuentas por pagar, préstamos, deudas recurrentes y balance real.

## Módulos principales

1. Autenticación
   - Registro de usuario.
   - Login con JWT.
   - Contraseña cifrada con bcrypt.

2. Cuentas
   - Efectivo.
   - Banco.
   - Billetera digital.
   - Débito.
   - Cuenta por cobrar.

3. Tarjetas
   - Crédito.
   - Débito.
   - Cupo.
   - Día de corte.
   - Día máximo de pago.
   - Saldo actual.

4. Movimientos
   - Ingreso.
   - Egreso.
   - Transferencia preparada en el modelo.
   - Categoría.
   - Cuenta o tarjeta relacionada.
   - Persona/familia asociada.
   - Notas y metadatos para comprobantes.

5. Deudas y cobros
   - Cuentas por pagar.
   - Cuentas por cobrar.
   - Préstamos.
   - Saldo pendiente.
   - Fecha de vencimiento.

6. Recurrentes
   - Pagos mensuales.
   - Ingresos fijos.
   - Servicios básicos.
   - Deudas recurrentes.

7. Reportes
   - Ingresos del mes.
   - Gastos del mes.
   - Balance mensual.
   - Totales por categoría.

## Siguiente etapa profesional

- OCR/IA para leer comprobantes.
- Exportación Excel/PDF.
- Presupuesto mensual por categoría.
- Alertas de fechas de corte y vencimiento.
- Conciliación bancaria.
- Multiusuario familiar o empresarial.
- Dashboard con gráficos avanzados.

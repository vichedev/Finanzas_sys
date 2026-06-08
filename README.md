# Finanzas Mensuales

Plataforma cerrada y multi-usuario para gestión de finanzas personales: ingresos, gastos, cuentas, tarjetas, deudas, préstamos con cuotas, recurrencias y reportes mensuales.

## Stack

- **Frontend:** Vue 3 + Vite + TypeScript + Pinia + Vue Router + Chart.js
- **Backend:** Node.js 22 + Express 4 + TypeScript + Prisma 6 + Zod
- **Base de datos:** PostgreSQL 16
- **Auth:** JWT (HS256) + bcrypt cost=12, rate-limit en /auth, role + permisos por módulo
- **Mailer:** Nodemailer con SMTP configurable desde la UI (password cifrada AES-256-GCM)
- **Seguridad:** Helmet + CSP + HSTS, fail2ban en host, pg_hba scram-sha-256, role app separado del bootstrap superuser, secrets via `.env`/AppSetting cifrado, capabilities Docker reducidas
- **Infra:** Docker Compose (postgres + backend + frontend nginx + pgAdmin)

## Funcionalidades

- **Multi-usuario con aislamiento total** — cada query Prisma filtra por `userId`. Verificado E2E: un usuario no puede leer ni modificar datos de otro.
- **Plataforma cerrada** — registro público bloqueado. Solo el ADMIN crea cuentas desde Configuración → Usuarios.
- **Permisos granulares por módulo** — para cada usuario USER, define `edit` / `view` / `none` en: Movimientos, Cuentas, Tarjetas, Deudas, Recurrentes, Reportes. Enforcement en backend (middleware) y frontend (router + sidebar).
- **Préstamos con cuotas** — cuota mensual, día de pago, plazo, total a pagar, interés anual, barra de avance.
- **Dashboard rico** — KPIs con comparativa vs mes anterior, gráfico de 6 meses (bar), donut de gastos por categoría, movimientos recientes, tarjetas con cupo disponible, cuentas con balance, accesos rápidos.
- **Configuración SMTP desde UI** — host, puerto, usuario, password (cifrada en BD), SSL/TLS, From, URL pública. Botón de prueba que verifica la conexión y opcionalmente envía email de test.
- **Backups automáticos** — systemd timer con `pg_dump -Fc` diario a las 03:00, retención 30 días.

## Instalación en cualquier VPS (un solo comando)

Requisitos: VPS con **Debian 11+, Ubuntu 22+, AlmaLinux 9 o Rocky 9**, acceso root, al menos 2 GB RAM y 5 GB libres.

```bash
curl -fsSL https://raw.githubusercontent.com/mtandazo35/finanzas/main/install.sh | sudo bash
```

O clonando primero:

```bash
git clone https://github.com/mtandazo35/finanzas.git /opt/finanzas
sudo bash /opt/finanzas/install.sh
```

El instalador hace, paso por paso:

1. Verifica el sistema (RAM, disco, distro)
2. Instala paquetes base (curl, git, openssl)
3. Crea swap de 2 GB si no existe (opcional)
4. Instala Docker y Docker Compose del repo oficial
5. Configura UFW/firewalld con SSH+HTTP (opcional, puedes restringir a un CIDR)
6. Instala fail2ban con jail SSH
7. Clona el repo en `/opt/finanzas`
8. Genera todos los secretos automáticamente
9. Construye imágenes y levanta los containers
10. Sincroniza el esquema de la BD
11. Crea el primer administrador (te pregunta email y password)

Al terminar muestra las URLs y las credenciales, guardadas también en `/root/finanzas-credenciales.txt` (chmod 600).

### URLs después del install

- **App**: `http://<IP-del-VPS>/`
- **API health**: `http://127.0.0.1:4000/api/health` (solo localhost)
- **pgAdmin**: `http://127.0.0.1:5055` (acceso vía `ssh -L 5055:127.0.0.1:5055`)

### Variables para instalación no interactiva

```bash
NON_INTERACTIVE=1 \
ADMIN_EMAIL="admin@example.com" \
ADMIN_PASSWORD="MiPasswordSegura" \
ADMIN_NAME="Tu Nombre" \
SETUP_UFW=yes ALLOWED_NET="203.0.113.0/24" \
SETUP_FAIL2BAN=yes \
SETUP_SWAP=yes \
sudo bash install.sh
```

## Actualizar a la última versión

```bash
sudo bash /opt/finanzas/update.sh
# o para forzar rebuild de todo:
sudo bash /opt/finanzas/update.sh --rebuild-all
```

Detecta automáticamente si cambió el schema de Prisma y aplica `db push`.

## Backup manual

```bash
sudo bash /opt/finanzas/scripts/backup.sh
```

Los dumps se guardan en `/var/backups/finanzas/` con retención de 30 días.

## Módulos

| Módulo | Descripción |
|---|---|
| Dashboard | KPIs, charts, accesos rápidos |
| Movimientos | Ingresos/gastos/transferencias con categoría, cuenta, tarjeta, persona, notas |
| Cuentas | Efectivo, banco, billetera, débito, por cobrar |
| Tarjetas | Crédito (cupo, corte, pago) y débito |
| Cuentas por cobrar / pagar / Préstamos | Filtros de la entidad Debt. Préstamos con cuota mensual, plazo, total a pagar, interés |
| Deudas recurrentes | Reglas DAILY/WEEKLY/MONTHLY/YEARLY |
| Reportes | Agregado por categoría con barras de distribución |
| Configuración (admin) | Perfil, Categorías, Usuarios y permisos, Servidor de correo |

## Seguridad

- BD/pgAdmin/backend bindeados a `127.0.0.1`. Solo el frontend (80) está expuesto.
- Frontend nginx unprivileged, security headers (CSP, HSTS, X-Frame-Options DENY, COOP/CORP), gzip, rate-limit en `/auth`.
- App role Postgres separado del bootstrap superuser.
- pg_hba `scram-sha-256` (no trust ni en localhost).
- JWT con role + permisos, expira en 1d, `JWT_SECRET` ≥96 chars.
- Passwords con bcrypt cost=12, dummy compare timing-safe.
- SMTP password cifrada AES-256-GCM en `AppSetting`.
- helmet + error handler genérico (NO leak `err.message`).
- express-async-errors evita DoS por body inválido.
- fail2ban en host (jail sshd).
- SSH `PasswordAuthentication=no`.

## Estructura

```
.
├── backend/
│   ├── prisma/schema.prisma
│   └── src/
│       ├── lib/             # prisma, jwt, mailer, settings, permissions
│       ├── middleware/      # auth, admin, permissions
│       └── routes/          # auth, accounts, cards, categories, movements, debts, recurrings, dashboard, admin
├── frontend/
│   ├── nginx.conf
│   ├── Dockerfile
│   └── src/
│       ├── api/, stores/, router/
│       └── views/
├── scripts/
│   └── backup.sh
├── docker-compose.yml
└── README.md
```

## Próximas mejoras

- TLS público con Cloudflare Tunnel o Let's Encrypt
- Adjuntar comprobantes con OCR
- Conciliación bancaria
- Presupuestos mensuales por categoría/persona
- Exportación PDF/Excel
- Recordatorios de fecha de corte y pago
- Migraciones Prisma versionadas en lugar de `db push`
- 2FA opcional en login

## Licencia

Privado — Manuel Tandazo.

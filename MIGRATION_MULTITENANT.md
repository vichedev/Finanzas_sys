# Migración a multitenant — server existente

Esta guía convierte una instalación single-tenant existente (con datos en `finanzas_db`) a la nueva arquitectura multitenant. La ejecución es **manual y guiada** porque toca la DB de producción.

## Prerrequisitos

- Acceso SSH al server con el código actualizado (último commit en `main` con multitenant).
- El usuario PostgreSQL del docker compose (`finanzas_user`) debe ser superuser dentro del container (es el caso por defecto — el `POSTGRES_USER` del docker se trata como superuser).

---

## Paso 1 — Backup completo (obligatorio)

```bash
ssh root@<IP-VPS>
cd /opt/finanzas
bash scripts/backup.sh
```

Verifica que existe el archivo en `/var/backups/finanzas/`. Si algo sale mal, puedes restaurar con `pg_restore`.

---

## Paso 2 — Generar la clave de cifrado de credenciales

Esta clave cifra los passwords PostgreSQL de cada tenant guardados en `TenantConnection`.

```bash
openssl rand -hex 32
```

Copia el resultado (64 caracteres hex).

---

## Paso 3 — Actualizar `backend/.env`

```bash
nano /opt/finanzas/backend/.env
```

Añade al final (sustituye los valores):

```ini
# Multitenant
GLOBAL_DATABASE_URL="postgresql://finanzas_user:<MISMO_PASSWORD_QUE_DATABASE_URL>@postgres:5432/finanzas_global?schema=public"
POSTGRES_ADMIN_URL="postgresql://finanzas_user:<MISMO_PASSWORD>@postgres:5432/postgres"
PG_HOST=postgres
PG_PORT=5432
TENANT_ENCRYPTION_KEY=<el-64-hex-del-paso-2>
```

Guarda y sale (Ctrl+O, Ctrl+X).

---

## Paso 4 — Crear la DB global

```bash
docker compose exec postgres psql -U finanzas_user -d postgres -c "CREATE DATABASE finanzas_global;"
```

---

## Paso 5 — Pull + rebuild

```bash
cd /opt/finanzas
git pull --ff-only
docker compose up -d --build
```

Esto va a recompilar el backend con los 3 schemas Prisma generados.

---

## Paso 6 — Aplicar schema global

```bash
docker compose exec backend npx prisma db push \
  --schema=prisma/global/schema.prisma --accept-data-loss
```

Debes ver `🚀  Your database is now in sync`.

---

## Paso 7 — Ejecutar la migración

```bash
docker compose exec \
  -e MIGRATE_LEGAL_NAME="Mi Empresa" \
  -e MIGRATE_EMAIL="manuel_tandazo16@hotmail.com" \
  backend npx tsx scripts/migrate-to-multitenant.ts
```

Lo que hace este script (en orden):
1. Crea Plan ENTERPRISE.
2. Renombra `finanzas_db` → `finanzas_t_default`.
3. Crea PG user `tu_default` con password fuerte, dueño de la DB.
4. Cifra credenciales y guarda en `TenantConnection`.
5. Crea `Tenant` con slug `default`.
6. Copia todos los `User` existentes a `TenantMembership` (en global).
7. Si había un `SUPERADMIN`, lo registra también como `SuperAdmin` global.

Al final muestra el ID del tenant creado y el conteo de usuarios migrados.

---

## Paso 8 — Verificar

```bash
# La app debe responder
curl -sS -o /dev/null -w "%{http_code}\n" http://<IP-VPS>/

# Login con tu cuenta — debe funcionar igual
curl -sS -X POST http://<IP-VPS>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"manuel_tandazo16@hotmail.com","password":"<tu pass>"}'
```

La respuesta debería incluir `"kind":"super"` (porque tu ADMIN actual se promovió a SUPER_ADMIN durante la migración) y un JWT válido.

---

## Paso 9 — Probar el panel SuperAdmin

1. Abre `http://<IP-VPS>/` en el navegador.
2. Login con tu cuenta.
3. El sidebar muestra "Super Admin" arriba (icono escudo).
4. Click → ves la tabla de empresas con tu tenant `default` listado.
5. Prueba crear una empresa nueva desde el panel.

---

## Rollback (si algo sale mal)

```bash
# Detener el backend
docker compose stop backend

# Restaurar el dump
gunzip < /var/backups/finanzas/finanzas-YYYYMMDD.sql.gz | \
  docker exec -i finanzas_postgres pg_restore -U finanzas_user -d finanzas_db --clean

# Volver al commit anterior
git checkout <commit-anterior-a-multitenant>
docker compose up -d --build
```

---

## Después de la migración

- Tu cuenta ahora es `SUPER_ADMIN` global.
- Los demás usuarios siguen siendo de la empresa `default`.
- Puedes crear nuevas empresas desde el panel SuperAdmin (cada una tendrá su propia DB).
- Cada nuevo usuario que crees desde Configuración del tenant entra solo a ese tenant.

Para crear un usuario que pertenezca a varias empresas: créalo manualmente con el mismo email en cada tenant (futuro: endpoint dedicado).

# AGENTS.md — Backend Astro SSR, Base de Datos y APIs (`src/server/` y `src/pages/api/`)

Este documento define la arquitectura, seguridad y contratos de los servicios del servidor ejecutados sobre Astro SSR en Vercel Serverless, persistencia con Drizzle ORM sobre Neon Postgres, y endpoints en `src/pages/api/`.

---

## 1. Contrato de Sincronización Servidor (`/api/sync`)

El endpoint `/api/sync` (`src/pages/api/sync.ts`) implementa el lado servidor del protocolo Last-Write-Wins (LWW) y debe cumplir estrictamente:

- **Honestidad en el recuento (`pushed`)**:
  El valor numérico de `pushed` devuelto al cliente representa exclusivamente las filas **efectivamente escritas** en la base de datos PostgreSQL, nunca la cantidad de registros recibidos en el cuerpo de la petición.
- **Guard Atómico LWW**:
  Toda sentencia `UPDATE` condiciona su ejecución a:
  ```sql
  WHERE "updatedAt" < incoming."updatedAt"
  ```
  Si la fila en base de datos posee un `updatedAt` igual o más reciente que la fila entrante, la operación no escribe registros y no suma a `pushed`.
- **Colección de `rechazados` y Marca de Tiempo**:
  Toda fila entrante cuyo guard LWW impida su escritura debe incluirse en `rechazados` con formato `{ t: 'a' | 'c' | 's' | 'o', k, u }`, donde `u` es el `updatedAt` real que reside en el servidor.
- **Reloj del Servidor (`serverTime`)**:
  Toda respuesta exitosa o de sincronización debe incluir la propiedad `serverTime: Date.now()`. Este valor permite al cliente calcular el desfase de reloj y sellar futuras mutaciones con precisión.
- **Tombstones**:
  Las eliminaciones se sincronizan como marcas de tiempo en `deletedAt` y siguen la misma regla de resolución LWW que las creaciones y actualizaciones.

---

## 2. Autenticación, Sesiones y Seguridad

La seguridad del sistema (`src/server/auth.ts`, `src/pages/api/auth.ts`) sigue el principio de defensa en profundidad:

- **Manejo de Sesiones**:
  - Las sesiones se transmiten mediante la cookie HTTP-only `np_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`).
  - La cookie contiene el token de sesión plano generado criptográficamente (`crypto.randomBytes`).
  - **En base de datos únicamente se almacena el hash SHA-256** del token. Esto previene el secuestro de sesiones en caso de filtración o volcado de la base de datos.
- **Almacenamiento y Verificación de Contraseñas**:
  - Cifrado mediante algoritmo `scrypt` con salt aleatorio de alta entropía.
  - Formato serializado: `salt:hash`.
  - La verificación de credenciales debe realizarse obligatoriamente utilizando `crypto.timingSafeEqual` sobre los buffers derivados para neutralizar ataques de canal lateral basados en tiempo de respuesta (timing attacks).
- **Control de Tasa Persistente (Rate Limiting)**:
  - Implementado en `src/server/rateLimit.ts` (incluyendo `consumirPresupuestoSync` para `/api/sync`).
  - Debido a la naturaleza stateless de las funciones serverless de Vercel, los intentos de auth se persisten en PostgreSQL (tabla `login_attempts` en `src/server/schema.ts`), guardando hashes truncados en `key` (sin PII) para que el bloqueo sobreviva entre instancias.
- **Modo Desconectado / Sin Base de Datos (`isDbConfigured`)**:
  - Si `DATABASE_URL` no está definida, `isDbConfigured` evalúa a `false` y `db` (`src/server/db.ts`) cae a un proxy de fallback.
  - Los endpoints responden de forma controlada sin tumbar el arranque local; la aplicación cliente opera íntegramente offline con IndexedDB.

---

## 3. Zona Roja: Protección de Producción

> [!CAUTION]
> **REGLA DE ZONA ROJA — AVISO PREVIO OBLIGATORIO**:
> Ningún subagente ni tarea automatizada puede realizar las siguientes operaciones sin **consulta explícita y aprobación previa del usuario**:
> 1. Modificar el esquema de Drizzle (`src/server/schema.ts`) o ejecutar migraciones en producción (`bunx drizzle-kit push`).
> 2. Alterar las funciones de autenticación, hash de contraseñas o verificación de sesiones (`src/server/auth.ts`).
> 3. Modificar la lógica del guard LWW o el cómputo de `pushed` / `rechazados` en `/api/sync`.

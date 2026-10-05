# AGENTS.md — Nature Planner (horario)

App de planificación de horarios **local-first, mobile-first**: IndexedDB (Dexie) como fuente local, sync opcional LWW a Neon Postgres vía API SSR de Astro. Deploy: Vercel (push a `main`).

## Comandos (el proyecto es 100% bun — nunca npm)

```bash
bun install          # dependencias (lockfile canónico: bun.lock)
bun run dev          # dev server en http://localhost:4321/
bun test             # tests (siempre deben pasar antes de commit)
bun run build        # build de producción (adapter Vercel)
bunx drizzle-kit push  # migraciones → DATABASE_URL (requiere .env.local)
```

`.env.local` (raíz) contiene `DATABASE_URL`. **Nunca commitear ni loguear sus valores.** Sin el archivo, la app compila y corre en modo local puro.

## Arquitectura (mapa rápido)

| Archivo | Rol |
|---|---|
| `src/lib/types.ts` | Tipos (IDs UUID string desde v4 del esquema) |
| `src/lib/db.ts` | Dexie, migraciones v2→v4, `exportData`/`validateImport`/`importValidatedData`, `initDB` |
| `src/lib/importValidation.ts` | Validador puro de JSON importado (whitelist, sin tocar BD) |
| `src/lib/routineImages.ts` | Compresion de imagenes en cliente (`comprimirImagen`) y bytes para el respaldo (`bytesDeDataUrl`) |
| `src/lib/sync.ts` | Push/pull LWW contra `/api/sync`, triggers, `syncState`, contrato de rechazos y desfase de reloj |
| `src/server/` | Drizzle + Neon (`db.ts`, `schema.ts`, `auth.ts`) |
| `src/components/` | Svelte 5 runes; `Dashboard` (shell), `DailyView` (Día) + `WeeklyGrid` (Semana, drag con motor compartido), `ActivityModal`, `SettingsPanel` (lazy) |
| `src/lib/toast.ts` | Sistema de toasts propio — prohibido `alert()`/`confirm()` nativos |

## Reglas duras (romper alguna = bug en producción)

1. **Svelte 5 runes only**: `$state`/`$derived`/`$props`/callbacks. Nada de `export let`, `createEventDispatcher` ni `svelte:component`.
2. **`$state` → IndexedDB**: pasar siempre por `$state.snapshot()` antes de `db.put()` (structured clone no clona Proxies — DataCloneError).
3. **Toda mutación local** setea `updatedAt: Date.now()` — el sync incremental y el LWW dependen de ello.
4. **Import de datos**: solo vía `validateImport()` → confirmación UI → `importValidatedData()`. Nunca escribir BD con datos sin normalizar.
5. **Touch targets ≥ 44px** en toda acción táctil; `aria-label` en todo botón icónico; label programático en todo input.
6. **Drag & drop**: Día y Semana usan `src/lib/dragEngine.ts` (Pointer Events: mouse por umbral 5px, táctil por long-press 400ms — SIN quiet-hold: el dedo quieto nunca cancela el drag ni abre menú; Esc cancela, touchmove no pasivo, auto-scroll rAF, filtro por `pointerId`). Semántica "adelantar posiciones" (v2): soltar en hueco libre llena el hueco; si el hueco es más CHICO que el bloque → INSERCIÓN CERCANA (nunca ⛔: el vecino más próximo al dedo recibe la mitad y el empuje acomoda, absorbiendo huecos); sobre un bloque, MITAD SUPERIOR = insertar ANTES y MITAD INFERIOR = insertar DESPUÉS (rotación del tramo que conserva duraciones y huecos) — **reemplazos/intercambios PROHIBIDOS**; estirar SIEMPRE TOPA (nunca se rechaza): el deseo del puntero se acota por la capacidad del día — hueco real del lado + cadena hasta el borde; en Semana por la capacidad GLOBAL (mínima entre los días de la actividad, `capacidadResizeWeekly`) — y empuja vecinos en cadena TRANSITIVA: todo bloque que se corre queda como PARED en TODOS sus días (el horario de un bloque es global; el veto viejo "si correrlo rompe otro de sus días, no lo corras" abortaba la cadena a mitad y dejaba el gesto entero muerto con "No cabe"); ENCOGER siempre está permitido; al estirar, `limitadoPor` reporta a la vista con qué topó ('un bloque' / 'el fin del día' / 'el inicio del día') para el feedback del fantasma; en Semana, MOVER cierra los choques multi-día con EMPUJE EN CADENA transitivo (cada bloque cambiado es una pared en todos sus días; ⛔ solo si una cadena desborda el rango de algún día, con el nombre del día en el motivo); inválido (solo mover) → fantasma rojo y el bloque VUELVE (nada se escribe); toasts de drag auto-cerrables (3.2s), jamás persistentes. El menú contextual es solo mouse (click derecho); "Duplicar" vive en el modal de edición. Lo que se ve en el preview es lo que se guarda. El asa LATERAL de la Semana hace dos barridos (cruzando columnas, no de día en día): al ganar, la tira salta los días que el bloque ya tiene y sigue (con la Rutina en Lunes y Jueves, el asa del Lunes gana también lo que viene después del Jueves); al RETIRAR devuelve la lista completa si el barrido cubre la corrida entera, y entonces la actividad se ELIMINA (borrarActividad: tombstone + ediciones temporales + un paso de deshacer) — nunca queda un bloque sin días. La matemática vive SOLO en `src/lib/cascade.ts` (`resolveDayCascade`/`resolveResizeDay`/`resolveNudgeDay`/`propagateWeekly`, minutos enteros; el dedo crudo decide la mitad, el snap lo aplica la vista; los candados de rango comparan en la MISMA unidad que los slots). Prohibido HTML5 DnD (no funciona en táctil). Las categorías de Ajustes usan `svelte-dnd-action` con `dragHandle` + `delayTouchStart`.
7. **Español** en UI, commits y docs. CSS con tokens existentes (`--color-green-dark`, etc.), glassmorphism.
   **Colores solo por token**: todo color de superficie, texto, borde o lavado se escribe `rgb(var(--token) / alfa)` con la tripleta definida en `src/styles/global.css` (familias `--sup`, `--texto`, `--tinta`, `--verde-*`, `--rojo-*`, `--ambar-*`, `--linea`, `--lavado`…). Prohibido un hex, un `rgba()` o un `white` suelto en un `<style>`: el modo oscuro se define pisando esas tripletas, así que un color suelto se queda claro en oscuro (y con texto blanco encima tiene que llegar a 4,5:1 en los DOS temas; lo vigila el guard de contraste de `tests/accessibility.spec.ts`). El tema (claro/oscuro/sistema) vive en `src/lib/tema.ts`, se persiste en `settings` (viaja en el sync) y se pinta como `data-tema` en `<html>`, que el `<head>` resuelve antes del primer pintado para que no haya destello.
8. **Sync: los dos lados tienen que ser honestos**. El `pushed` que devuelve `/api/sync` son filas **escritas**, no enviadas: el guard LWW (`where updatedAt < incoming`) no da error cuando no escribe, así que va después del recuento real y todo lo rechazado vuelve en `rechazados` con la fecha que tiene el servidor. El cliente **nunca avanza `lastPushAt` por encima de una fila rechazada** (el filtro de "qué va en el siguiente push" es `>` estricto: un empuje de más convierte la fila en una fila muerta) y la re-sella por encima antes de reencolar. Y como el LWW compara fechas, lo que sale viaja sellado en el **reloj del servidor** (`sellarParaServidor` con el desfase que enseña cada `serverTime`): sin eso, un dispositivo con la hora atrás nace con cada cambio ya rechazado. Toda esta aritmética es pura y vive con test en `src/lib/sync.test.ts`; el mock de `tests/sync.spec.ts` reproduce el guard LWW de verdad (contar "la fila llegó a la nube", no "la fila se mandó").
9. **Verificación antes de commit**: `bun test` + `bun run build` en verde; cambios de UI → smoke en el preview del hilo.

## Git

- Commits atómicos por fase, mensajes en español explicando el "por qué".
- **Commit y push sin pedir confirmación** (pedido explícito del usuario): `main` + espejo `feat/cloud-sync`. Única excepción: avisar antes si el cambio **puede romper producción** — a saber: pérdida de datos o migraciones irreversibles (esquema Drizzle), caminos de auth/credenciales, o lógica de integridad del sync (cursor LWW). Ante la duda en esas tres, preguntar antes de tocar.
- Push a `main` (dispara deploy Vercel) y espejo a `feat/cloud-sync`: `git push origin main:feat/cloud-sync`.
- Tags semver (`v0.2.x`) en releases. PRs verificados por CI (`.github/workflows/ci.yml`).
- OneDrive es lento: evitar operaciones masivas sobre `node_modules`.

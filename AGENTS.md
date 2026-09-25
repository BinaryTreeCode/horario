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
| `src/lib/sync.ts` | Push/pull LWW contra `/api/sync`, triggers, `syncState` |
| `src/server/` | Drizzle + Neon (`db.ts`, `schema.ts`, `auth.ts`) |
| `src/components/` | Svelte 5 runes; `Dashboard` (shell), `ScheduleBoard` (grilla semana/día con drag propio), `ActivityModal`, `SettingsPanel` (lazy) |
| `src/lib/toast.ts` | Sistema de toasts propio — prohibido `alert()`/`confirm()` nativos |

## Reglas duras (romper alguna = bug en producción)

1. **Svelte 5 runes only**: `$state`/`$derived`/`$props`/callbacks. Nada de `export let`, `createEventDispatcher` ni `svelte:component`.
2. **`$state` → IndexedDB**: pasar siempre por `$state.snapshot()` antes de `db.put()` (structured clone no clona Proxies — DataCloneError).
3. **Toda mutación local** setea `updatedAt: Date.now()` — el sync incremental y el LWW dependen de ello.
4. **Import de datos**: solo vía `validateImport()` → confirmación UI → `importValidatedData()`. Nunca escribir BD con datos sin normalizar.
5. **Touch targets ≥ 44px** en toda acción táctil; `aria-label` en todo botón icónico; label programático en todo input.
6. **Drag & drop**: Día y Semana son UNA grilla, `src/components/ScheduleBoard.svelte` (Pointer Events directos: mouse por umbral 6px, táctil por long-press 350ms, Esc cancela, touchmove no pasivo, auto-scroll rAF, fantasma flotante con validez en vivo y filtro por `pointerId`). Semántica "hueco libre" (infografía): mover SOLO a hueco libre — soltar sobre un bloque ocupado es ⛔ y vuelve —; estirar por los bordes come el hueco real y empuja vecinos en cadena; nada sale de `[startHour, endHour]`. La matemática vive SOLO en `src/lib/cascade.ts` (`planMover`/`planResize`, minutos enteros). Prohibido HTML5 DnD (no funciona en táctil). Las categorías de Ajustes usan `svelte-dnd-action` con `dragHandle` + `delayTouchStart`.
7. **Español** en UI, commits y docs. CSS con tokens existentes (`--color-green-dark`, etc.), glassmorphism.
8. **Verificación antes de commit**: `bun test` + `bun run build` en verde; cambios de UI → smoke en el preview del hilo.

## Git

- Commits atómicos por fase, mensajes en español explicando el "por qué".
- Push a `main` (dispara deploy Vercel) y espejo a `feat/cloud-sync`: `git push origin main:feat/cloud-sync`.
- Tags semver (`v0.2.x`) en releases. PRs verificados por CI (`.github/workflows/ci.yml`).
- OneDrive es lento: evitar operaciones masivas sobre `node_modules`.

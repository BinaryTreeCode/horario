# AGENTS.md — Nature Planner (horario)

App de planificación de horarios **local-first, mobile-first**: IndexedDB (Dexie) como fuente local, sync opcional LWW a Neon Postgres vía API SSR de Astro. Deploy: Vercel (push a `main`).

## Comandos (el proyecto es 100% bun — nunca npm)

```bash
bun install          # dependencias (lockfile canónico: bun.lock)
bun run dev          # dev server en http://localhost:4321/
bun test             # tests unitarios y de dominio (siempre deben pasar antes de commit)
bun run build        # build de producción (adapter Vercel)
bun run test:a11y    # suite de accesibilidad Playwright (axe-core, contraste, touch targets)
bunx drizzle-kit push  # migraciones → DATABASE_URL (requiere .env.local)
```

`.env.local` (raíz) contiene `DATABASE_URL`. **Nunca commitear ni loguear sus valores.** Sin el archivo, la app compila y corre en modo local puro.

## Arquitectura (mapa rápido)

| Directorio / Archivo | Reglas y Rol |
|---|---|
| `src/components/` | Svelte 5 runes, UI glassmorphism, accesibilidad, tokens CSS → [`src/components/AGENTS.md`](src/components/AGENTS.md) |
| `src/lib/` | Dexie (IndexedDB), DnD (`dragEngine`/`cascade`), sync cliente LWW, cripto → [`src/lib/AGENTS.md`](src/lib/AGENTS.md) |
| `src/server/` & `src/pages/api/` | Astro SSR, Drizzle + Neon, auth scrypt, rate limiting, sync server LWW → [`src/server/AGENTS.md`](src/server/AGENTS.md) |
| `tests/` | Playwright E2E, a11y axe-core, sync LWW mock → [`tests/AGENTS.md`](tests/AGENTS.md) |
| `.agents/skills/` | Skills operativas (`validar-release`, `auditar-ui`, `sync-lww-check`, `git-sync-ops`) |

## Reglas duras globales (romper alguna = bug en producción)

1. **Svelte 5 runes only**: `$state`/`$derived`/`$props`/callbacks. Nada de `export let`, `createEventDispatcher` ni `svelte:component` ([detalle en UI](src/components/AGENTS.md)).
2. **`$state` → IndexedDB**: pasar siempre por `$state.snapshot()` antes de `db.put()` (evita `DataCloneError`; [detalle en lib](src/lib/AGENTS.md)).
3. **Toda mutación local** setea `updatedAt: Date.now()` — el sync incremental y el LWW dependen de ello.
4. **Import de datos**: solo vía `validateImport()` → confirmación UI → `importValidatedData()`. Prohibido escribir datos sin normalizar.
5. **Touch targets ≥ 44px**, `aria-label` en botones icónicos, label programático en inputs, toasts propios (`src/lib/toast.ts`, prohibido `alert()`/`confirm()`).
6. **Drag & drop**: Pointer Events (`dragEngine.ts`), cascada transitiva (`cascade.ts`), sin HTML5 DnD ([detalle exhaustivo en lib](src/lib/AGENTS.md)).
7. **Español** en UI, commits y docs. **Colores solo por token CSS**: `rgb(var(--token) / alfa)` desde `src/styles/global.css`; prohibido hex/rgba suelto; contraste ≥ 4.5:1 en ambos temas (`tema.ts`).
8. **Sync honesto**: `/api/sync` cuenta filas *escritas* en `pushed`; cliente no avanza `lastPushAt` sobre `rechazados`; fecha con reloj del servidor (`sellarParaServidor`). Zona Roja: consultar antes de tocar LWW.
9. **Verificación antes de commit**: `bun test` + `bun run build` siempre en verde; cambios de UI → `bun run test:a11y` y smoke preview.

## Git

- Commits atómicos por fase, mensajes en español explicando el "por qué".
- **Commit y push sin pedir confirmación** (pedido explícito del usuario): `main` + espejo `feat/cloud-sync`. Única excepción: avisar antes si el cambio **puede romper producción** — a saber: pérdida de datos o migraciones irreversibles (esquema Drizzle), caminos de auth/credenciales, o lógica de integridad del sync (cursor LWW). Ante la duda en esas tres, preguntar antes de tocar.
- Push a `main` (dispara deploy Vercel) y espejo a `feat/cloud-sync`: `git push origin main:feat/cloud-sync`.
- Tags semver (`v0.2.x`) en releases. PRs verificados por CI (`.github/workflows/ci.yml`).
- OneDrive es lento: evitar operaciones masivas sobre `node_modules`.

## Flujo de trabajo y delegación

- **Agente principal (Manager y Arquitecto)**: analiza el código, diseña la arquitectura, redacta planes de desarrollo detallados y ejecuta cambios puntuales o críticos (especialmente en migraciones/pérdida de datos, auth/credenciales o integridad del sync LWW). Revisa los cambios de los subagentes y valida el resultado final antes de reportar.
- **Subagente `flash` (Código)**: implementa features, refactors y tests siguiendo el plan y las especificaciones del agente principal, respetando todas las reglas de este `AGENTS.md`. Si se paralelizan ediciones, usar workspace aislado (`share` tipo worktree) para evitar conflictos y sin duplicar `node_modules`.
- **Subagente `flash_lite` (Operaciones ligeras)**: ejecuta tareas mecánicas y rápidas como `bun install`, chequeos simples, commits atómicos en español y `push` a `main` + espejo `feat/cloud-sync`.

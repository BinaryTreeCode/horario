# Missions y Skills para Freebuff — textos listos

Copia/pega estos textos en la UI de Freebuff (Project settings → Mission / Skills ➕).

## Missions

### Auditar y corregir (Effort sugerido: 3)
> Audita {área} de la app Nature Planner. Aplica las correcciones encontradas respetando las convenciones de AGENTS.md. Valida con `bun test`, `bun run build` y smoke test en el preview del hilo. Haz commits atómicos por fase con mensajes en español, push a `main` y espejo a `feat/cloud-sync`. Reporta antes/after medido, no impresiones.

{área} ejemplos: "la UX de la vista Semana", "el sistema de sync", "la accesibilidad del modal de actividad", "el rendimiento del primer render".

### Release (Effort sugerido: 2)
> Prepara una release del Nature Planner: verifica `bun test` y `bun run build` en verde, actualiza el README si algo documentado cambió, resume los commits desde el último tag, crea commit de release, tag semver incremental (patch si solo fixes, minor si hay features), push a `main` (dispara deploy Vercel) y espejo a `feat/cloud-sync`, y empuja el tag. Verifica que el deploy de producción responde HTTP 200.

### Deploy check (Effort sugerido: 1)
> Verifica el deploy de producción de https://horario-taupe.vercel.app/: HTTP 200 del HTML, presencia del splash, tamaño gzip del chunk principal de Dashboard (esperado ≤ 30 KB), ausencia de chunk legacy de Svelte, y consola limpia. Reporta cualquier regresión comparando con lo esperado en AGENTS.md.

## Skills

### bun-validate
> Ejecuta `bun test` y `bun run build`, resume resultados (tests pass/fail, tiempo de build) y los tamaños gzip de los chunks principales en `.vercel/output/static/_astro/`. Falla si algo no está verde.

### audit-ui
> Recorre en el preview las vistas Semana, Día, modal de actividad y Ajustes midiendo en el DOM real: touch targets (mínimo 44px), contrastes de texto, overflow horizontal, truncado de texto y aria-labels faltantes. Reporta hallazgos por severidad con el valor medido, sin modificar archivos.

### deploy-check
> Comprueba https://horario-taupe.vercel.app/: código HTTP, cabecera X-Vercel-Cache del HTML, tamaño del chunk Dashboard y presencia del splash. Reporta diferencias contra el último deploy conocido.

## Config recomendada

| Contexto | Configuración |
|---|---|
| Fixes y tareas medianas | Mission **Commit**, Effort 2–3 |
| Lo que toca `main` (con CI ya en verde) | Mission **Merge PR**, Effort 3 |
| Auditorías solo-lectura | Mission **Explore**, Effort 3 |
| Refactor grande (ej. migración runes) | Mission **Commit**, Effort 4–5 |
| Startup script (ya configurado) | `bun install` |

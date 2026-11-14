---
name: sync-lww-check
description: Audita y verifica la integridad del protocolo de sincronización Last-Write-Wins (LWW) y cifrado E2E entre el cliente (src/lib/sync.ts), el servidor (src/pages/api/sync.ts) y los tests (tests/sync.spec.ts). Valida conteo honesto de pushed, lista de rechazados, avance de lastPushAt y reloj del servidor. Actívala antes de modificar sincronización, persistencia o esquemas.
---

# Skill: Verificación de Integridad Sync LWW (`sync-lww-check`)

Esta skill establece el protocolo técnico para verificar la coherencia e integridad del sistema de sincronización Last-Write-Wins (LWW) entre cliente local (IndexedDB), servidor Astro SSR (Postgres) y la suite de pruebas.

> [!CAUTION]
> El sync de Nature Planner se basa en el principio de que **ambos lados deben ser absolutamente honestos**. Cualquier desviación en el recuento de escrituras, manejo de cursores o desfase de reloj puede causar pérdida de datos o filas huérfanas en producción.

---

## Puntos Críticos de Verificación

### 1. Honestidad en el Servidor (`src/pages/api/sync.ts`)
- **Conteo real de `pushed`**:
  Verificar que `pushed` incremente **únicamente** tras la confirmación de escritura en base de datos bajo el guard LWW (`where updatedAt < incoming`):
  ```ts
  // Contrato de rechazo en src/pages/api/sync.ts:
  // 'a' activities · 'c' categories · 's' settings · 'o' dayOverrides
  // rechazados.push({ t, k, u: serverUpdatedAt })
  ```
- **Reporte de `rechazados`**:
  Toda fila que no se haya escrito porque su `updatedAt` era inferior o igual a la existente en BD debe devolverse en `rechazados` (`{ t, k, u }`) con su fecha real en el servidor.
- **Marca temporal `serverTime`**:
  La respuesta JSON del endpoint debe incluir siempre `serverTime: Date.now()`.

### 2. Contrato del Cliente (`src/lib/sync.ts`)
- **Sellado con reloj del servidor (`sellarParaServidor`)**:
  Verificar que las mutaciones enviadas al servidor compensen el desfase local calculado a partir de `serverTime`:
  ```ts
  const desfaseReloj = serverTime - horaLocalAlRecibir;
  ```
  Evita que clientes con la hora desajustada sufran rechazos continuos.
- **Cursor estricto `lastPushAt`**:
  - El filtrado de datos salientes debe ser estrictamente `updatedAt > lastPushAt`.
  - **Invariante**: `lastPushAt` jamás debe avanzar por encima de una fila rechazada. Si el servidor devuelve filas en `rechazados`, el cursor se detiene o la fila rechazada debe re-sellarse por encima antes de reintentar.
- **Tombstones**:
  Las eliminaciones locales se marcan con `deletedAt: Date.now()`, se sincronizan a la nube y se procesan como updates ordinarios bajo la misma regla LWW.

### 3. Criptografía E2E (`src/lib/crypto.ts`)
- **Preservación de contenido cifrado**:
  Si la clave o passphrase de cifrado de extremo a extremo no está presente en la sesión actual, los datos cifrados recibidos o locales deben preservarse intactos en su formato cifrado. Bajo ninguna circunstancia deben sobreescribirse con cadenas vacías ni provocar fallos catastróficos en el sync.

### 4. Fidelidad del Mock de Pruebas (`tests/sync.spec.ts` y `src/lib/sync.test.ts`)
- Verificar que los tests unitarios y los mocks de Playwright simulen el guard LWW real (verificando fechas reales y no incrementando contadores ciegamente al recibir el payload).

---

## Procedimiento de Auditoría

1. **Ejecutar tests unitarios de sincronización y cripto**:
   ```bash
   bun test src/lib/sync.test.ts src/lib/crypto.test.ts
   ```
2. **Ejecutar pruebas E2E de sincronización**:
   ```bash
   bunx playwright test tests/sync.spec.ts
   ```
3. **Revisión estática de código (Checklist)**:
   - [ ] ¿`src/pages/api/sync.ts` calcula `pushed` basándose en filas escritas y no en filas recibidas?
   - [ ] ¿Las filas rechazadas se devuelven en `rechazados` con su fecha del servidor?
   - [ ] ¿El servidor devuelve `serverTime`?
   - [ ] ¿`src/lib/sync.ts` usa `sellarParaServidor` con el desfase calculado?
   - [ ] ¿`lastPushAt` se protege de avanzar sobre filas rechazadas?
   - [ ] ¿`tests/sync.spec.ts` replica este comportamiento sin atajos?

---

## Formato del Dictamen

Emitir el resultado de la auditoría:
```markdown
### Dictamen de Integridad Sync LWW

- **Honestidad Servidor (`pushed`)**: [CONFORME / NO CONFORME]
- **Gestión de Rechazados**: [CONFORME / NO CONFORME]
- **Cursor `lastPushAt` y Desfase**: [CONFORME / NO CONFORME]
- **Preservación Cripto E2E**: [CONFORME / NO CONFORME]
- **Tests Unitarios y E2E**: [VERDE / FALLAS]
- **Conclusión**: [SISTEMA ÍNTEGRO / REQUIERE INTERVENCIÓN]
```

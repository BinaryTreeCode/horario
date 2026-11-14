# AGENTS.md — Estrategia y Ejecución de Pruebas (`tests/`)

Este documento establece las directrices para la creación, ejecución y mantenimiento de la suite de pruebas unitarias y de integración de Nature Planner.

---

## 1. Separación de Suites (`bun test` vs. Playwright)

- **Pruebas de Dominio y Lógica Pura (`bun test`)**:
  - Configurado en `bunfig.toml` con `root = "./src"`.
  - Ejecuta exclusivamente pruebas unitarias locales (`src/**/*.test.ts`), abarcando:
    - Cascada y colisiones horarias (`cascade.test.ts`).
    - Validación y sanitización de importaciones (`importValidation.test.ts`, `backupFile.test.ts`).
    - Lógica de sincronización y reloj cliente (`sync.test.ts`).
    - Criptografía E2E (`crypto.test.ts`).
    - Formato y utilidades temporales (`timeUtils.test.ts`, `timeStats.test.ts`).
  - **Invariante**: `bun test` debe completarse al 100% en verde antes de cualquier commit.
- **Pruebas de Interfaz y E2E (Playwright)**:
  - Archivos ubicados en `tests/*.spec.ts`.
  - Se ejecutan mediante:
    ```bash
    bun run test:a11y          # suite completa de accesibilidad y contraste
    bunx playwright test       # suite completa de pruebas Playwright
    ```
  - `bun test` tiene explícitamente excluida la carpeta `tests/` para evitar colisiones con las APIs de `@playwright/test`.

---

## 2. Suite de Accesibilidad (`tests/accessibility.spec.ts`)

La suite de accesibilidad audita rigurosamente los estándares WCAG 2.1 AA sobre el DOM real renderizado:

- **Auditoría con axe-core**:
  - Se valida navegación por teclado, roles ARIA, labels semánticos y contraste de color.
  - **Prohibición absoluta**: Está terminantemente prohibido silenciar reglas de `axe-core`, omitir advertencias o relajar umbrales de fallo en `tests/accessibility.spec.ts` para forzar un pase en verde.
- **Verificación Bitemática Obligatoria**:
  - Las aserciones de contraste deben ejecutarse y pasar tanto en tema claro (`data-tema="claro"`) como en tema oscuro (`data-tema="oscuro"`).
  - Umbral mínimo: **4.5:1** para texto normal y **3:1** para texto grande o controles esenciales.
- **Auditoría de Touch Targets**:
  - Cada elemento accionable debe alcanzar una caja de toque de al menos **44px × 44px**. El test mide la caja delimitadora real (`boundingBox()`) de los nodos interactivos.

---

## 3. Suite de Sincronización Mockeada (`tests/sync.spec.ts`)

- **Fidelidad del Guard LWW**:
  - El servidor simulado (mock) en `tests/sync.spec.ts` debe reproducir con exactitud el comportamiento real de `/api/sync`:
    - Evaluar la condición `where updatedAt < incoming.updatedAt`.
    - Incrementar el contador `pushed` únicamente cuando se verifique la persistencia de la fila.
    - Devolver en `rechazados` cualquier registro entrante cuya versión sea obsoleta frente al servidor.
  - **Prohibición**: El mock nunca debe asumir que recibir una petición POST equivale automáticamente a persistir la fila.
- **Verificación de Desfase y Cripto**:
  - Los tests deben asegurar que `lastPushAt` no avance en presencia de rechazos y que los campos cifrados no se vacíen en ausencia de passphrase.

---

## 4. Estabilidad de Selectores y Limpieza de Estado

- **Locators Resilientes**:
  - Priorizar selectores estables por identificador (`#id`), atributos de prueba (`data-testid`) o expresiones regulares multilingües (p.ej. `/guardar|save/i`) para tolerar cambios entre español e inglés (`i18n`).
  - Evitar selectores acoplados a clases utilitarias de maquetación volátiles.
- **Aislamiento de IndexedDB**:
  - Toda prueba de navegador debe reiniciar y limpiar la base de datos local `ScheduleDB` en sus hooks (`beforeEach` / `afterEach`) para prevenir contaminación cruzada de datos entre ejecuciones.

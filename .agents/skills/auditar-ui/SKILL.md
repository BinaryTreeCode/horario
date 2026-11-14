---
name: auditar-ui
description: Realiza una auditoría visual, de accesibilidad y diseño mobile-first en modo solo-lectura sobre el DOM real de Nature Planner. Mide touch targets (≥ 44px), ratios de contraste en claro y oscuro, ausencia de desbordamiento horizontal y aria-labels en Semana, Día, ActivityModal y SettingsPanel. Actívala tras modificar componentes o estilos.
---

# Skill: Auditar UI y Accesibilidad (`auditar-ui`)

Esta skill proporciona una guía estricta y reproducible para auditar en modo **solo-lectura** la interfaz gráfica, ergonomía táctil y accesibilidad de Nature Planner sobre el DOM real renderizado.

> [!NOTE]
> Esta operación es exclusivamente de inspección y medición. No modifica código fuente ni altera archivos de configuración.

---

## Dimensiones de la Auditoría

### 1. Touch Targets (Ergonomía Móvil ≥ 44px)
Todo control interactivo debe tener un área efectiva de pulsación de al menos `44px × 44px`:
- **Vistas a inspeccionar**:
  - `WeeklyGrid`: Botones de cabecera, selector de días, celdas interactivas, asas laterales y de redimensionamiento (`resize-handle`).
  - `DailyView`: Bloques de actividades, botones de acción rápida, asa de arrastre.
  - `ActivityModal`: Pestañas, botones de categoría, selector de color, checkboxes, botón de guardar/cerrar.
  - `SettingsPanel`: Toggles de configuración, botones de importación/exportación, handles de arrastre de categorías (`dragHandle`).
- **Comprobación en Playwright**:
  ```ts
  const box = await element.boundingBox();
  // box.width >= 44 && box.height >= 44
  ```

### 2. Ratios de Contraste Bitemático (WCAG 2.1 AA)
Verificar que la combinación de color de texto sobre su fondo cumpla con los umbrales mínimos:
- **Texto estándar**: Contraste mínimo **4.5:1**.
- **Texto grande o componentes interactivos esenciales**: Contraste mínimo **3.0:1**.
- **Auditoría dual obligatoria**:
  1. En tema claro (`data-tema="claro"` o `:root` por defecto).
  2. En tema oscuro (`document.documentElement.dataset.tema = 'oscuro'`).
- **Puntos críticos**:
  - Texto de actividades sobre sus fondos cromáticos de categoría (`--sobre-color`).
  - Textos secundarios y terciarios (`--texto-2`, `--texto-3`).
  - Bordes de inputs activos y estados de foco (`:focus-visible`).

### 3. Ausencia de Desbordamiento Horizontal (Overflow)
En viewports móviles (p.ej. 375px × 667px y 390px × 844px):
- Ningún contenedor padre debe provocar barra de desplazamiento horizontal no intencional en la ventana principal (`window.innerWidth === document.documentElement.scrollWidth`).
- Las tablas o cuadrículas (`WeeklyGrid`) que tengan desplazamiento horizontal interno deben contenerlo estrictamente dentro de su propio contenedor con `overflow-x: auto` sin romper el layout exterior.

### 4. Cobertura de Nombres Accesibles (`aria-label`)
- Comprobar que ningún botón icónico carezca de nombre accesible:
  - Botones de cerrar (cruces `✕`).
  - Flechas de navegación o colapso.
  - Botones de duplicar, editar o eliminar.
- Verificar que los campos de formulario (`<input>`, `<select>`, `<textarea>`) cuenten con su correspondiente `<label>` asociado o `aria-labelledby`.

---

## Procedimiento de Ejecución

1. Asegurar que el entorno de desarrollo esté disponible o ejecutar pruebas headless de Playwright:
   ```bash
   bun run test:a11y
   ```
2. Para inspecciones exploratorias interactivas, levantar el servidor local y abrir el navegador en modo emulación móvil:
   ```bash
   bun run dev
   ```

---

## Plantilla del Reporte de Auditoría

Estructurar los resultados encontrados agrupados por componente y clasificados por severidad:

```markdown
### Reporte de Auditoría de UI

| Componente | Elemento Inspeccionado | Métrica Medida | Requisito Esperado | Severidad | Estado |
|---|---|---|---|---|---|
| `WeeklyGrid` | Asa de redimensionado | 44px × 48px | ≥ 44px × 44px | - | CUMPLE |
| `ActivityModal` | Botón cerrar | aria-label="Cerrar" | Etiqueta presente | - | CUMPLE |
| `DailyView` | Texto de hora secundaria | 4.8:1 (claro) / 5.1:1 (oscuro) | ≥ 4.5:1 | - | CUMPLE |
| `SettingsPanel` | Botón backup | 44px × 44px | ≥ 44px × 44px | - | CUMPLE |

**Hallazgos y Observaciones**:
- Detalle específico de cualquier incumplimiento con valores numéricos exactos medidos en el DOM.
```

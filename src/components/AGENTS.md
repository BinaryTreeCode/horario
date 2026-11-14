# AGENTS.md — Reglas de Componentes y UI (`src/components/`)

Este documento rige el desarrollo, refactorización y mantenimiento de la interfaz de usuario en Nature Planner (`src/components/`). Aplica a vistas principales (`DailyView`, `WeeklyGrid`), shell (`Dashboard`), modales (`ActivityModal`, `ColorMixerModal`, `ConfirmDialog`, `ImageLightbox`), ajustes (`SettingsPanel`) y componentes auxiliares.

---

## 1. Svelte 5 Runes Only

Todo componente debe estar escrito estrictamente bajo la sintaxis de **Svelte 5 Runes**:
- **Estado y Reactividad**: Usar exclusivamente `$state()`, `$state.raw()` (para colecciones grandes o inmutables) y `$derived()` / `$derived.by()`.
- **Props**: Usar `$props()` con destructuración tipada e interfaces TypeScript claras:
  ```svelte
  <script lang="ts">
    interface Props {
      actividadId: string;
      onCerrar: () => void;
      soloLectura?: boolean;
    }
    let { actividadId, onCerrar, soloLectura = false }: Props = $props();
  </script>
  ```
- **Prohibiciones absolutas**:
  - `export let` (sintaxis Svelte 3/4 obsoleta).
  - `createEventDispatcher` (usar callbacks pasados como props, p.ej. `onGuardar={...}`).
  - `<svelte:component this={...}>` (en Svelte 5 los componentes son valores de primera clase; usar `<Componente />` dinámico directamente).

---

## 2. Sistema de Color, Tokens CSS y Modo Oscuro

Nature Planner utiliza un sistema de diseño estricto basado en CSS Glassmorphism y tokens semánticos definidos en `src/styles/global.css`:

- **Tokens obligatorios**: Todo color de superficie, texto, borde, foco o lavado debe escribirse en formato `rgb(var(--token) / alfa)` usando las tripletas de `src/styles/global.css`:
  - Superficies: `--sup`, `--sup-2`, `--sup-calido`.
  - Texto: `--texto`, `--texto-2`, `--texto-3`, `--texto-calido`, `--sobre-color`.
  - Tinta y neutros: `--tinta`, `--tinta-solida`, `--gris-solido`, `--gris-medio`, `--linea`, `--lavado`, `--sombra`, `--velo`, `--borde-blanco`.
  - Semánticos: `--verde-*`, `--rojo-*`, `--ambar-*`.
- **Prohibición de valores fijos**: Está terminantemente prohibido utilizar valores hexadecimales (`#ffffff`, `#1a1a1a`), funciones `rgba(...)` literales o palabras clave como `white`/`black` dentro de etiquetas `<style>`.
- **Contraste y Accesibilidad Visual**:
  - Todo elemento de texto debe mantener un ratio de contraste mínimo de **4.5:1** contra su fondo (3:1 para texto grande o elementos gráficos esenciales).
  - El cumplimiento del contraste debe sostenerse simultáneamente en ambos temas: **claro y oscuro**.
  - El tema activo vive en `src/lib/tema.ts`, se persiste en `settings` (viaja en el sync) y se inyecta como `data-tema="claro|oscuro"` en `<html>` (`:root` es claro por defecto; `:root[data-tema="oscuro"]` pisa las tripletas). El script inline en `<head>` de `Layout.astro` lo resuelve antes del primer pintado para evitar parpadeos.

---

## 3. Accesibilidad (A11y), Móvil y Gestión de Diálogos

La aplicación está diseñada bajo una filosofía **mobile-first**:

- **Dimensiones de toque (Touch Targets)**: Todo elemento interactivo (botones, inputs, selectores, pestañas, asas de redimensionado, filas clicables) debe tener un área táctil mínima de **44px × 44px**. Si el elemento visual es menor, debe expandirse mediante padding o pseudo-elementos (`::before` / `::after`).
- **Nombres accesibles y Etiquetas**:
  - Todo botón icónico sin texto visible debe poseer un `aria-label` descriptivo y traducido.
  - Todo campo de formulario (`<input>`, `<select>`, `<textarea>`) debe contar con un `<label>` programáticamente asociado mediante `for="..."` e `id="..."`.
- **Modales y Diálogos**:
  - Toda ventana emergente debe integrarse con `src/lib/dialogStack.ts` para gestionar el apilamiento y orden de cierre.
  - Los modales deben renderizarse en el nodo raíz usando `src/lib/portal.ts` para aislar contextos de apilamiento z-index.
  - El foco debe quedar atrapado dentro del modal activo mediante `src/lib/focus.ts`.
  - La pulsación de la tecla `Escape` debe cerrar únicamente el modal más superficial de la pila.

---

## 4. Sistema de Notificaciones y Toasts

- **Toasts propios**: Prohibido utilizar diálogos nativos del navegador (`alert()`, `confirm()`, `prompt()`). Todas las notificaciones y confirmaciones deben utilizar `src/lib/toast.ts` y componentes dedicados como `ConfirmDialog.svelte`.
- **Feedback de Drag & Drop**: Los mensajes informativos de arrastre y colisiones (p.ej. límites de horario o bloqueos) deben auto-cerrarse tras **3.2 segundos**, sin requerir interacción del usuario ni quedar persistentes en pantalla.

---

## 5. Internacionalización (i18n) y Ajustes

- **Textos centralizados**: Todo texto presentado al usuario debe gestionarse a través de `src/lib/i18n.ts` (español por defecto e inglés). Prohibido cablear strings literales en la plantilla.
- **Listas y Reordenamiento en Ajustes**: El reordenamiento de categorías y actividades en `SettingsPanel.svelte` se realiza exclusivamente mediante `svelte-dnd-action`, configurando `dragHandle` específico y `delayTouchStart` para no interferir con el desplazamiento vertical natural en dispositivos táctiles.

# AGENTS.md — Dominio Local, Motor de Arrastre y Sincronización Cliente (`src/lib/`)

Este documento especifica las invariantes fundamentales de la lógica de dominio, persistencia local con Dexie (IndexedDB), motor de gestos Pointer Events, algoritmo de cascada de horarios y sincronización en cliente.

---

## 1. Persistencia Local (IndexedDB / Dexie)

- **Desempaquetado de Proxies con `$state.snapshot()`**:
  Al persistir cualquier objeto o arreglo proveniente del estado reactivo de Svelte 5 (`$state`), debe pasarse inexcusablemente por `$state.snapshot(dato)` antes de llamar a `db.put()`, `db.add()` o `db.bulkPut()`. La API nativa `structuredClone` de IndexedDB falla con un `DataCloneError` al intentar clonar un Proxy reactivo.
- **Marca de tiempo en toda mutación local**:
  Toda modificación, creación o marcado de eliminación (`deletedAt`) en las tablas locales (`activities`, `categories`, `settings`, `dayOverrides`) debe asignar obligatoriamente:
  ```ts
  updatedAt: Date.now()
  ```
  El protocolo de sincronización incremental Last-Write-Wins (LWW) y el filtrado por cursor dependen estrictamente de esta propiedad. Desde v4 del esquema (`src/lib/types.ts`), los IDs son strings UUID.
- **Imágenes y respaldos**: `src/lib/routineImages.ts` gestiona compresión cliente (`comprimirImagen`) y bytes para respaldo (`bytesDeDataUrl`).
- **Importación y Restauración de Datos**:
  El flujo de importación de respaldos JSON es exclusivamente:
  ```
  validateImport(json) → Presentación/Confirmación en UI → importValidatedData(data)
  ```
  `validateImport()` (`src/lib/importValidation.ts`) es un validador funcional puro sin efectos secundarios que aplica lista blanca y normalización. Está terminantemente prohibido escribir en la base de datos datos importados sin normalizar.

---

## 2. Motor de Drag & Drop (`dragEngine.ts`) y Cascada (`cascade.ts`)

El sistema de arrastre y organización temporal es el núcleo funcional de la aplicación. Se rige por las siguientes especificaciones inmutables:

### 2.1. Motor de Punteros (`dragEngine.ts`)
- **Pointer Events unificados**: Día y Semana comparten `src/lib/dragEngine.ts`.
- **Umbrales de activación**:
  - Mouse: Movimiento mínimo de **5px**.
  - Táctil: Long-press sostenido de **400ms** **SIN quiet-hold** (el dedo quieto nunca cancela el drag ni despliega menú contextual; el menú contextual es exclusivo de mouse con clic derecho; la acción "Duplicar" reside en el modal de edición).
- **Control de gestos**:
  - Tecla `Escape` cancela el arrastre en curso inmediatamente.
  - Listener de `touchmove` no pasivo (`passive: false`) para cancelar el desplazamiento nativo durante el arrastre.
  - Desplazamiento automático (`auto-scroll`) gestionado con `requestAnimationFrame` en los límites de la vista.
  - Filtrado estricto por `pointerId` para evitar interferencias multitáctiles.
  - **Prohibido el uso de HTML5 Drag & Drop**: Carece de soporte confiable en pantallas táctiles móviles.

### 2.2. Algoritmo de Cascada y Distribución Horaria (`cascade.ts`)
Toda la lógica matemática y resolución de colisiones reside de forma aislada en `src/lib/cascade.ts` (`resolveDayCascade`, `resolveResizeDay`, `resolveNudgeDay`, `propagateWeekly`, `capacidadResizeWeekly`):

- **Semántica de "Adelantar Posiciones" (v2)**:
  - Soltar en un hueco libre: El bloque llena el espacio disponible.
  - Si el hueco es **más chico** que el bloque: **Inserción cercana** (nunca ⛔; el vecino más próximo al puntero recibe la mitad y el empuje acomoda el resto, absorbiendo huecos intermedios).
  - Soltar sobre un bloque ocupado:
    - **Mitad superior**: Insertar ANTES del bloque.
    - **Mitad inferior**: Insertar DESPUÉS del bloque.
    - Se realiza una rotación del tramo conservando duraciones relativas y huecos. **Los reemplazos o intercambios directos están PROHIBIDOS**.
- **Redimensionamiento (Estirar / Encoger)**:
  - **Estirar SIEMPRE TOPA** (nunca se rechaza): La intención del puntero se acota a la capacidad física del día (hueco real adyacente más la cadena elástica hasta el límite horario).
  - En la vista **Semana**: Se acota por la **capacidad GLOBAL** (la mínima capacidad entre todos los días en que la actividad está presente, calculada con `capacidadResizeWeekly`).
  - **Empuje en cadena TRANSITIVA**: Todo bloque empujado actúa como pared en **todos** los días en que existe (el horario de un bloque es global; vetar el empuje porque afecta a otro día abortaba la cadena a mitad y bloqueaba el gesto con "No cabe").
  - **Encoger** siempre está permitido.
  - Feedback visual: `limitadoPor` reporta a la interfaz contra qué colisionó el límite (`'un bloque'`, `'el fin del día'`, `'el inicio del día'`) para retroalimentar la vista previa del fantasma.
- **Desplazamiento Multi-Día en Semana**:
  - Al MOVER, las colisiones multi-día se resuelven mediante empuje en cadena transitivo.
  - Estado inválido (únicamente al mover cuando la cadena desborda el límite del día): El fantasma se tiñe de rojo y el bloque **retorna a su posición original** (nada se persiste). El motivo especifica el nombre del día desbordado.
  - Toasts informativos auto-cerrables en 3.2s, nunca persistentes. Lo visualizado en la vista previa fantasma es idéntico a lo que se persiste.
- **Asa Lateral en Vista Semana**:
  - Realiza dos barridos cruzando columnas (no paso a paso por día).
  - **Al extender**: La franja salta los días que el bloque ya ocupa y continúa propagando.
  - **Al retirar**: Si el barrido cubre la totalidad de los días del bloque, se invoca `borrarActividad()` (crea tombstone con `deletedAt`, revierte ediciones temporales y ofrece un paso de deshacer en `undo.ts`). **Nunca se permite que un bloque quede con 0 días asignados**.
- **Unidades de cálculo**: Minutos enteros. El puntero crudo decide mitades lógicas y el redondeo (snap) lo aplica la vista. Los candados de rango comparan siempre en la misma unidad que los slots temporales.

---

## 3. Sincronización Cliente LWW y Criptografía E2E (`sync.ts`, `crypto.ts`)

- **Alineación con el Reloj del Servidor (`sellarParaServidor`)**:
  Dado que el protocolo Last-Write-Wins (LWW) compara fechas absolutas, toda mutación que sale hacia la nube viaja sellada en el tiempo del servidor mediante `sellarParaServidor()`, compensando el desfase calculado a partir del campo `serverTime` de las respuestas. Sin esta corrección, un cliente con el reloj atrasado sufriría el rechazo sistemático de sus cambios.
- **Integridad del Cursor de Push (`lastPushAt`)**:
  - El filtro de elementos pendientes hacia el servidor es estrictamente mayor que (`updatedAt > lastPushAt`).
  - **El cliente jamás avanza `lastPushAt` por encima de una fila rechazada**. Si el servidor rechaza una fila (porque su versión en la nube es más moderna), la fila debe re-sellarse por encima antes de reintentar. Avanzar el cursor ignorando rechazos convertiría la fila local en un registro fantasma huérfano.
- **Preservación de Datos Cifrados**:
  Si la clave o frase de paso E2E no está disponible en la sesión local, los registros cifrados deben conservarse en su estado bruto sin sobrescribirse con valores vacíos ni desincronizarse.

---

## 4. Zona Roja: Protección de Integridad

> [!CAUTION]
> **REGLA DE ZONA ROJA**: La lógica de cálculo del cursor LWW (`lastPushAt`), el contrato de reintentos sobre `rechazados`, y la matemática de cascada transitiva en `cascade.ts` son componentes críticos. **Está terminantemente prohibido alterar su comportamiento o relajarlos sin consulta previa y confirmación explícita del usuario.**

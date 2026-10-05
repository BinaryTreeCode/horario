# 🌲 Nature Planner — Manual de usuario (UX)

Guía práctica de todo lo que puedes hacer con la app: cada gesto, sus reglas y qué feedback verás. La app es **local-first** (tus datos viven en tu navegador) con **sincronización opcional** a la nube.

---

## 1. Las dos vistas

| | Vista **Semana** | Vista **Día** |
|---|---|---|
| Para qué | Ver y ajustar la **plantilla semanal** completa | Vivir **el día de hoy** (o cualquier día) con detalle |
| Cambios | Escriben la **plantilla** (permanentes) | Son **temporales (⚡)**: solo ese día, salvo que uses "Plantilla semanal" |
| Cómo entrar | Pestaña "Semana" del header | Pestaña "Día", o **click en el nombre de un día** en la Semana |

- En la vista Día, el conmutador **"Solo este día" / "Plantilla semanal"** decide dónde se guardan tus cambios. Un badge **⚡** en el header del día indica que tiene cambios temporales; el botón **Restaurar** los descarta.
- La **línea roja con la hora actual** marca el momento en que estás. Vive en la **vista Día** (la Semana no la tiene) y se pinta siempre que la hora actual caiga dentro del rango del día que tenés en **Ajustes** (por defecto 7:00–23:00): a las 6 de la mañana no aparece porque todavía no empezó tu día. En el móvil el chip queda pegado al borde izquierdo de la cinta, con la flecha mirando a la derecha.

---

## 2. Crear, editar, eliminar

### Crear
- Botón **＋ (Nueva Actividad)** del header.
- **Tap en un hueco** de la vista Día: el modal se abre con esa hora precargada.
- **Click derecho en un hueco** (Día o Semana): menú "Crear actividad a las X" con la hora del punto exacto.

### Reglas al guardar
- El nombre es obligatorio (la categoría por defecto es "Rutina").
- ⛔ **No se puede crear una actividad que se solape** con una existente en alguno de los días elegidos: verás "⛔ Ya existe "trabajo" de 10:00 AM – 11:30 AM el Lunes" y el modal queda abierto para corregir hora o días.
- Si abriste desde un día (vista Día), eliges guardar **Solo este día** (override ⚡) o en la **plantilla semanal**.

### Editar
- **Click en cualquier tarjeta** abre el modal de edición.
- **↑ / ↓** con la tarjeta enfocada mueve el bloque ±15 min con empuje en cadena (ver §4).
- "Duplicar" vive en el menú contextual (click derecho sobre la tarjeta) y en el modal; busca el primer hueco libre.

### Eliminar
- Menú contextual (click derecho sobre la tarjeta) → **Eliminar**, con confirmación propia (nunca `confirm()` nativo).
- Todo borrado es deshacible con el botón **Deshacer** del header.

---

## 3. Mover bloques (drag & drop)

Común a Día y Semana: **mouse** arrastra directo; en **táctil** mantén pulsado un instante (long-press) y luego arrastra. **Esc** cancela siempre.

### Mismo día
- Suelta en un **hueco libre**: el bloque llena el hueco.
- Suelta **sobre otra tarjeta**: mitad superior = se inserta **antes**; mitad inferior = se inserta **después** (los vecinos se acomodan conservando duraciones y huecos). Nunca hay reemplazos ni intercambios.
- Si el hueco es **más chico** que el bloque → **inserción cercana**: el vecino más próximo al dedo recibe la mitad y el empuje acomoda, absorbiendo huecos.

### Entre días (Semana)
- Arrastra a otra columna: el bloque vive también ese día.
- Los choques multi-día se cierran con **empuje en cadena transitivo**; si una cadena desborda el rango de algún día → ⛔ con el nombre del día en el motivo y el bloque **vuelve** (nada se escribe).

### Feedback mientras arrastras
- **Fantasma flotante**: clon del bloque completo con su color, hora proyectada y anclado al punto de agarre.
- Caída inválida → fantasma **rojo**, sacudida (shake) al soltar y toast con el motivo. El silencio nunca es la respuesta: desde el primer fallo hay aviso.

---

## 4. Estirar verticalmente (duración)

Asas en el **borde superior e inferior** de cada tarjeta (aparecen al hacer hover; en táctil son la franja del borde).

| Regla | Detalle |
|---|---|
| **Estirar SIEMPRE topa** | El deseo del puntero se acota: topa con el vecino, con la cadena de vecinos, o con el borde del día. Nunca se rechaza ni trunca a nadie. |
| **Encoger siempre está permitido** | Aunque el bloque esté encajonado entre vecinos (sin hueco), las asas existen: el gesto solo encoge. |
| **Duración global (Semana)** | Al estirar en la Semana, la nueva duración viaja a **todos** los días de la actividad. Si el día más apretado no da más, verás el rótulo **"↕ Limitado por el día más apretado de la semana"**. |
| **Duración por día (Día)** | En la vista Día el estirar afecta solo ese día (override ⚡). |
| Preview | La tarjeta y sus vecinas se deslizan a la posición predicha **antes** de soltar; el rótulo junto al puntero dice con qué topaste: "un bloque", "el inicio del día" o "el fin del día". |

- **⌨️ Nudge**: con la tarjeta enfocada, ↑/↓ mueve ±15 min (cascada igual que el drag).

---

## 5. Estirar a los laterales (ganar o quitar días) — solo Semana

Asas angostas a **izquierda y derecha** de la tarjeta. Umbral: media columna.

| Gesto | Resultado |
|---|---|
| Asa derecha **hacia afuera** (→) | **GANA el día vecino** (mismas horas), validado con cascada. Cruzando varias columnas entra en **toda esa tira de una vez**. |
| Asa izquierda **hacia afuera** (←) | Simétrico: gana el vecino de la izquierda. |
| Asa derecha **hacia adentro** (←) | **RETIRA el día actual** (devolverse con el mismo largador). Cruzando varias columnas retira **toda esa tira**. |
| Asa izquierda **hacia adentro** (→) | Igual: retira el día actual. |
| Jiggle (< media columna) | Nada: el asa vuelve. |
| Hacia afuera en Lunes/Domingo | Nada: no existe vecino (el asa solo aparece ahí si sirve para achicar). |

Reglas finas:
- Si el vecino **ya tiene** la actividad, el asa no se limita a ese día: **la tira salta por encima y sigue** ganando días más allá. Con la Rutina en Lunes y Jueves, arrastrar el asa del Lunes pasando el Jueves sigue agregando Martes, Miércoles, Viernes, Sábado y Domingo: no se frena en el Jueves.
- **Una actividad de por medio NO impide estirar**: si el día que ganás está ocupado, los que están ahí se corren **empujados en cadena**. Y como el horario de un bloque es único para toda su semana, correr un vecino también lo corre en **todos los días que tiene** (por eso el preview los marca a los dos: nada se mueve a tus espaldas). Antes el gesto se rechazaba entero con "⛔ No cabe" y no ganabas nada.
- **Barrer todos los días de la actividad la ELIMINA** (igual que "Eliminar" del menú, y se puede deshacer). Antes de soltar, el rótulo dice "Borrar de todos sus días" y los bloques se ven en rojo más intenso: no se borra la actividad sin avisarte.
- **Retirar el único día** de una actividad no se ofrece.
- **Preview antes de soltar**: la columna afectada se tiñe (verde = gana, rojo = retira) y un rótulo junto al puntero anuncia "＋ Martes Baño" / "− Lunes Rutina".
- Al soltar: "Ahora también el {día}" o "Ya no está el {día}".

### Si la vista Día no carga

Con red intermitente (o un deploy a mitad de navegación) el módulo de la vista Día puede no bajar. Antes eso dejaba un esqueleto girando para siempre, sin explicación: solo se arreglaba recargando la página a ciegas y repetirlo hasta tres veces.

Ahora, en su lugar:

- Aparece un **aviso** que dice qué pasó, con un botón **Reintentar**.
- Ese botón recarga la página **una sola vez** (si la red sigue caída no entra en bucle) y te devuelve **directo a la vista Día**, sin obligarte a volver a buscarla.
- Tus datos no se pierden: la recarga solo relee la base local.

---

## 6. Deshacer / Rehacer

- Botones **↶ / ↷** del header (también **Ctrl+Z / Ctrl+Y**).
- Cada gesto (mover, estirar, crear, eliminar, duplicar) es **un paso**: se deshace completo.
- Si un gesto se rechaza (⛔), **nada se escribió**: no hay nada que deshacer.

---

## 7. Imágenes de las rutinas

- Se agregan desde el modal de actividad (archivo o URL; se recomprimen a WebP máx. 256px).
- En las tarjetas, la **miniatura circular con anillo blanco** indica que hay imagen:
  - **Semana**: pasar el mouse muestra la foto ampliada (120px + nombre) sin click; click abre el visor grande. En táctil: tap directo al visor.
  - **Día**: miniatura junto al nombre; click abre el visor.
- El visor (lightbox) **agranda la imagen hasta llenar la pantalla** (al menos el 80% en su lado más largo), aunque la compresión la haya guardado chica: entra completa, nunca se corta, y cierra con **Esc** o click fuera.

---

## 8. Ajustes

- **Rango de horas del día**: la **barra verde es arrastrable** — dos asas que fijan inicio y fin, con burbuja de hora mientras arrastras. Las asas se empujan entre sí (mínimo 1h de rango). Los selects de horas sincronizan (cada 30 min). Paso fino de 15 min con el teclado.
- **Categorías**: renombrar, colorear, añadir, eliminar y **reordenar arrastrando** (la paleta de colores de la grilla sigue el orden).
- **Idioma**: Español / English, aplicado al instante.
- Guardar solo aplica al pulsar **"Guardar Todo"**; Cancelar descarta.

---

## 9. Datos: respaldo, importación y nube

Menú **Datos** (icono de nube del header):

- **Bajar datos**: descarga un respaldo **.npz** (formato binario compacto: actividades, overrides, categorías, ajustes e imágenes re-comprimidas dentro). Un toast te dice el tamaño y cuántas imágenes lleva.
- **Subir datos**: importa un .npz (también acepta .json de versiones anteriores). Antes de escribir **te muestra qué contiene y pide confirmación**; tras importar, tus datos locales quedan reemplazados y el push a la nube (si hay sesión) sube todo.
- **Modo privacidad**: oculta detalles sensibles de la interfaz.
- **Último respaldo**: fecha de referencia del respaldo automático (localStorage; si está lleno, la app avisa y sugiere exportar manual).

### Nube (opcional)
- Con sesión iniciada, el push/pull es incremental y **last-write-wins** por actividad (gana la modificación más reciente).
- El icono de nube del header abre este menú; el estado de sesión y sync se gestiona dentro de Ajustes.

---

## 10. Teclado (resumen)

| Tecla | Acción |
|---|---|
| **Tab / Shift+Tab** | Recorrer todos los controles (todo es alcanzable y etiquetado) |
| **↑ / ↓** sobre una tarjeta | Mover ±15 min con cascada |
| **Enter / Espacio** sobre una tarjeta | Abrir edición |
| **Enter / Espacio** sobre una miniatura | Abrir la imagen |
| **Esc** | Cancelar drag/gesto en curso, cerrar visor o menús |
| **Ctrl+Z / Ctrl+Y** | Deshacer / Rehacer |

---

## 11. Principios de diseño (por qué se comporta así)

1. **Lo que ves es lo que se guarda**: el preview del drag es el mismo cálculo del commit.
2. **Nunca se pierde trabajo sin aviso**: todo rechazo tiene toast con el motivo; todo cambio es deshacible.
3. **El estirar nunca rechaza**: topa con bloques o bordes; el encoger siempre es posible.
4. **Sin reemplazos**: un bloque jamás pisa a otro; la cascada empuja en cadena.
5. **Táctil primero**: gestos con umbral, long-press, zonas ≥44px, nada de `alert()`/`confirm()` nativos.
6. **Local-first**: sin cuenta la app funciona completa; la nube es respaldo opcional.

---

*Manual generado a partir de la implementación vigente (septiembre 2026). Si una regla cambia, este documento se actualiza en el mismo commit.*

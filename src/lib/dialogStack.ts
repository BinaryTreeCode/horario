/**
 * Escape anidado: que solo lo gestione el diálogo de más arriba.
 *
 * El problema: cada overlay escucha Escape en `window`, y todos viven en el
 * mismo objetivo, así que `stopPropagation()` no sirve de nada —para eso habría
 * que usar
 * `stopImmediatePropagation()`, que depende del orden de registro. El
 * ConfirmDialog se registraba después que su modal padre, así que el padre
 * veía el Escape primero, lo cerraba, y el ConfirmDialog también: Esc
 * borraba los dos de golpe y el foco se perdía en el body.
 *
 * Un contador de diálogos abiertos tampoco vale: el padre lo consultaba
 * después de que el hijo ya se hubiera dado de baja.
 *
 * La solución no depende del orden: el diálogo más interno marca el propio
 * evento en fase de captura (que en `window` se ejecuta antes que cualquier
 * listener en fase de burbuja) y los padres lo consultan antes de actuar.
 */

/** Clave propia para no colisionar con nada del evento. */
const MARCA = Symbol('np:escape-consumido');

/** Marca el evento como ya gestionado por un diálogo de nivel superior. */
export function marcarConsumido(e: Event) {
  (e as any)[MARCA] = true;
}

/** ¿Otro diálogo, más arriba en la pila, ya gestionó este Escape? */
export function fueConsumido(e: Event): boolean {
  return (e as any)[MARCA] === true;
}

/**
 * Registra un listener de Escape en fase de captura para este diálogo, solo
 * mientras `activo()` devuelva true. Devuelve la función de limpieza.
 *
 * Se pasa una función en lugar de un booleano para que el diálogo pueda
 * abrirse y cerrarse sin volver a registrar nada.
 */
export function capturarEscape(activo: () => boolean, alPulsar: (e: KeyboardEvent) => void): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !activo()) return;
    // Marca primero: los padres lo consultan en fase de burbuja, después.
    marcarConsumido(e);
    alPulsar(e);
  };
  window.addEventListener('keydown', handler, true);
  return () => window.removeEventListener('keydown', handler, true);
}
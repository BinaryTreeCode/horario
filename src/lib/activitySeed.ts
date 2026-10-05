/**
 * Precarga del modal de actividad: sembrar solo lo que nadie tocó.
 *
 * El modal precarga la fila con una lectura async (`await db.activities.get`).
 * Entre que monta y que llega la lectura hay una ventana en la que la persona
 * —o el test— ya puede tocar un campo. Cuando llegaba la lectura le pisaba la
 * elección y el guardado salía con los valores viejos: se veía como el modal
 * mostrando los defaults de creación (08:00-09:00) en vez del horario real
 * (08:30), y un toast genérico "Activity saved" sin cambios. Medido 1 de cada 8
 * corridas del guard "Modal: aumentar", tanto a 1280 como a 390.
 *
 * La regla es una línea: si el campo sigue valiendo lo que valía en el montaje,
 * nadie lo tocó y la carga puede sembrarlo; si ya cambió, manda lo que el
 * usuario puso. Por eso es una función pura —así la invariante se testea sin
 * navegador— y por eso compara contra la FOTO del montaje y no contra el valor
 * por defecto de creación, que es justamente lo que hay que poder pisar.
 *
 * Compara por identidad para los arrays y objetos (`daysOfWeek`, `steps`,
 * `image`): al editarlos el usuario siempre deja una copia nueva, así que la
 * referencia cambia igual que en los escalares.
 */
export function sembrarSinPisar<T>(
  /** Valor del campo ahora mismo. */
  actual: T,
  /** Valor que tenía el campo en el momento del montaje. */
  enMontaje: T,
  /** Valor que trae la fila en la base. */
  deLaFila: T
): T {
  return actual === enMontaje ? deLaFila : actual;
}
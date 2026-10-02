import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  /** ms hasta auto-cerrar; 0 = persistente (requiere cierre manual) */
  duration: number;
}

export const toasts = writable<Toast[]>([]);

let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Duración estándar de los avisos auto-cerrables (pedido del usuario: 2s). */
export const TOAST_DURACION = 2000;

/** Muestra un toast. duration=0 → persistente (devuelve id para dismiss).
 *  Los toasts NUEVOS REEMPLAZAN a los anteriores (nunca se acumulan en
 *  ráfaga: el último manda — plan v2 fase 1). */
export function toast(message: string, type: ToastType = 'info', duration = TOAST_DURACION): number {
  const id = ++seq;
  toasts.update((list) => {
    // Cerrar los anteriores del mismo tipo: el nuevo reemplaza, no apila.
    for (const t of list) if (timers.has(t.id)) { clearTimeout(timers.get(t.id)!); timers.delete(t.id); }
    return [{ id, type, message, duration }];
  });
  if (duration > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), duration));
  }
  return id;
}/** Quita un toast (lo usa el timer de auto-cierre y el botón X). */
export function dismissToast(id: number) {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
  toasts.update((list) => list.filter((x) => x.id !== id));
}

/** Toast de éxito con el check estándar. */
export const toastOk = (msg: string, duration?: number) => toast(msg, 'success', duration ?? TOAST_DURACION);
/**
 * Toast de error AUTO-CERRABLE por defecto: en el drag los avisos (tope del
 * día, hueco chico) llegan en ráfaga y los persistentes se acumulaban en
 * pantalla tapando la grilla. Para errores críticos que exijan lectura
 * tranquila (import/sync), pasar duration=0 explícito.
 */
export const toastErr = (msg: string, duration = TOAST_DURACION) => toast(msg, 'error', duration);

// ── Puerta de repetición (pedido del usuario): el PRIMER fallo de un gesto
// solo muestra feedback visual (rojo/shake); el toast SOLO aparece si el
// usuario insiste y vuelve a fallar la MISMA acción (2º intento). ──
/** Firma del último error avisado + marca de repetido, con ventana de 4s
 *  (si pasaron más de 4s entre intentos, cuenta como primera vez de nuevo). */
let lastErrFirma = '';
let lastErrTime = 0;
const VENTANA_REINTENTO_MS = 4000;

/**
 * Error de gesto con puerta de repetición: 1er fallo → toast BREVE con el
 * motivo (el usuario debe saber por qué el bloque vuelve: con un día lleno
 * el silencio se siente como "el drag se rompió"); si insiste y repite la
 * misma falla dentro de la ventana, el toast se renueva.
 *
 * Antes el 1er fallo era SILENCIOSO (se confiaba en el rojo del fantasma),
 * pero el rojo solo se ve MIENTRAS se arrastra: al soltar desaparece sin
 * explicación y el usuario reporta "el drag and drop se rompe".
 * @param firma  identidad de la acción fallida (p. ej. `mover:Lunes`)
 * @param motivo descripción clara de por qué no se pudo
 */
export function toastErrRepetido(firma: string, motivo: string) {
  const now = Date.now();
  const esReintento = firma === lastErrFirma && now - lastErrTime <= VENTANA_REINTENTO_MS;
  lastErrFirma = firma;
  lastErrTime = now;
  // Siempre avisar: el auto-cierre a 3.2s evita la spam y el anti-duplicado
  // del store de toasts colapsa repeticiones idénticas consecutivas.
  toastErr(motivo);
}

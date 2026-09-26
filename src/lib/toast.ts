import { writable } from 'svelte/store';

export type ToastType = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  message: string;
  /** ms hasta auto-cerrar; 0 = persistente (requiere cierre manual) */
  duration: number;
  /** Acción opcional (botón tipo [Deshacer]). Al clic: ejecuta y cierra. */
  action?: { label: string; run: () => void };
  /** Pausa el auto-cierre con hover/focus (toast con acción). */
  pausable?: boolean;
}

export const toasts = writable<Toast[]>([]);

let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Muestra un toast. duration=0 → persistente (devuelve id para dismiss).
 *  Los toasts NUEVOS REEMPLAZAN a los anteriores (nunca se acumulan en
 *  ráfaga: el último manda — plan v2 fase 1). */
export function toast(message: string, type: ToastType = 'info', duration = 3200, action?: Toast['action'], pausable = false): number {
  const id = ++seq;
  toasts.update((list) => {
    // Cerrar los anteriores del mismo tipo: el nuevo reemplaza, no apila.
    for (const t of list) if (timers.has(t.id)) { clearTimeout(timers.get(t.id)!); timers.delete(t.id); }
    return [{ id, type, message, duration, action, pausable }];
  });
  if (duration > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), duration));
  }
  return id;
}

/** Pausa/reanuda el auto-cierre (hover o foco sobre un toast con acción). */
export function pauseToast(id: number) {
  const t = timers.get(id);
  if (!t) return false;
  clearTimeout(t);
  timers.delete(id);
  return true;
}
export function resumeToast(id: number, remaining: number) {
  if (timers.has(id)) return;
  timers.set(id, setTimeout(() => dismissToast(id), remaining));
}

export function dismissToast(id: number) {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
  toasts.update((list) => list.filter((x) => x.id !== id));
}

/** Toast de éxito con el check estándar. */
export const toastOk = (msg: string, duration?: number) => toast(msg, 'success', duration);
/**
 * Toast de éxito con botón [Deshacer] (6s, pausable con hover): el estándar
 * del plan v2 para toda mutación confirmada. La acción la provee el llamador
 * ( normalmente popAndUndo del último paso).
 */
export const toastUndo = (msg: string, run: () => void) =>
  toast(msg, 'success', 6000, { label: 'Deshacer', run }, true);
/**
 * Toast de error AUTO-CERRABLE por defecto: en el drag los avisos (tope del
 * día, hueco chico) llegan en ráfaga y los persistentes se acumulaban en
 * pantalla tapando la grilla. Para errores críticos que exijan lectura
 * tranquila (import/sync), pasar duration=0 explícito.
 */
export const toastErr = (msg: string, duration = 3200) => toast(msg, 'error', duration);

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

/** Muestra un toast. duration=0 → persistente (devuelve id para dismiss). */
export function toast(message: string, type: ToastType = 'info', duration = 3200): number {
  const id = ++seq;
  toasts.update((list) => [...list.slice(-4), { id, type, message, duration }]);
  if (duration > 0) {
    timers.set(id, setTimeout(() => dismissToast(id), duration));
  }
  return id;
}

export function dismissToast(id: number) {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
  toasts.update((list) => list.filter((x) => x.id !== id));
}

/** Toast de éxito con el check estándar. */
export const toastOk = (msg: string, duration?: number) => toast(msg, 'success', duration);
/** Toast de error — persistente por defecto para que el usuario lo lea. */
export const toastErr = (msg: string, duration = 0) => toast(msg, 'error', duration);

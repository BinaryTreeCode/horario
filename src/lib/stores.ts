import { db } from './db';
import { onDataChanged } from './dataBus';
import type { Activity, Category, AppSettings, DayOverride } from './types';

// ── Stores reactivas propias (reemplazan liveQuery) ─────────────────────────
// liveQuery de Dexie 4.3/4.4 no notifica updates de filas que ya existían al
// suscribirse (dexie/Dexie.js#2309): la BD se escribía bien pero la UI
// congelaba el estado viejo (síntoma del drag & drop que "revertía"). Estas
// señales re-leen SIEMPRE la tabla completa desde IndexedDB ante cada
// notificación de mutación (db.ts las emite vía middleware; dataBus las
// enruta, incluso entre pestañas). Sin cache interno que envenenar: lo que
// muestra la UI es lo que hay en la BD.

export interface DataSignal<T> {
  subscribe(run: (value: T) => void): () => void;
}

interface SignalEntry {
  tables: string[];
  refresh: () => void;
}

const signals = new Set<SignalEntry>();

function createDataSignal<T>(tables: string | string[], read: () => Promise<T>): DataSignal<T> {
  const tableSet = Array.isArray(tables) ? tables : [tables];
  const listeners = new Set<(value: T) => void>();
  let current: T | undefined;
  let reading = false;
  let needsRefresh = false;

  async function refresh() {
    if (reading) {
      needsRefresh = true; // coalescer re-lecturas solapadas
      return;
    }
    if (listeners.size === 0) return; // lazy: sin suscriptores no se lee
    reading = true;
    try {
      const value = await read();
      current = value;
      for (const listener of listeners) listener(value);
    } catch (err) {
      console.error('[stores] re-lectura falló para', tableSet, err);
    } finally {
      reading = false;
      if (needsRefresh) {
        needsRefresh = false;
        refresh();
      }
    }
  }

  signals.add({ tables: tableSet, refresh });

  return {
    subscribe(run) {
      listeners.add(run);
      if (current !== undefined) {
        run(current);
      } else if (!reading) {
        refresh();
      }
      return () => {
        listeners.delete(run);
      };
    }
  };
}

// Una mutación refresca SOLO las señales cuyas tablas intersectan las tablas
// afectadas por la notificación.
onDataChanged((affected) => {
  for (const signal of signals) {
    if (signal.tables.some((t) => affected.has(t))) signal.refresh();
  }
});

export const activitiesStore = createDataSignal<Activity[]>('activities', async () => {
  const all = await db.activities.toArray();
  return all.filter(a => !a.deletedAt);
});
export const categoriesStore = createDataSignal<Category[]>(['categories'], async () => {
  const all = await db.categories.orderBy('order').toArray();
  return all.filter(c => !c.deletedAt);
});
export const settingsStore = createDataSignal<AppSettings[]>(['settings'], async () => {
  const all = await db.settings.toArray();
  return all.filter(s => !s.deletedAt);
});
export const dayOverridesStore = createDataSignal<DayOverride[]>(['dayOverrides'], async () => {
  const all = await db.dayOverrides.toArray();
  return all.filter(o => !o.deletedAt);
});
export function getActivityColor(categoryId: string, categories: any[]) {
    return categories.find(c => c.id === categoryId)?.color || '#999';
}

/**
 * Texto legible sobre un color de categoría (WCAG 1.4.3). El blanco
 * fijo fallaba en categorías claras: 2.26:1 en «oración» (#7FB3D5)
 * y 3.51:1 en «Cocinar» (#319795). Umbral de luminancia 0.20:
 * arriba → texto oscuro (≥4.8:1 medido sobre esos colores); abajo
 * → blanco (≥4.9:1). `shadow` es para los bloques "mini", cuyo
 * nombre desborda sobre otros bloques y necesita sombra inversa.
 */
export function textOn(hex: string): { text: string; shadow: string } {
    const m = hex.match(/#?([0-9a-f]{6})/i);
    if (!m) return { text: '#ffffff', shadow: 'rgba(0, 0, 0, 0.55)' };
    const rgb = m[1].match(/../g)!.map(x => parseInt(x, 16) / 255);
    const lin = rgb.map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return L > 0.20
        ? { text: '#14201a', shadow: 'rgba(255, 255, 255, 0.7)' }
        : { text: '#ffffff', shadow: 'rgba(0, 0, 0, 0.55)' };
}

export function parseTime(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h + m / 60;
}

export function formatTime(hour: number): string {
    // Minutos enteros normalizados: evita "09:60" con flotantes importados
    // (9.999h → 599.94 min → redondeo a 600 → 10:00). Clamp a 24:00.
    const total = Math.min(24 * 60, Math.round(hour * 60));
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export function format12h(timeStr: string): string {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const period = h < 12 || h === 24 ? 'AM' : 'PM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${(m || 0).toString().padStart(2, '0')} ${period}`;
}

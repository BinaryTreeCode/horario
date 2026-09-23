import { db } from './db';
import { onDataChanged } from './dataBus';
import type { Activity, Category, AppSettings, DayOverride, SyncState } from './types';

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
export const syncStateStore = createDataSignal<SyncState | undefined>('syncState', () =>
  db.syncState.get('1')
);

export function getActivityColor(categoryId: string, categories: any[]) {
    return categories.find(c => c.id === categoryId)?.color || '#999';
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

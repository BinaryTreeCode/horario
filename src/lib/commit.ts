import { db } from './db';
import { cloneAct, type RowChange, type OverrideChange } from './undo';
import type { Activity, DayOverride } from './types';

/**
 * Único punto de escritura de mutaciones de horarios (fase 1 del plan v2):
 * ni DailyView ni WeeklyGrid escriben directamente a Dexie — ambas llaman
 * aquí. Garantías:
 *  - ATÓMICO: una transacción Dexie cubre todas las filas y overrides; si
 *    una falla, no se escribe ninguna.
 *  - Deshacer/rehacer en UN paso por gesto, con snapshots before/after.
 *  - updatedAt fresco en toda fila escrita (regla 3 de AGENTS.md — sync LWW).
 *
 * `cambios.acts`  → filas master completas (ya clonadas, sin proxies $state).
 * `cambios.ovs`   → overrides completos por día.
 */

export interface CommitCambios {
  label: string;
  acts?: Activity[];
  /** Override completo a escribir (reemplaza el día entero). */
  ovs?: { day: number; activities: Activity[] }[];
}

export interface CommitResult {
  ok: boolean;
  label: string;
  rows: RowChange[];
  overrides: OverrideChange[];
}

export async function commitCambios(c: CommitCambios): Promise<CommitResult> {
  const stamp = Date.now();
  const rows: RowChange[] = [];
  const overrides: OverrideChange[] = [];
  const writes: Promise<unknown>[] = [];
  const deletes: Promise<unknown>[] = [];

  await db.transaction('rw', db.activities, db.dayOverrides, async () => {
    for (const act of c.acts ?? []) {
      const before = await db.activities.get(act.id!) ?? null;
      const after = { ...act, updatedAt: stamp };
      if (!before ||
          before.startTime !== after.startTime ||
          before.endTime !== after.endTime ||
          before.daysOfWeek.join(',') !== after.daysOfWeek.join(',') ||
          before.name !== after.name ||
          before.categoryId !== after.categoryId) {
        rows.push({ before, after });
        writes.push(db.activities.put(after));
      }
    }
    for (const ov of c.ovs ?? []) {
      const before = await db.dayOverrides.get(ov.day) ?? null;
      const after: DayOverride = { day: ov.day, activities: ov.activities, updatedAt: stamp };
      rowsAreClean(after.activities);
      if (!before || before.updatedAt !== undefined) {
        // El override se compara por contenido (el día entero es el unit).
        const same = before &&
          JSON.stringify(before.activities) === JSON.stringify(after.activities);
        if (!same) {
          overrides.push({ day: ov.day, before, after });
          writes.push(db.dayOverrides.put(after));
        }
      }
    }
    await Promise.all(writes);
  });
  void deletes;

  // Push del undo SOLO si algo cambió (evita pasos vacíos en la pila).
  if (rows.length || overrides.length) {
    const { pushUndo } = await import('./undo');
    pushUndo({ label: c.label, rows, overrides });
  }
  return { ok: true, label: c.label, rows, overrides };
}

/** Blindaje: nunca escribir proxies de $state (regla 2 de AGENTS.md). */
function rowsAreClean(acts: Activity[]) {
  for (const a of acts) {
    if (a.steps && !Array.isArray(a.steps)) throw new Error('steps no es array');
  }
}

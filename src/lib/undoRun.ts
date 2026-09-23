import { db } from './db';
import { undoStack, type UndoOp } from './undo';
import { computeRestores } from './undoPlan';
import type { Activity, DayOverride } from './types';

/**
 * Ejecución del undo (chunk separado, se baja solo al primer Ctrl+Z):
 * lee el estado ACTUAL de las filas del op, calcula el plan de restauración
 * y lo escribe en una transacción.
 */
async function runUndo(op: UndoOp): Promise<string> {
  const actIds = new Set(op.rows.map(r => r.after?.id ?? r.before?.id).filter(Boolean) as string[]);
  const ovDays = new Set((op.overrides ?? []).map(o => o.day));
  const currentActs = new Map<string, Activity | undefined>();
  const currentOv = new Map<number, DayOverride | undefined>();
  await Promise.all([
    ...[...actIds].map(async id => currentActs.set(id, await db.activities.get(id))),
    ...[...ovDays].map(async day => currentOv.set(day, await db.dayOverrides.get(day)))
  ]);

  const plan = computeRestores(op, currentActs, currentOv);

  await db.transaction('rw', db.activities, db.dayOverrides, async () => {
    await Promise.all(plan.acts.map(a => db.activities.put(a)));
    if (plan.delActs.length) await db.activities.bulkDelete(plan.delActs);
    await Promise.all(plan.overrides.map(o => db.dayOverrides.put(o)));
    if (plan.delOverrides.length) await db.dayOverrides.bulkDelete(plan.delOverrides);
  });

  return plan.skipped === 0 ? op.label : `${op.label} (parcial)`;
}

/** Pop atómico del op superior del stack + ejecución. Null si no hay nada. */
export async function popAndUndo(): Promise<string | null> {
  let op: UndoOp | undefined;
  undoStack.update(s => {
    op = s[s.length - 1];
    return op ? s.slice(0, -1) : s;
  });
  if (!op) return null;
  return runUndo(op);
}

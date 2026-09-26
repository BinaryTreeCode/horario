import { db } from './db';
import { undoStack, redoStack, pushUndo, type UndoOp, type RowChange, type OverrideChange } from './undo';
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
  const label = await runUndo(op);
  // Snapshot para el REHACER: el estado ACTUAL (ya restaurado al "antes").
  // Al rehacer se re-aplica el after del op desde este punto de partida.
  await snapshotForRedo(op);
  return label;
}

/**
 * Captura el estado actual de las filas del op como "antes" del redo.
 * (El after del op es el "después": rehacer = reescribir el after.)
 */
async function snapshotForRedo(op: UndoOp) {
  const actIds = new Set(op.rows.map(r => r.after?.id ?? r.before?.id).filter(Boolean) as string[]);
  const ovDays = new Set((op.overrides ?? []).map(o => o.day));
  const rows: RowChange[] = [];
  const overrides: OverrideChange[] = [];
  await Promise.all([
    ...[...actIds].map(async id => {
      const before = await db.activities.get(id) ?? null;
      const after = op.rows.find(r => (r.after?.id ?? r.before?.id) === id)?.after ?? null;
      rows.push({ before, after });
    }),
    ...[...ovDays].map(async day => {
      const before = await db.dayOverrides.get(day) ?? null;
      const after = op.overrides!.find(o => o.day === day)?.after ?? null;
      overrides.push({ day, before, after });
    })
  ]);
  redoStack.update(s => [...s.slice(-(19)), { label: op.label, rows, overrides }]);
}

/**
 * Rehacer: pop del redoStack, re-aplicar el after del op (con updatedAt
 * fresco para que el guard del undo lo acepte) y devolver el op a la pila
 * de deshacer con los snapshots before/after actualizados.
 */
export async function popAndRedo(): Promise<string | null> {
  let op: UndoOp | undefined;
  redoStack.update(s => {
    op = s[s.length - 1];
    return op ? s.slice(0, -1) : s;
  });
  if (!op) return null;
  const now = Date.now();
  const rows: RowChange[] = [];
  const overrides: OverrideChange[] = [];
  const updates: Promise<unknown>[] = [];
  await db.transaction('rw', db.activities, db.dayOverrides, async () => {
    for (const { before, after } of op!.rows) {
      const id = after?.id ?? before?.id;
      if (!id) continue;
      const cur = await db.activities.get(id) ?? null;
      // Guard simétrico: solo rehacer si la fila sigue como quedó al deshacer.
      if (before && cur?.updatedAt !== before.updatedAt) continue;
      if (after) {
        const applied = { ...after, updatedAt: now };
        rows.push({ before: cur, after: applied });
        updates.push(db.activities.put(applied));
      } else if (cur) {
        rows.push({ before: cur, after: null });
        updates.push(db.activities.delete(id));
      }
    }
    for (const { day, before, after } of op!.overrides ?? []) {
      const cur = await db.dayOverrides.get(day) ?? null;
      if (before && cur?.updatedAt !== before.updatedAt) continue;
      if (after) {
        const applied = { ...after, updatedAt: now };
        overrides.push({ day, before: cur, after: applied });
        updates.push(db.dayOverrides.put(applied));
      } else if (cur) {
        overrides.push({ day, before: cur, after: null });
        updates.push(db.dayOverrides.delete(day));
      }
    }
    await Promise.all(updates);
  });
  pushUndo({ label: op.label, rows, overrides });
  return op.label;
}

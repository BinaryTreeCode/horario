import type { Activity, DayOverride } from './types';
import type { UndoOp } from './undo';

/**
 * Plan de restauración (puro, vive en el chunk diferido del undo):
 * decide qué escribir/borrar comparando los snapshots del op con el
 * estado ACTUAL de las filas (guard por updatedAt).
 */

export interface RestorePlan {
  /** Filas a escribir (resurrección de borrados incluida) con updatedAt fresco. */
  acts: Activity[];
  /** Ids a eliminar (deshacer una creación). */
  delActs: string[];
  overrides: DayOverride[];
  delOverrides: number[];
  /** Filas saltadas porque el usuario las mutó después de la operación. */
  skipped: number;
}

export function computeRestores(
  op: UndoOp,
  currentActs: Map<string, Activity | undefined>,
  currentOv: Map<number, DayOverride | undefined>
): RestorePlan {
  const plan: RestorePlan = { acts: [], delActs: [], overrides: [], delOverrides: [], skipped: 0 };
  const now = Date.now();

  for (const { before, after } of op.rows) {
    if (!before && !after) continue;
    const cur = after ? currentActs.get(after.id!) : undefined;
    // Guard: solo deshacer si la fila está exactamente como la dejó la op.
    if (after && cur?.updatedAt !== after.updatedAt) { plan.skipped++; continue; }
    if (!before && after) {
      plan.delActs.push(after.id!);        // deshacer creación
    } else if (before) {
      const revived = { ...before, steps: before.steps?.map(s => ({ ...s })) };
      plan.acts.push({ ...revived, updatedAt: now });
    }
  }

  for (const { day, before, after } of op.overrides ?? []) {
    const cur = after ? currentOv.get(day) : undefined;
    if (after && cur?.updatedAt !== after.updatedAt) { plan.skipped++; continue; }
    if (!before && after) {
      plan.delOverrides.push(day);
    } else if (before) {
      plan.overrides.push({ ...before, updatedAt: now });
    }
  }

  return plan;
}

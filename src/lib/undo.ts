import { writable } from 'svelte/store';
import type { Activity, DayOverride } from './types';

/**
 * Undo genérico por snapshots: cada mutación captura las filas afectadas
 * antes y después de escribir. Deshacer restaura el "antes" SOLO si la fila
 * actual sigue siendo la del "después" (guard por updatedAt) — si el usuario
 * mutó esa fila de nuevo tras la operación, se descarta en vez de pisarlo.
 *
 * La EJECUCIÓN del undo (lectura, plan y transacción Dexie) vive en
 * undoRun.ts y se carga con import dinámico: este módulo sí va al chunk de
 * Dashboard y su presupuesto gzip es ≤30 KB. Solo guarda snapshots.
 */

export interface RowChange {
  /** Fila antes de la operación (null = no existía / se creó en la op). */
  before: Activity | null;
  /** Fila después de la operación (null = quedó eliminada). */
  after: Activity | null;
}

export interface OverrideChange {
  day: number;
  before: DayOverride | null;
  after: DayOverride | null;
}

export interface UndoOp {
  label: string;
  rows: RowChange[];
  overrides?: OverrideChange[];
}

const MAX = 20;

export const undoStack = writable<UndoOp[]>([]);

/** Clon plano (structured clone no clona Proxies de $state). */
export function cloneAct(a: Activity): Activity {
  return { ...a, steps: a.steps?.map(s => ({ ...s })) };
}

export function pushUndo(op: UndoOp) {
  undoStack.update(s => [...s.slice(-(MAX - 1)), op]);
}

export function clearUndo() {
  undoStack.set([]);
}

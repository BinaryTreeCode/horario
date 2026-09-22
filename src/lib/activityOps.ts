import type { Activity } from './types';
import { parseTime, formatTime } from './stores';
import { db, newId } from './db';

/** Duración mínima de un bloque (15 min, en horas). */
const MIN_DURATION_H = 0.25;

export interface DuplicateOptions {
  /** Hora de inicio del rango a explorar (inclusive). Por defecto, startHour de settings. */
  startHour?: number;
  /** Hora de fin del rango a explorar (exclusive). Por defecto, endHour de settings. */
  endHour?: number;
  /** Días de la semana (0-6) donde se insertará la copia. */
  days: number[];
}

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

/**
 * Busca el primer hueco libre de `durationH` horas dentro de [from, to)
 * que no colisione con ninguna actividad de `busy` (en los días dados),
 * saltando de a 15 minutos. Devuelve la hora de inicio como decimal.
 */
function findFirstGap(
  busy: { start: number; end: number }[],
  durationH: number,
  from: number,
  to: number
): number | null {
  // Normalizar snap de 15 min: arrancar alineado a la cuadrícula
  for (let t = from; t + durationH <= to + 1e-9; t += MIN_DURATION_H) {
    const s = Math.round(t * 4) / 4;
    const e = s + durationH;
    if (e > to + 1e-9) break;
    if (!busy.some(b => overlaps(s, e, b.start, b.end))) return s;
  }
  return null;
}

/**
 * Duplica una actividad como bloque independiente.
 *
 * - La copia conserva nombre (+" (copia)"), categoría, descripción, imagen y pasos.
 * - Se coloca en el PRIMER HUECO LIBRE del día (mismo día que la original),
 *   alineada a la cuadrícula de 15 min. Si el día está lleno, lo reporta y no escribe.
 * - Si el original ya está borrado (tombstone), lo reporta.
 *
 * Devuelve la copia creada o null si no hubo lugar/actividad.
 */
export async function duplicateActivity(
  sourceId: string,
  opts: DuplicateOptions
): Promise<Activity | null> {
  const original = await db.activities.get(sourceId);
  if (!original || original.deletedAt) return null;

  const from = opts.startHour ?? 0;
  const to = opts.endHour ?? 24;

  const durationH = Math.max(
    MIN_DURATION_H,
    parseTime(original.endTime) - parseTime(original.startTime)
  );

  // Ocupación del día destino: actividades maestras vivas que incluyan alguno de los días
  const dayActs = (await db.activities.toArray()).filter(
    a => !a.deletedAt && a.daysOfWeek.some(d => opts.days.includes(d))
  );
  const busy = dayActs.map(a => ({
    start: parseTime(a.startTime),
    end: parseTime(a.endTime)
  }));

  const gapStart = findFirstGap(busy, durationH, from, to);
  if (gapStart === null) return null;
  const gapEnd = gapStart + durationH;

  const { id: _omit, updatedAt: _u, deletedAt: _d, ...rest } = original;
  const clone: Activity = {
    ...rest,
    id: newId(),
    name: `${original.name} (copia)`,
    startTime: formatTime(gapStart),
    endTime: formatTime(gapEnd),
    daysOfWeek: [...opts.days],
    updatedAt: Date.now()
  };

  await db.activities.add(clone);
  return clone;
}

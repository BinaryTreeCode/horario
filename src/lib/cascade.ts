/**
 * Resolución de colisiones (cascada push-down) compartida por las vistas
 * Día y Semana. Antes vivía duplicada (y desincronizada) en cada componente;
 * ahora un solo dueño: cuando cambia la matemática, cambia en ambos lados.
 *
 * Modelo: una actividad modificada empuja a las siguientes hacia abajo
 * preservando su duración; la última del día se recorta si excede endHour.
 * Solapes solo cuando no hay espacio total en el día (decisión de producto).
 *
 * Multi-día: las actividades son UNA fila con horario global, así que un
 * cambio se propaga en cierre transitivo: cada día afectado se resuelve con
 * la actividad arrastrada ANCLADA (pin) a lo que el usuario vio; los vecinos
 * empujados cambian su horario global, lo que puede afectar SUS otros días →
 * se re-resuelven hasta estabilizar (acotado a 7 iteraciones = 7 días).
 */
import type { Activity } from './types.js';

export interface Slot {
  id: string;
  start: number;
  end: number;
}

/** Convertidor inyectable para no importar la store desde este módulo puro. */
export interface TimeCodec {
  parse: (time: string) => number;
  format: (hour: number) => string;
}

const EPS = 0.0001;

/**
 * Aplica la cascada push-down a un día completo. `slots` debe cubrir TODAS
 * las actividades del día. Con `pinnedId`, esa actividad es una pared: nunca
 * se mueve ni se recorta, y nadie se recorta por hacerle lugar (el solape
 * remanente es el caso "no hay espacio" permitido). Sin pinnedId es la
 * matemática original (la movida también puede ser empujada por las previas).
 */
export function resolveDayCascade(slots: Slot[], endHour: number, pinnedId?: string): Slot[] {
  // En empates de arranque la pared va PRIMERO: si el drop cae exactamente
  // encima de otra actividad, la existente se empuja hacia abajo (hay
  // espacio) — misma semántica push-down que la vista Día, no solape.
  const all = [...slots].sort((a, b) =>
    a.start - b.start || (a.id === pinnedId ? -1 : b.id === pinnedId ? 1 : 0)
  );

  // 1) Push-down: cada bloque que arranca dentro del anterior se desliza a
  //    continuación, conservando su duración (la pared no se mueve).
  for (let i = 1; i < all.length; i++) {
    const prev = all[i - 1];
    const cur = all[i];
    if (cur.id === pinnedId) continue;
    if (cur.start < prev.end - EPS) {
      const shift = prev.end - cur.start;
      cur.start += shift;
      cur.end += shift;
    }
  }

  // 2) Pasada hacia atrás: compresión al fin del día y cierre de huecos,
  //    preservando duraciones. Nunca toca la pared (ni recorta a alguien
  //    contra la pared: queda el solape permitido).
  for (let i = all.length - 1; i >= 0; i--) {
    const cur = all[i];
    const dur = cur.end - cur.start;
    if (cur.id !== pinnedId && cur.end > endHour + EPS) {
      cur.end = endHour;
      cur.start = endHour - dur;
    }
    if (i > 0 && all[i - 1].id !== pinnedId && cur.id !== pinnedId) {
      const prev = all[i - 1];
      if (prev.end > cur.start + EPS) {
        const prevDur = prev.end - prev.start;
        prev.end = cur.start;
        prev.start = cur.start - prevDur;
      }
    }
  }

  return all;
}

export interface WeeklyResolution {
  /** id → slot final, por día incluido en el cierre. */
  byDay: Map<number, Map<string, Slot>>;
  /** Horario global final por actividad (lo escribible en la BD). */
  times: Map<string, Slot>;
}

/**
 * Propaga el cambio de una actividad a TODOS los días afectados.
 * `pinnedStart` es el arranque que el usuario vio en el preview (la pared).
 * `mineDays` son los días finales de la arrastrada (el commit puede quitar el
 * origen en un drag entre columnas — la BD aún tiene los viejos).
 */
export function propagateWeekly(
  activities: Activity[],
  actId: string,
  pinnedStart: number,
  endHour: number,
  codec: TimeCodec,
  mineDays: number[],
  newDuration?: number
): WeeklyResolution {
  const act = activities.find(a => a.id === actId);
  if (!act) return { byDay: new Map(), times: new Map() };
  const duration = newDuration ?? (codec.parse(act.endTime) - codec.parse(act.startTime));

  const times = new Map<string, Slot>();
  for (const a of activities) {
    times.set(a.id!, { id: a.id!, start: codec.parse(a.startTime), end: codec.parse(a.endTime) });
  }
  times.set(actId, { id: actId, start: pinnedStart, end: pinnedStart + duration });

  const myDays = new Set(mineDays);
  const isOnDay = (a: Activity, day: number) =>
    a.id === actId ? myDays.has(day) : a.daysOfWeek.includes(day);

  const daySet = new Set<number>(mineDays);
  for (let iter = 0; iter < 7; iter++) {
    let changed = false;
    for (const day of [...daySet].sort((a, b) => a - b)) {
      const slots = activities.filter(a => isOnDay(a, day)).map(a => times.get(a.id!)!);
      for (const s of resolveDayCascade(slots, endHour, actId)) {
        const cur = times.get(s.id);
        if (!cur || Math.abs(cur.start - s.start) > 1e-9 || Math.abs(cur.end - s.end) > 1e-9) {
          times.set(s.id, s);
          changed = true;
          const owner = activities.find(a => a.id === s.id);
          if (owner) owner.daysOfWeek.forEach(d => daySet.add(d));
        }
      }
    }
    if (!changed) break;
  }

  const byDay = new Map<number, Map<string, Slot>>();
  for (const day of daySet) {
    const daySlots = activities.filter(a => isOnDay(a, day)).map(a => times.get(a.id!)!);
    byDay.set(day, new Map(daySlots.map(s => [s.id, s])));
  }
  return { byDay, times };
}

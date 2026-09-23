/**
 * Resolución de colisiones del drag & drop compartida por las vistas Día y
 * Semana. Un solo dueño: cuando cambia la matemática, cambia en ambos lados.
 * Pura y testeada (cascade.test.ts).
 *
 * Semántica LOCAL (decidida con el usuario): el bloque soltado es una pared
 * y solo se mueve lo que pisa directamente.
 *  1. Sin colisión → el resto del día NO se entera: sin cerrar huecos ni
 *     mover vecinos (el barrido global re-empaquetaba la columna entera y
 *     "arrastraba" bloques que no estorbaban).
 *  2. Un solo bloque pisado → INTERCAMBIO: el pisado ocupa el origen del
 *     arrastrado, cada uno conserva su duración y nadie más se mueve.
 *     Guardas: el intercambio se descarta (y cae a empuje) si el pisado no
 *     cabe en el origen, solaparía a otro bloque o al propio arrastrado.
 *  3. Dos o más pisados → empuje LOCAL en cadena: solo los pisados y quien
 *     choquen directo debajo; el primer hueco libre corta la cadena; como
 *     último recurso se recorta contra el fin del día.
 *  4. Los bloques por encima del drop jamás se tocan. NADA sale del rango
 *     [startHour, endHour] (A2) y todo queda en minutos enteros (anti
 *     "09:60" por flotantes con datos importados).
 *
 * Multi-día (Semana): una fila = un horario global; propagateWeekly resuelve
 * cada día con la arrastrada ANCLADA (pin) a lo que el usuario vio y propaga
 * en cierre transitivo hasta estabilizar, con protección anti-corrupción
 * ex-C3 (el push de un vecino solo es global si no rompe SUS otros días).
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

/** Hora → minutos enteros, redondeados al minuto (blindaje anti-flotantes). */
const toMin = (h: number) => Math.round(h * 60);

/**
 * Resuelve un día. `slots` debe incluir TODOS los bloques del día, con el
 * bloque movido (`movedId`, requerido) en su posición DESTINO. `originStart`
 * es de donde salió el movido (habilita el intercambio); null = bloque nuevo.
 */
export function resolveDayCascade(
  slots: Slot[],
  endHour: number,
  movedId: string,
  startHour = 0,
  originStart?: number | null
): Slot[] {
  const startMin = toMin(startHour);
  const endMin = toMin(endHour);

  const finish = (list: { id: string; start: number; end: number }[]) =>
    list
      .sort((a, b) => a.start - b.start)
      .map(s => ({ id: s.id, start: s.start / 60, end: s.end / 60 }));

  const moved = slots.find(s => s.id === movedId);
  if (!moved) {
    return slots.map(s => ({ id: s.id, start: toMin(s.start) / 60, end: toMin(s.end) / 60 }));
  }
  const mStart = Math.max(startMin, toMin(moved.start));
  const mEnd = Math.min(endMin, Math.max(mStart, toMin(moved.end)));

  const others = slots
    .filter(s => s.id !== movedId)
    .map(s => ({ id: s.id, start: toMin(s.start), end: Math.max(toMin(s.start), toMin(s.end)) }))
    .sort((a, b) => a.start - b.start);

  // 1) Sin colisión: el resto del día no se entera (huecos preservados).
  const colliding = others.filter(o => o.start < mEnd && mStart < o.end);
  if (colliding.length === 0) {
    return finish([...others, { id: movedId, start: mStart, end: mEnd }]);
  }

  // 2) Un solo pisado con origen despejado → intercambio (swap).
  if (colliding.length === 1 && originStart != null) {
    const d = colliding[0];
    const dDur = d.end - d.start;
    const oStart = toMin(originStart);
    const oEnd = oStart + dDur;
    const rest = others.filter(o => o.id !== d.id);
    const fitsDay = oStart >= startMin && oEnd <= endMin;
    // Libre: no solapa a ningún otro bloque ni al arrastrado en su destino.
    const freeSpot =
      !rest.some(o => o.start < oEnd && oStart < o.end) && !(mStart < oEnd && oStart < mEnd);
    if (fitsDay && freeSpot) {
      return finish([
        ...rest,
        { id: d.id, start: oStart, end: oEnd },
        { id: movedId, start: mStart, end: mEnd }
      ]);
    }
  }

  // 3) Empuje local en cadena: pisados + quienes queden en el camino directo.
  const out: { id: string; start: number; end: number }[] = [];
  let cursor = mEnd; // fin del último bloque colocado de la cadena
  for (const o of others) {
    const collides = o.start < mEnd && mStart < o.end;
    // Arriba del drop, o ya tras el primer hueco libre: intacto.
    if (!collides && (o.end <= mStart || o.start >= cursor)) {
      out.push(o);
      continue;
    }
    const dur = Math.max(0, o.end - o.start);
    let start = Math.max(o.start, cursor); // push-down preservando duración
    let end = start + dur;
    if (end > endMin) {
      // No cabe antes del fin del día: subir pegado al final si el hueco está
      // libre; si no, pegado al borde y recorte (último recurso).
      const pulled = Math.max(cursor, endMin - dur);
      const pulledFree =
        pulled + dur <= endMin && !out.some(q => q.start < pulled + dur && pulled < q.end);
      if (pulledFree) {
        start = pulled;
        end = pulled + dur;
      } else {
        start = Math.min(start, endMin);
        end = endMin;
      }
    }
    if (start < startMin) start = startMin;
    end = Math.max(end, start); // guard anti-inversión
    out.push({ id: o.id, start, end });
    cursor = Math.max(cursor, end);
  }
  return finish([...out, { id: movedId, start: mStart, end: mEnd }]);
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
  newDuration?: number,
  startHour = 0
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
  // Origen del arrastrado en un día concreto: su horario global previo si ya
  // estaba ese día (habilita el intercambio); null si el día es nuevo (drag
  // entre columnas → no hay nada que intercambiar, cae a empuje).
  const originOnDay = (day: number): number | null =>
    act.daysOfWeek.includes(day) ? codec.parse(act.startTime) : null;

  const daySet = new Set<number>(mineDays);
  for (let iter = 0; iter < 7; iter++) {
    let changed = false;
    for (const day of [...daySet].sort((a, b) => a - b)) {
      const slots = activities.filter(a => isOnDay(a, day)).map(a => times.get(a.id!)!);
      const resolved = resolveDayCascade(slots, endHour, actId, startHour, originOnDay(day));
      for (const s of resolved) {
        const cur = times.get(s.id);
        if (!cur || Math.abs(cur.start - s.start) > 1e-9 || Math.abs(cur.end - s.end) > 1e-9) {
          // El push/swap de un vecino es LOCAL al día: cambiar su horario
          // global lo movería también en días donde NADIE lo pisó (corrupción
          // silenciosa, ex-C3). Protección: solo se acepta el movimiento
          // global del vecino si no colisiona con nadie en SUS otros días;
          // si rompería, se descarta (queda el solape local permitido).
          const owner = activities.find(a => a.id === s.id);
          if (owner && owner.id !== actId) {
            const otherDays = owner.daysOfWeek.filter(d => !daySet.has(d));
            const breaks = otherDays.some(d =>
              activities
                .filter(a => a.id !== owner.id && a.daysOfWeek.includes(d))
                .some(o => {
                  const t = times.get(o.id!)!;
                  return s.start < t.end - 1e-9 && t.start < s.end - 1e-9;
                })
            );
            if (breaks) continue;
          }
          times.set(s.id, s);
          changed = true;
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

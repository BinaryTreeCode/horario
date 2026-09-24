/**
 * Resolución de colisiones del drag & drop compartida por las vistas Día y
 * Semana. Un solo dueño: cuando cambia la matemática, cambia en ambos lados.
 * Pura y testeada (cascade.test.ts).
 *
 * Semántica LOCAL (decidida con el usuario): el bloque soltado es una pared
 * y solo se mueve lo que pisa directamente.
 *  1. Sin colisión → el resto del día NO se entera: sin cerrar huecos ni
 *     mover vecinos.
 *  2. Soltar DENTRO de otro bloque → regla de mitades: centro del arrastrado
 *     en la MITAD SUPERIOR del pisado → queda ARRIBA, pegado (si ese hueco
 *     está ocupado, toma el inicio del pisado y lo empuja). MITAD INFERIOR →
 *     queda DEBAJO, empezando donde el pisado termina.
 *  3. Lo que el empuje pisa directo baja en cadena, preservando duraciones;
 *     el primer hueco libre corta la cadena; como último recurso se recorta
 *     contra el fin del día.
 *  4. Los bloques por encima del drop jamás se tocan. Lo que el motor mueve
 *     no sale de [startHour, endHour] (A2) y todo queda en minutos enteros.
 *  `keepPlace` (resize): el arrastrado NO se reubica — solo empuja lo que
 *  pisa (estirar conserva el inicio).
 *
 * Multi-día (Semana): propagateWeekly resuelve cada día y propaga en cierre
 * transitivo hasta estabilizar. Protección ex-C3: el movimiento global de un
 * vecino solo se acepta si no pisa a nadie en NINGUNO de sus otros días.
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

const EPS = 1e-9;
/** Cota de seguridad del cierre transitivo semanal. */
const MAX_PASSES = 7;

/** Hora → minutos enteros (blindaje anti-flotantes / "09:60"). */
const toMin = (h: number) => Math.round(h * 60);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const overlaps = (a: Slot, b: Slot) => a.start < b.end - EPS && b.start < a.end - EPS;
const sameSlot = (a: Slot, b: Slot) =>
  Math.abs(a.start - b.start) <= EPS && Math.abs(a.end - b.end) <= EPS;
const toHours = (s: Slot): Slot => ({ id: s.id, start: s.start / 60, end: s.end / 60 });

/**
 * Resuelve un día. `slots` debe incluir TODOS los bloques del día, con el
 * bloque movido (`movedId`) en su posición DESTINO.
 */
export function resolveDayCascade(
  slots: Slot[],
  endHour: number,
  movedId: string,
  startHour = 0,
  keepPlace = false
): Slot[] {
  const startMin = toMin(startHour);
  const endMin = toMin(endHour);

  let moved: Slot | undefined;
  const others: Slot[] = [];
  for (const s of slots) {
    const start = toMin(s.start);
    const m = { id: s.id, start, end: Math.max(start, toMin(s.end)) };
    if (s.id === movedId) moved = m;
    else others.push(m);
  }
  if (!moved) return others.map(toHours);

  // Acotar el movido al rango del día.
  let mStart: number;
  let mEnd: number;
  if (keepPlace) {
    // Resize: el inicio no se mueve; lo que se pasa del día se recorta.
    mStart = clamp(moved.start, startMin, endMin);
    mEnd = clamp(moved.end, mStart, endMin);
  } else {
    // Movimiento: se conserva la duración y se desplaza hasta que quepa.
    // (Soltar fuera del rango mueve el bloque, no lo acorta.)
    const dur = Math.min(moved.end - moved.start, endMin - startMin);
    mStart = clamp(moved.start, startMin, endMin - dur);
    mEnd = mStart + dur;
  }
  const durM = mEnd - mStart;

  others.sort((a, b) => a.start - b.start);
  const finish = (list: Slot[]) => list.sort((a, b) => a.start - b.start).map(toHours);

  // 1) Sin colisión: el resto del día no se entera.
  const colliding = others.filter(o => o.start < mEnd && mStart < o.end);
  if (colliding.length === 0) {
    return finish([...others, { id: movedId, start: mStart, end: mEnd }]);
  }

  // 2) Regla de mitades contra el bloque bajo el centro del drop. Una pila
  //    contigua se trata como bloques separados: se puede insertar ENTRE ellos.
  let finalStart = mStart;
  if (!keepPlace) {
    const center = (mStart + mEnd) / 2;
    const d = colliding.find(o => center >= o.start && center < o.end) ?? colliding[0];
    // Centros comparados ×2; el empate exacto cae ABAJO.
    const above = mStart + mEnd < d.start + d.end;
    if (above) {
      const ideal = d.start - durM;
      const blocked = others.some(o => o.id !== d.id && o.start < d.start && o.end > ideal);
      finalStart = ideal >= startMin && !blocked ? ideal : d.start;
    } else {
      finalStart = d.end;
    }
    finalStart = clamp(finalStart, startMin, endMin - durM);
  }
  const fEnd = finalStart + durM;

  // 3) Empuje en cadena. Todo bloque que entra acá cumple o.start < cursor,
  //    así que arranca en `cursor`; si no cabe, se recorta contra el fin del día.
  const out: Slot[] = [];
  let cursor = fEnd;
  for (const o of others) {
    const hit = o.start < fEnd && finalStart < o.end;
    if (!hit && (o.end <= finalStart || o.start >= cursor)) {
      out.push(o); // arriba del drop o tras el primer hueco: intacto
      continue;
    }
    const start = Math.min(cursor, endMin);
    const end = Math.min(start + (o.end - o.start), endMin);
    out.push({ id: o.id, start, end });
    cursor = Math.max(cursor, end);
  }
  return finish([...out, { id: movedId, start: finalStart, end: fEnd }]);
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
 * `mineDays` son los días finales de la arrastrada (en un drag entre columnas
 * la BD aún tiene los viejos). `keepPlace` (resize): conserva el inicio en
 * todos los días; la nueva duración solo empuja lo que pisa.
 */
export function propagateWeekly(
  activities: Activity[],
  actId: string,
  pinnedStart: number,
  endHour: number,
  codec: TimeCodec,
  mineDays: number[],
  newDuration?: number,
  startHour = 0,
  keepPlace = false
): WeeklyResolution {
  const byId = new Map(activities.map(a => [a.id!, a]));
  const act = byId.get(actId);
  if (!act) return { byDay: new Map(), times: new Map() };
  const duration = newDuration ?? codec.parse(act.endTime) - codec.parse(act.startTime);

  const times = new Map<string, Slot>();
  for (const a of activities) {
    times.set(a.id!, { id: a.id!, start: codec.parse(a.startTime), end: codec.parse(a.endTime) });
  }
  times.set(actId, { id: actId, start: pinnedStart, end: pinnedStart + duration });

  const myDays = new Set(mineDays);
  const isOnDay = (a: Activity, day: number) =>
    a.id === actId ? myDays.has(day) : a.daysOfWeek.includes(day);
  const slotsOn = (day: number) =>
    activities.filter(a => isOnDay(a, day)).map(a => times.get(a.id!)!);

  /** ex-C3: ¿el nuevo horario de `id` pisa a alguien en otro de SUS días? */
  const breaksElsewhere = (id: string, s: Slot, day: number, proposed: Map<string, Slot>) =>
    byId.get(id)!.daysOfWeek.some(
      d =>
        d !== day &&
        activities.some(o => o.id !== id && isOnDay(o, d) && overlaps(s, proposed.get(o.id!)!))
    );

  const daySet = new Set<number>(mineDays);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const day of [...daySet].sort((a, b) => a - b)) {
      const resolved = resolveDayCascade(slotsOn(day), endHour, actId, startHour, keepPlace);
      // Lo que se mueve junto en este día se evalúa con su posición nueva,
      // para que una pila que baja junta no se bloquee a sí misma.
      const proposed = new Map(times);
      for (const s of resolved) proposed.set(s.id, s);

      for (const s of resolved) {
        if (sameSlot(times.get(s.id)!, s)) continue;
        if (s.id !== actId && breaksElsewhere(s.id, s, day, proposed)) {
          proposed.set(s.id, times.get(s.id)!); // rechazado: queda el solape local
          continue;
        }
        times.set(s.id, s);
        changed = true;
        byId.get(s.id)?.daysOfWeek.forEach(d => daySet.add(d));
      }
    }
    if (!changed) break;
  }

  const byDay = new Map<number, Map<string, Slot>>();
  for (const day of daySet) {
    byDay.set(day, new Map(slotsOn(day).map(s => [s.id, s])));
  }
  return { byDay, times };
}

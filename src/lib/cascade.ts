/**
 * Resolución de colisiones del drag & drop compartida por las vistas Día y
 * Semana. Un solo dueño: cuando cambia la matemática, cambia en ambos lados.
 * Pura y testeada (cascade.test.ts).
 *
 * Semántica LOCAL (decidida con el usuario): el bloque soltado es una pared
 * y solo se mueve lo que pisa directamente.
 *  1. Sin colisión → el resto del día NO se entera: sin cerrar huecos ni
 *     mover vecinos (el barrido global re-empaquetaba la columna entera).
 *  2. Soltar DENTRO de otro bloque → regla de mitades: si el centro del
 *     arrastrado cae en la MITAD SUPERIOR del pisado, queda ARRIBA de él
 *     (pegado, terminando donde el pisado empieza; si ese hueco está
 *     ocupado, toma el inicio del pisado y lo empuja hacia abajo). Si cae
 *     en la MITAD INFERIOR, queda DEBAJO (empezando donde el pisado
 *     termina). Nunca queda en el medio ni deja hueco contra el pisado.
 *  3. Lo que el empuje pisa directo baja en cadena, preservando duraciones;
 *     el primer hueco libre corta la cadena; como último recurso se recorta
 *     contra el fin del día.
 *  4. Los bloques por encima del drop jamás se tocan. NADA sale del rango
 *     [startHour, endHour] (A2) y todo queda en minutos enteros (anti
 *     "09:60" por flotantes con datos importados).
 *  `keepPlace` (resize): el arrastrado NO se reubica — solo empuja lo que
 *  pisa (estirar conserva el inicio).
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
 * bloque movido (`movedId`, requerido) en su posición DESTINO. `keepPlace`
 * (resize) ancla el movido: solo empuja lo que pisa, sin reubicarse.
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
  const durM = mEnd - mStart;

  const others = slots
    .filter(s => s.id !== movedId)
    .map(s => ({ id: s.id, start: toMin(s.start), end: Math.max(toMin(s.start), toMin(s.end)) }))
    .sort((a, b) => a.start - b.start);

  // 1) Sin colisión: el resto del día no se entera (huecos preservados).
  const colliding = others.filter(o => o.start < mEnd && mStart < o.end);
  if (colliding.length === 0) {
    return finish([...others, { id: movedId, start: mStart, end: mEnd }]);
  }

  // 2) REGLA DE MITADES contra el bloque CORTADO: el pisado que contiene el
  //    centro del drop. Centro en la mitad superior del cortado → el
  //    arrastrado queda ARRIBA (pegado); mitad inferior → DEBAJO (pegado).
  //    Con una PILA CONTIGUA pisada (2+ bloques pegados) esto la TRATA COMO
  //    BLOQUES SEPARADOS: se corta por el bloque bajo el dedo y el resto se
  //    resuelve en cadena en el paso 3 — se puede insertar ENTRE ellos, en
  //    vez de deslizar la pila entera como un solo bloque.
  let finalStart = mStart;
  if (colliding.length > 0 && !keepPlace) {
    const center = (mStart + mEnd) / 2;
    const d = colliding.find(o => center >= o.start && center < o.end) ?? colliding[0];
    const above = mStart + mEnd < d.start + d.end; // centros comparados ×2
    // (empate exacto, típico con tarjetas del mismo tamaño y snap de 15 min,
    // cae ABAJO: es lo que espera quien suelta en la parte baja)
    if (above) {
      const ideal = d.start - durM;
      const blocked = others.some(o => o.id !== d.id && o.start < d.start && o.end > ideal);
      finalStart = ideal >= startMin && !blocked ? ideal : d.start;
    } else {
      finalStart = d.end;
    }
    finalStart = Math.max(startMin, Math.min(finalStart, endMin - durM));
  }
  const fEnd = finalStart + durM;

  // 3) Empuje local en cadena desde la posición FINAL del arrastrado: solo
  //    quienes pisa directo bajan, preservando su duración; el primer hueco
  //    corta la cadena; límites del día como último recurso.
  const out: { id: string; start: number; end: number }[] = [];
  let cursor = fEnd; // fin del último bloque colocado de la cadena
  for (const o of others) {
    const collides = o.start < fEnd && finalStart < o.end;
    // Arriba del drop, o ya tras el primer hueco libre: intacto.
    if (!collides && (o.end <= finalStart || o.start >= cursor)) {
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
 * `mineDays` son los días finales de la arrastrada (el commit puede quitar el
 * origen en un drag entre columnas — la BD aún tiene los viejos).
 * `keepPlace` (resize): la actividad estirada conserva su inicio en TODOS los
 * días — la nueva duración solo empuja lo que pisa, sin regla de mitades.
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
      const resolved = resolveDayCascade(slots, endHour, actId, startHour, keepPlace);
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

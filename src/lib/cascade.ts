/**
 * Resolución de colisiones del drag & drop — semántica "adelantar posiciones"
 * (decidida con el usuario sobre el prototipo vanilla v2):
 *
 *  1. HUECO LIBRE: si el dedo cae en espacio vacío, el bloque llena el hueco
 *     (el caller ya aplicó snap+clamp al inicio deseado; acá se acota al
 *     hueco). Si el hueco es más chico que el bloque → ⛔ inválido: el
 *     fantasma va rojo y al soltar el bloque vuelve a su sitio.
 *  2. SOBRE OTRO BLOQUE → MITADES: mitad superior del pisado = insertar ANTES,
 *     mitad inferior = insertar DESPUÉS. El tramo afectado se REEMPAQUETA
 *     conservando duraciones y huecos internos: el arrastrado ADELANTA
 *     posiciones y los intermedios suben o bajan un puesto (rotación).
 *  3. SIN REEMPLAZOS: el pisado jamás desaparece ni se intercambia — el día
 *     conserva exactamente los mismos ids.
 *  4. ENTRE COLUMNAS (crossInto): el arrastrado no vive en el día destino →
 *     se inserta pegado al pisado (antes/después) y el resto baja en cadena
 *     absorbiendo huecos (empujarAbajo); si no cabe en el día → ⛔.
 *  5. ESTIRAR: crece hasta el hueco libre REAL del lado (la suma de
 *     duraciones de los vecinos, no sus posiciones) y empuja en cadena —
 *     nunca trunca vecinos ni sale del día.
 *
 * El contrato con las vistas es en HORAS (float); internamente todo se
 * resuelve en MINUTOS ENTEROS (blindaje anti-flotantes). Pura y testeada
 * (cascade.test.ts). El snap de 15 min lo aplica el caller: acá NO se
 * re-ajusta nada, para que re-resolver un resultado sea idempotente
 * ("lo que se ve es lo que se guarda").
 */
import type { Activity } from './types.js';

export interface Slot {
  id: string;
  /** Horas decimales desde medianoche (contrato con las vistas). */
  start: number;
  end: number;
}

/** Convertidor inyectable para no importar la store desde este módulo puro. */
export interface TimeCodec {
  parse: (time: string) => number;
  format: (hour: number) => string;
}

export type AccionDrop = 'hueco' | 'insertar' | 'redim';

export interface DayResolution {
  /** Día completo resuelto, incluido el movido en su destino. */
  slots: Slot[];
  /** false → fantasma rojo y drop rechazado (el bloque vuelve a su sitio). */
  valido: boolean;
  /** Motivo para el usuario ('' si válido). */
  motivo: string;
  accion: AccionDrop;
  /** Slot final del movido (ancla del commit / topOverride). */
  movido: Slot;
}

const EPS = 1e-9;
/** Cota de seguridad del cierre transitivo semanal. */
const MAX_PASSES = 7;
/** Umbral de mitades: 0.5 = todo el bloque es "antes" o "después" (sin reemplazos). */
const ZONA = 0.5;

const toMin = (h: number) => Math.round(h * 60);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sameSlot = (a: Slot, b: Slot) =>
  Math.abs(a.start - b.start) <= EPS && Math.abs(a.end - b.end) <= EPS;
const overlaps = (a: Slot, b: Slot) => a.start < b.end - EPS && b.start < a.end - EPS;

/** Bloque en minutos (representación interna). */
interface BloqueM {
  id: string;
  inicio: number;
  dur: number;
}
const aM = (s: Slot): BloqueM => ({
  id: s.id,
  inicio: toMin(s.start),
  dur: Math.max(0, toMin(s.end) - toMin(s.start))
});
const aHoras = (b: BloqueM): Slot => ({ id: b.id, start: b.inicio / 60, end: (b.inicio + b.dur) / 60 });
const finDe = (b: BloqueM) => b.inicio + b.dur;
const porInicio = (a: BloqueM, b: BloqueM) => a.inicio - b.inicio;

/** Índice del bloque bajo `minuto` (−1 si el dedo cae en hueco libre). */
const bajo = (otros: BloqueM[], minuto: number): number =>
  otros.findIndex(o => minuto >= o.inicio && minuto < finDe(o) - EPS);

/** Hueco libre alrededor de `minuto`: [ini, fn) en minutos. */
function huecoAlrededor(otros: BloqueM[], minuto: number, minM: number, maxM: number): [number, number] {
  const ini = Math.max(minM, ...otros.filter(o => finDe(o) <= minuto + EPS).map(finDe));
  const fn = Math.min(maxM, ...otros.filter(o => o.inicio > minuto + EPS).map(o => o.inicio));
  return [ini, Math.max(ini, fn)];
}

/**
 * Reempaqueta el tramo que cambió entre O (día con el arrastrado en su
 * posición ORIGINAL) y N (el día en su NUEVO orden): cada bloque del tramo
 * conserva su duración y los huecos internos del tramo quedan entre los
 * mismos vecinos. Fuera del tramo no se mueve nada. Efecto: el arrastrado
 * adelanta y los intermedios se corren un puesto (puerto del v2).
 */
function reempaquetar(O: BloqueM[], N: BloqueM[]): void {
  let lo = 0;
  while (lo < O.length && O[lo].id === N[lo].id) lo++;
  if (lo >= O.length) return;
  let hi = O.length - 1;
  while (O[hi].id === N[hi].id) hi--;
  let t = O[lo].inicio;
  for (let k = lo; k <= hi; k++) {
    N[k].inicio = t;
    t += N[k].dur;
    if (k < hi) t += Math.max(0, O[k + 1].inicio - finDe(O[k]));
  }
}

/** Empuje en cadena hacia abajo desde el índice i (los huecos absorben). */
function empujarAbajo(arr: BloqueM[], i: number): void {
  let cursor = finDe(arr[i]);
  for (let k = i + 1; k < arr.length; k++) {
    if (arr[k].inicio < cursor - EPS) arr[k].inicio = cursor;
    cursor = Math.max(cursor, finDe(arr[k]));
  }
}

/** ¿Todo el día dentro de [minM, maxM]? */
const enRango = (arr: BloqueM[], minM: number, maxM: number) =>
  arr.every(b => b.inicio >= minM - EPS && finDe(b) <= maxM + EPS);

const cerrar = (arr: BloqueM[]): Slot[] => [...arr].sort(porInicio).map(aHoras);

/**
 * MOVER: resuelve el día para el drop del bloque `movido` (destino deseado;
 * el caller ya le aplicó snap y clamp al día). `fingerHour` es la posición
 * CRUDA del dedo (sin snap ni offset): decide el hueco y la mitad
 * antes/después. `crossInto` = el arrastrado NO vive en este día (drag entre
 * columnas): se inserta con empuje en cadena en vez de rotar el tramo.
 */
export function resolveDayCascade(
  slots: Slot[],
  movido: Slot,
  fingerHour: number,
  crossInto: boolean,
  startHour = 0,
  endHour = 24
): DayResolution {
  const minM = toMin(startHour);
  const maxM = toMin(endHour);
  const id = movido.id;
  const fingerM = clamp(toMin(fingerHour), minM, maxM);

  const ordenados = slots.map(aM).sort(porInicio);
  const idxMio = ordenados.findIndex(x => x.id === id);
  const mismoDia = !crossInto && idxMio !== -1;

  if (mismoDia) {
    const durM = ordenados[idxMio].dur;
    const otros = ordenados.filter(x => x.id !== id);
    const bb: BloqueM = { id, inicio: ordenados[idxMio].inicio, dur: durM };
    const deseado = clamp(toMin(movido.start), minM, Math.max(minM, maxM - durM));

    const j = bajo(otros, fingerM);
    if (j === -1) {
      // 1) HUECO LIBRE: llenar el hueco alrededor del dedo; si no cabe → ⛔.
      const [ini, fn] = huecoAlrededor(otros, fingerM, minM, maxM);
      const cabe = fn - ini >= durM - EPS;
      bb.inicio = cabe ? clamp(deseado, ini, fn - durM) : deseado;
      return {
        slots: cerrar([...otros, bb]),
        valido: cabe,
        motivo: cabe ? '' : '⛔ No cabe en este hueco',
        accion: 'hueco',
        movido: aHoras(bb)
      };
    }

    // 2) MITADES sobre el pisado: mitad superior → ANTES, inferior → DESPUÉS.
    //    Rotación del tramo (reempaquetar): adelanta posiciones, sin
    //    reemplazos — el día conserva sus ids.
    const o = otros[j];
    const rel = o.dur > 0 ? (fingerM - o.inicio) / o.dur : 1;
    const idx = rel < ZONA ? j : j + 1;
    const N = otros.map(x => ({ ...x }));
    N.splice(idx, 0, bb);
    reempaquetar(ordenados, N);
    const valido = enRango(N, minM, maxM);
    return {
      slots: cerrar(N),
      valido,
      motivo: valido ? '' : '⛔ No cabe en el día',
      accion: 'insertar',
      movido: aHoras(N.find(x => x.id === id)!)
    };
  }

  // 3) ENTRE COLUMNAS: insertar pegado al pisado (antes/después según la
  //    mitad) y empujar el resto en cadena; si el día no da más → ⛔.
  const durM = Math.max(1, toMin(movido.end) - toMin(movido.start));
  const otros = ordenados.filter(x => x.id !== id);
  const bb: BloqueM = { id, inicio: toMin(movido.start), dur: durM };
  const deseado = clamp(toMin(movido.start), minM, Math.max(minM, maxM - durM));

  const j = bajo(otros, fingerM);
  if (j === -1) {
    const [ini, fn] = huecoAlrededor(otros, fingerM, minM, maxM);
    const cabe = fn - ini >= durM - EPS;
    bb.inicio = cabe ? clamp(deseado, ini, fn - durM) : deseado;
    return {
      slots: cerrar([...otros, bb]),
      valido: cabe,
      motivo: cabe ? '' : '⛔ No cabe en este hueco',
      accion: 'hueco',
      movido: aHoras(bb)
    };
  }

  const o = otros[j];
  const rel = o.dur > 0 ? (fingerM - o.inicio) / o.dur : 1;
  const idx = rel < ZONA ? j : j + 1;
  const N = otros.map(x => ({ ...x }));
  bb.inicio = rel < ZONA ? o.inicio : finDe(o);
  N.splice(idx, 0, bb);
  empujarAbajo(N, idx);
  const valido = enRango(N, minM, maxM);
  return {
    slots: cerrar(N),
    valido,
    motivo: valido ? '' : '⛔ No cabe en el día',
    accion: 'insertar',
    movido: aHoras(bb)
  };
}

/**
 * ESTIRAR (regla 3+4 del usuario): el borde deseado (`deseadoHour`, ya con
 * snap del caller) se acota por el hueco libre REAL del lado — la suma de
 * duraciones de los vecinos, no sus posiciones — y el avance empuja en
 * cadena preservando duraciones. Nunca trunca vecinos ni sale del día.
 * 'abajo' conserva el inicio; 'arriba' conserva el fin.
 */
export function resolveResizeDay(
  slots: Slot[],
  movedId: string,
  lado: 'arriba' | 'abajo',
  deseadoHour: number,
  startHour = 0,
  endHour = 24
): DayResolution {
  const minM = toMin(startHour);
  const maxM = toMin(endHour);
  const N = slots.map(aM).sort(porInicio);
  const i = N.findIndex(x => x.id === movedId);
  if (i === -1) {
    return {
      slots: cerrar(N),
      valido: false,
      motivo: '⛔ Bloque no encontrado',
      accion: 'redim',
      movido: { id: movedId, start: startHour, end: startHour }
    };
  }
  const b = N[i];
  const paso = 1; // mínimo defensivo: el caller ya snap-ea y acota a 15 min

  if (lado === 'abajo') {
    const libre = Math.max(0, maxM - finDe(b) - N.slice(i + 1).reduce((s, x) => s + x.dur, 0));
    const E = clamp(toMin(deseadoHour), b.inicio + paso, finDe(b) + libre);
    b.dur = E - b.inicio;
    empujarAbajo(N, i);
  } else {
    const libre = Math.max(0, b.inicio - minM - N.slice(0, i).reduce((s, x) => s + x.dur, 0));
    const F = finDe(b);
    const S = clamp(toMin(deseadoHour), b.inicio - libre, F - paso);
    b.dur = F - S;
    b.inicio = S;
    let cursor = S;
    for (let k = i - 1; k >= 0; k--) {
      if (finDe(N[k]) > cursor + EPS) N[k].inicio = cursor - N[k].dur;
      cursor = Math.min(cursor, N[k].inicio);
    }
  }
  const valido = enRango(N, minM, maxM);
  return {
    slots: cerrar(N),
    valido,
    motivo: valido ? '' : '⛔ No cabe en el día',
    accion: 'redim',
    movido: aHoras(N.find(x => x.id === movedId)!)
  };
}

/**
 * Nudge (M6, teclado): ancla el bloque en `newStartHour` como PARED y empuja
 * en cadena lo que pisa. Sin regla de mitades: ±15 min es un deseo exacto,
 * no un drop con dedo.
 */
export function resolveNudgeDay(
  slots: Slot[],
  movedId: string,
  newStartHour: number,
  startHour = 0,
  endHour = 24
): DayResolution {
  const minM = toMin(startHour);
  const maxM = toMin(endHour);
  const ordenados = slots.map(aM).sort(porInicio);
  const mio = ordenados.find(x => x.id === movedId);
  if (!mio) {
    return {
      slots: cerrar(ordenados),
      valido: true,
      motivo: '',
      accion: 'hueco',
      movido: { id: movedId, start: newStartHour, end: newStartHour }
    };
  }
  const inicio = clamp(toMin(newStartHour), minM, Math.max(minM, maxM - mio.dur));
  const out = resolvePared(ordenados, movedId, { inicio, dur: mio.dur }, maxM);
  return {
    slots: cerrar(out),
    valido: enRango(out, minM, maxM),
    motivo: '',
    accion: 'hueco',
    movido: { id: movedId, start: inicio / 60, end: (inicio + mio.dur) / 60 }
  };
}

/**
 * Día con el arrastrado como PARED en `pared`: los bloques que pisa bajan en
 * cadena desde el fin de la pared (conservando duraciones); el resto queda
 * intacto. Último recurso: recorte contra el fin del día — solo acá, porque
 * el resize semanal puede pedir más de lo que el día tiene.
 */
function resolvePared(
  todosM: BloqueM[],
  id: string,
  pared: { inicio: number; dur: number },
  maxM: number
): BloqueM[] {
  const otros = todosM.filter(x => x.id !== id).sort(porInicio);
  const out: BloqueM[] = [];
  let cursor = pared.inicio + pared.dur;
  for (const o of otros) {
    const hit = o.inicio < cursor - EPS && pared.inicio < finDe(o) - EPS;
    if (!hit) {
      out.push(o);
      continue;
    }
    const inicio = Math.min(cursor, maxM);
    const fin = Math.min(inicio + o.dur, maxM);
    out.push({ id: o.id, inicio, dur: Math.max(0, fin - inicio) });
    cursor = Math.max(cursor, fin);
  }
  return [...out, { id, inicio: pared.inicio, dur: pared.dur }].sort(porInicio);
}

export interface WeeklyResolution {
  /** id → slot final, por día incluido en el cierre. */
  byDay: Map<number, Map<string, Slot>>;
  /** Horario global final por actividad (lo escribible en la BD). */
  times: Map<string, Slot>;
}

/**
 * Propaga el cambio de una actividad a TODOS los días afectados y resuelve
 * el cierre transitivo hasta estabilizar.
 *
 *  - `pinnedStart`: el arranque que el usuario vio (la pared). Los días
 *    distintos del drop tratan al arrastrado como PARED anclada ahí: solo se
 *    hace room para él (empuje en cadena), jamás se reubica — lo que viste
 *    es lo que se guarda.
 *  - `diaDestino`: la resolución EXACTA del día del drop (la del preview).
 *    Si viene, ese día NO se re-deriva: se siembra tal cual — es lo que hace
 *    que preview y commit sean el mismo cálculo.
 *  - `keepPlace` (resize): la pared conserva el inicio y usa la nueva
 *    duración (`newDuration`) en todos los días.
 *  - ex-C3: el movimiento global de un vecino solo se acepta si no pisa a
 *    nadie en NINGUNO de sus otros días (lo rechazado queda solapado en
 *    local, visible, en vez de irse a corromper otro día).
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
  keepPlace = false,
  diaDestino?: { day: number; slots: Slot[] }
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
  const exacto = diaDestino ? new Map(diaDestino.slots.map(s => [s.id, s])) : null;
  if (diaDestino) daySet.add(diaDestino.day);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const day of [...daySet].sort((a, b) => a - b)) {
      if (exacto && diaDestino && day === diaDestino.day) {
        // Día del drop: los slots EXACTOS del preview se siembran tal cual.
        for (const s of exacto.values()) {
          if (!sameSlot(times.get(s.id)!, s)) {
            if (s.id !== actId && breaksElsewhere(s.id, s, day, times)) continue; // rechazado
            times.set(s.id, s);
            changed = true;
          }
          byId.get(s.id)?.daysOfWeek.forEach(d => daySet.add(d));
        }
        continue;
      }

      // Días restantes: el arrastrado es PARED en pinnedStart.
      const res = resolvePared(
        slotsOn(day).map(aM),
        actId,
        { inicio: toMin(pinnedStart), dur: Math.max(0, Math.round(duration * 60)) },
        toMin(endHour)
      );
      const proposed = new Map(times);
      for (const s of res) proposed.set(aHoras(s).id, aHoras(s));

      for (const sM of res) {
        const s = aHoras(sM);
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

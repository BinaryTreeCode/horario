/**
 * Resolución de colisiones del drag & drop — semántica "adelantar posiciones"
 * (decidida con el usuario sobre el prototipo vanilla v2):
 *
 *  1. HUECO LIBRE: si el dedo cae en espacio vacío, el bloque llena el hueco
 *     (el caller ya aplicó snap+clamp al inicio deseado; acá se acota al
 *     hueco). Si el hueco es más chico que el bloque → INSERCIÓN CERCANA
 *     (nunca ⛔): el vecino más próximo al dedo recibe la mitad y la
 *     rotación del tramo acomoda al arrastrado — el dedo pide, la cadena
 *     responde.
 *  2. SOBRE OTRO BLOQUE → MITADES: mitad superior del pisado = insertar ANTES,
 *     mitad inferior = insertar DESPUÉS. El tramo afectado se REEMPAQUETA
 *     COMPACTANDO: conserva duraciones, cierra los huecos internos y el hueco
 *     liberado queda al FINAL del tramo — el arrastrado ADELANTA posiciones
 *     y los intermedios avanzan un puesto (rotación). Nunca extiende el span.
 *  3. SIN REEMPLAZOS: el pisado jamás desaparece ni se intercambia — el día
 *     conserva exactamente los mismos ids.
 *  4. ENTRE COLUMNAS (crossInto): el arrastrado no vive en el día destino →
 *     se inserta pegado al pisado (antes/después) y los siguientes quedan
 *     CONTIGUOS (compactados, igual que el mismo día); si no cabe → ⛔.
 *  5. ESTIRAR (arriba o abajo): crece hasta el hueco libre REAL del lado (la
 *     suma de duraciones de los vecinos, no sus posiciones) y empuja en
 *     cadena — nunca trunca vecinos ni sale del día.
 *  6. EMPUJE EN CADENA (semántica demo, Semana): el horario es GLOBAL — el
 *     arrastrado y los vecinos reubicados actúan como PAREDES en todos sus
 *     días y cierran los choques empujando en cadena (transitivo, igual que
 *     el ESTIRAR). ⛔ solo si una cadena desborda el rango de algún día.
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
  /** F4: al estirar, con qué topó el borde acotado por la capacidad
   *  ('' = el puntero mandó, sin acote). Solo lo llena resolveResizeDay. */
  limitadoPor?: '' | 'un bloque' | 'el fin del día' | 'el inicio del día';
}

const EPS = 1e-9;
/** Cota de seguridad del cierre del resize semanal. */
const MAX_PASSES = 7;
/** Umbral de mitades: 0.5 = todo el bloque es "antes" o "después" (sin reemplazos). */
const ZONA = 0.5;
/** Nombres de día (0 = Lunes) para los motivos de rechazo del Semanal. */
const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

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
 * conserva su duración y el tramo queda COMPACTO (pegado) — los huecos
 * internos se cierran y el hueco liberado aparece al final del tramo. Fuera
 * del tramo no se mueve nada. Efecto: el arrastrado adelanta y los
 * intermedios avanzan un puesto; como la compactación nunca extiende el span
 * original, la rotación no puede desbordar el día.
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
      // 1) HUECO LIBRE: llenar el hueco alrededor del dedo. Si el hueco es
      //    más chico que el bloque → INSERCIÓN CERCANA (F4, nunca ⛔): el
      //    vecino más próximo al dedo recibe la mitad y la rotación del
      //    tramo acomoda al arrastrado — el dedo pide, la cadena responde.
      const [ini, fn] = huecoAlrededor(otros, fingerM, minM, maxM);
      const cabe = fn - ini >= durM - EPS;
      if (cabe) {
        bb.inicio = clamp(deseado, ini, fn - durM);
        return {
          slots: cerrar([...otros, bb]),
          valido: true,
          motivo: '',
          accion: 'hueco',
          movido: aHoras(bb)
        };
      }
      // Vecino más próximo al dedo: distancia al bloque completo (inicio o
      // fin, lo más cerca — no solo al inicio, que sesga hacia el de abajo).
      const cercano = otros.reduce((mejor, o) => {
        const dO = Math.min(Math.abs(o.inicio - fingerM), Math.abs(finDe(o) - fingerM));
        const dMejor = Math.min(Math.abs(mejor.inicio - fingerM), Math.abs(finDe(mejor) - fingerM));
        return dO < dMejor ? o : mejor;
      });
      const rel = cercano.dur > 0 ? (fingerM - cercano.inicio) / cercano.dur : 1;
      const relC = clamp(rel, 0, 1);
      const idx = relC < ZONA ? otros.indexOf(cercano) : otros.indexOf(cercano) + 1;
      const N = otros.map(x => ({ ...x }));
      // El dedo está en un HUECO (no sobre el vecino): el ancla es el borde
      // del vecino más próximo y el empuje es con absorción de huecos — la
      // compactación total arrastraría bloques lejanos que tienen hueco.
      bb.inicio = relC < ZONA ? cercano.inicio : finDe(cercano);
      N.splice(idx, 0, bb);
      empujarAbajo(N, idx);
      const valido = enRango(N, minM, maxM);
      return {
        slots: cerrar(N),
        valido,
        motivo: valido ? '' : '⛔ No cabe en el día',
        accion: 'insertar',
        movido: aHoras(N.find(x => x.id === id)!)
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
    // ENTRE COLUMNAS sobre hueco: si el hueco da, llena; si es chico →
    // INSERCIÓN CERCANA pegado al vecino más próximo (nunca ⛔) con
    // compactación del tramo (igual que el caso sobre bloque).
    const [ini, fn] = huecoAlrededor(otros, fingerM, minM, maxM);
    const cabe = fn - ini >= durM - EPS;
    if (cabe) {
      bb.inicio = clamp(deseado, ini, fn - durM);
      return {
        slots: cerrar([...otros, bb]),
        valido: true,
        motivo: '',
        accion: 'hueco',
        movido: aHoras(bb)
      };
    }
    const cercano = otros.reduce((mejor, o) => {
      const dO = Math.min(Math.abs(o.inicio - fingerM), Math.abs(finDe(o) - fingerM));
      const dMejor = Math.min(Math.abs(mejor.inicio - fingerM), Math.abs(finDe(mejor) - fingerM));
      return dO < dMejor ? o : mejor;
    });
    const rel = cercano.dur > 0 ? (fingerM - cercano.inicio) / cercano.dur : 1;
    const relC = clamp(rel, 0, 1);
    const idx = relC < ZONA ? otros.indexOf(cercano) : otros.indexOf(cercano) + 1;
    const N = otros.map(x => ({ ...x }));
    // Ancla al borde del vecino más próximo + empuje con absorción de huecos
    // (igual que el mismo día): no arrastra bloques lejanos con hueco libre.
    bb.inicio = relC < ZONA ? cercano.inicio : finDe(cercano);
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

  const o = otros[j];
  const rel = o.dur > 0 ? (fingerM - o.inicio) / o.dur : 1;
  const idx = rel < ZONA ? j : j + 1;
  const N = otros.map(x => ({ ...x }));
  bb.inicio = rel < ZONA ? o.inicio : finDe(o);
  N.splice(idx, 0, bb);
  // Compactación (igual que el mismo día): desde el punto de inserción todo
  // queda CONTIGUO — adelanta posiciones, jamás empuja más allá del tramo.
  let t = bb.inicio;
  for (let k = idx; k < N.length; k++) {
    N[k].inicio = t;
    t += N[k].dur;
  }
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
  // Encoger NUNCA se rechaza: libera espacio (no empuja a nadie fuera del
  // día) y puede ser la única vía para arreglar un día ya desbordado.
  // Antes, si el día venía desbordado de escrituras previas, el candado de
  // rango de abajo rechazaba CUALQUIER resize — incluso el que lo arreglaba.
  const encoge = lado === 'abajo'
    ? toMin(deseadoHour) <= finDe(b) + EPS
    : toMin(deseadoHour) >= b.inicio - EPS;

  // F4: con qué topó el borde acotado (feedback 'limitadoPor' para la vista).
  let limitadoPor: DayResolution['limitadoPor'] = '';
  if (lado === 'abajo') {
    const vecinos = N.slice(i + 1).reduce((s, x) => s + x.dur, 0);
    const libre = encoge
      ? Infinity // libre ilimitado: el borde retrocede, nadie se perjudica
      : Math.max(0, maxM - finDe(b) - vecinos);
    const topeBorde = finDe(b) + libre;
    const E = clamp(toMin(deseadoHour), b.inicio + paso, topeBorde);
    if (!encoge && E < toMin(deseadoHour) - EPS) {
      limitadoPor = vecinos > 0 ? 'un bloque' : 'el fin del día';
    }
    b.dur = E - b.inicio;
    empujarAbajo(N, i);
  } else {
    const vecinos = N.slice(0, i).reduce((s, x) => s + x.dur, 0);
    const libre = encoge
      ? Infinity // subir el inicio = encoger: el borde baja, nadie se perjudica
      : Math.max(0, b.inicio - minM - vecinos);
    const pisoBorde = b.inicio - libre;
    const F = finDe(b);
    const S = clamp(toMin(deseadoHour), pisoBorde, F - paso);
    if (!encoge && S > toMin(deseadoHour) + EPS) {
      limitadoPor = vecinos > 0 ? 'un bloque' : 'el inicio del día';
    }
    b.dur = F - S;
    b.inicio = S;
    let cursor = S;
    for (let k = i - 1; k >= 0; k--) {
      if (finDe(N[k]) > cursor + EPS) N[k].inicio = cursor - N[k].dur;
      cursor = Math.min(cursor, N[k].inicio);
    }
  }
  // El candado de rango solo aplica al ESTIRAR: encoger siempre es válido.
  // Nota: si el día venía desbordado, la cadena solo acorta huecos — no
  // agranda el desborde preexistente.
  const valido = encoge ? true : enRango(N, minM, maxM);
  return {
    slots: cerrar(N),
    valido,
    motivo: valido ? '' : '⛔ No cabe en el día',
    accion: 'redim',
    movido: aHoras(N.find(x => x.id === movedId)!),
    limitadoPor
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
  const out = resolvePared(ordenados, movedId, { inicio, dur: mio.dur });
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
 * intacto. SIN recorte contra el fin del día: si la cadena desborda, los
 * bloques quedan fuera de rango y el caller lo detecta con enRango → ⛔.
 * (Truncar acá escondía el desborde: bloques encogidos o arrastrados bajo el
 * límite en vez de rechazar el movimiento — bug del límite del día.)
 */
function resolvePared(
  todosM: BloqueM[],
  id: string,
  pared: { inicio: number; dur: number }
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
    out.push({ id: o.id, inicio: cursor, dur: o.dur });
    cursor = Math.max(cursor, cursor + o.dur);
  }
  return [...out, { id, inicio: pared.inicio, dur: pared.dur }].sort(porInicio);
}

/**
 * Espejo de resolvePared para estirar hacia ARRIBA: la pared queda anclada
 * por su FIN y lo pisado sube en cadena (conservando duraciones), como
 * resolveResizeDay('arriba'). Los bloques que quedan fuera de rango (antes
 * del inicio del día) se devuelven igual — el caller detecta el desborde
 * con enRango y rechaza (⛔ y nada se escribe).
 */
function resolveParedArriba(
  todosM: BloqueM[],
  id: string,
  pared: { inicio: number; dur: number }
): BloqueM[] {
  const fin = pared.inicio + pared.dur;
  const otros = todosM.filter(x => x.id !== id).sort((a, b) => finDe(b) - finDe(a));
  const out: BloqueM[] = [];
  let cursor = pared.inicio; // tope disponible para lo pisado
  for (const o of otros) {
    const hit = o.inicio < fin - EPS && cursor < finDe(o) - EPS;
    if (!hit) {
      out.push(o);
      continue;
    }
    const nuevoInicio = cursor - o.dur;
    out.push({ id: o.id, inicio: nuevoInicio, dur: o.dur });
    cursor = Math.min(cursor, nuevoInicio);
  }
  return [...out, { id, inicio: pared.inicio, dur: pared.dur }].sort(porInicio);
}

export interface WeeklyResolution {
  /** id → slot final, por día incluido en el cierre. */
  byDay: Map<number, Map<string, Slot>>;
  /** Horario global final por actividad (lo escribible en la BD). */
  times: Map<string, Slot>;
  /** false → el movimiento choca o desborda en algún día: NO escribir nada. */
  valido: boolean;
  /** Motivo del rechazo ('' si válido). */
  motivo: string;
}

/**
 * Propaga el cambio de una actividad a TODOS los días afectados.
 *
 *  - MOVER (semántica demo): el día del drop se siembra EXACTO (preview =
 *    commit) y en los demás días cada bloque CAMBIADO actúa como PARED:
 *    cierra los choques empujando en cadena (transitivo, MAX_PASSES), igual
 *    que el ESTIRAR — nunca reemplaza a nadie. Sin `diaDestino` (drag sin
 *    preview, teclado sin preview): el arrastrado es la única pared. ⛔ solo
 *    si una cadena desborda el rango de algún día.
 *  - `diaDestino`: la resolución EXACTA del día del drop (la del preview). Si
 *    viene, ese día NO se re-deriva: se siembra tal cual — es lo que hace que
 *    preview y commit sean el mismo cálculo.
 *  - ESTIRAR (`keepPlace` + `newDuration`): la pared anclada al borde fijo
 *    empuja en cadena en todos los días. SIN recorte: si algún día
 *    desborda el rango → rechazo completo (el candado del límite del día;
 *    al ENCOGER siempre está permitido).
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
  diaDestino?: { day: number; slots: Slot[] },
  /** Lado del ESTIRAR: 'abajo' ancla el inicio (pared empuja abajo); 'arriba'
   *  ancla el fin (lo pisado sube en cadena). Lo usa el resize semanal. */
  ladoRedim: 'arriba' | 'abajo' = 'abajo'
): WeeklyResolution {
  const rechazar = (motivo: string): WeeklyResolution => ({
    byDay: new Map(), times: new Map(), valido: false, motivo
  });
  const byId = new Map(activities.map(a => [a.id!, a]));
  const act = byId.get(actId);
  if (!act) return rechazar('⛔ Actividad no encontrada');
  const duration = newDuration ?? codec.parse(act.endTime) - codec.parse(act.startTime);

  const times = new Map<string, Slot>();
  for (const a of activities) {
    times.set(a.id!, { id: a.id!, start: codec.parse(a.startTime), end: codec.parse(a.endTime) });
  }
  times.set(actId, { id: actId, start: pinnedStart, end: pinnedStart + duration });

  const minM = toMin(startHour);
  const maxM = toMin(endHour);
  const myDays = new Set(mineDays);
  const isOnDay = (a: Activity, day: number) =>
    a.id === actId ? myDays.has(day) : a.daysOfWeek.includes(day);
  const slotsOn = (day: number) =>
    activities.filter(a => isOnDay(a, day)).map(a => times.get(a.id!)!);

  /** ¿el nuevo horario de `id` pisa a alguien en otro de SUS días? */
  const breaksElsewhere = (id: string, s: Slot, day: number) =>
    byId.get(id)!.daysOfWeek.some(
      d =>
        d !== day &&
        activities.some(o => o.id !== id && isOnDay(o, d) && overlaps(s, times.get(o.id!)!))
    );

  const daySet = new Set<number>(mineDays);
  const exacto = diaDestino ? new Map(diaDestino.slots.map(s => [s.id, s])) : null;
  if (diaDestino) daySet.add(diaDestino.day);

  if (exacto && diaDestino) {
    // ── MOVER con día del drop: sembrar EXACTO y cerrar choques en cadena ──
    // El día del drop va tal cual (preview = commit). Cada bloque CAMBIADO
    // (arrastrado + vecinos reubicados) actúa como PARED en TODOS sus días:
    // lo pisado baja en cadena (conservando duración) hasta que nadie choque
    // — transitivo: un empujado que pisa a otro se vuelve pared (MAX_PASSES).
    for (const s of exacto.values()) {
      // En HORAS (exacto son Slots; minM/maxM son minutos).
      if (s.start < startHour - EPS || s.end > endHour + EPS) return rechazar('⛔ No cabe en el día');
      times.set(s.id, s);
    }
    // Paredes = bloques cuyo horario global cambió respecto a la BD (crece
    // con cada empuje: la cadena es transitiva).
    const paredes = new Set<string>();
    const cambioOrig = (id: string) => {
      const orig = byId.get(id);
      return !!orig && !sameSlot(times.get(id)!, { id, start: codec.parse(orig.startTime), end: codec.parse(orig.endTime) });
    };
    for (const id of times.keys()) if (cambioOrig(id)) paredes.add(id);
    // Días a cerrar: los del daySet + todos los días de cada pared.
    const aCerrar = new Set<number>(daySet);
    for (const id of paredes) byId.get(id)?.daysOfWeek.forEach(d => aCerrar.add(d));
    for (let pass = 0; pass < MAX_PASSES && aCerrar.size > 0; pass++) {
      let changed = false;
      for (const day of [...aCerrar].sort((a, b) => a - b)) {
        for (const id of paredes) {
          if (!isOnDay(byId.get(id)!, day)) continue; // la pared no vive en este día
          const w = times.get(id)!;
          const pared = { inicio: toMin(w.start), dur: Math.max(1, Math.round((w.end - w.start) * 60)) };
          const res = resolvePared(slotsOn(day).map(aM), id, pared);
          for (const sM of res) {
            const s2 = aHoras(sM);
            if (sameSlot(times.get(s2.id)!, s2)) continue;
            times.set(s2.id, s2);
            changed = true;
            paredes.add(s2.id);
            byId.get(s2.id)?.daysOfWeek.forEach(d => aCerrar.add(d));
          }
        }
      }
      if (!changed) break;
    }
    // Candado doble: rango Y solapes residuales (cierre no convergido).
    for (const day of aCerrar) {
      const nombreDia = DIAS_SEMANA[day] ?? `día ${day}`;
      const slotsDia = slotsOn(day);
      const fuera = slotsDia.find(s => s.start < startHour - EPS || s.end > endHour + EPS);
      if (fuera) return rechazar(`⛔ No cabe en el día (en ${nombreDia})`);
      for (let i = 0; i < slotsDia.length; i++) {
        for (let j = i + 1; j < slotsDia.length; j++) {
          if (overlaps(slotsDia[i], slotsDia[j])) return rechazar(`⛔ No cabe en el día (en ${nombreDia})`);
        }
      }
    }
  } else if (!keepPlace) {
    // ── MOVER sin día exacto: el arrastrado como PARED en todos sus días ──
    // (drag sin preview). Empuja en cadena — transitivo: un empujado que pisa
    // a otro se vuelve pared. ⛔ solo si una cadena desborda el rango o deja
    // solape (cadena no cabe) en algún día.
    const paredes = new Set<string>([actId]);
    const aCerrar = new Set<number>(daySet);
    for (const id of paredes) byId.get(id)?.daysOfWeek.forEach(d => aCerrar.add(d));
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let changed = false;
      for (const day of [...aCerrar].sort((a, b) => a - b)) {
        for (const id of paredes) {
          if (!isOnDay(byId.get(id)!, day)) continue;
          const w = times.get(id)!;
          const pared = { inicio: toMin(w.start), dur: Math.max(1, Math.round((w.end - w.start) * 60)) };
          const res = resolvePared(slotsOn(day).map(aM), id, pared);
          for (const sM of res) {
            const s = aHoras(sM);
            if (sameSlot(times.get(s.id)!, s)) continue;
            times.set(s.id, s);
            changed = true;
            paredes.add(s.id);
            byId.get(s.id)?.daysOfWeek.forEach(dd => {
              aCerrar.add(dd);
              daySet.add(dd);
            });
          }
        }
      }
      if (!changed) break;
    }
    for (const day of aCerrar) {
      const nombreDia = DIAS_SEMANA[day] ?? `día ${day}`;
      const slotsDia = slotsOn(day);
      const fuera = slotsDia.find(s => s.start < startHour - EPS || s.end > endHour + EPS);
      if (fuera) return rechazar(`⛔ No cabe en el día (en ${nombreDia})`);
      for (let i = 0; i < slotsDia.length; i++) {
        for (let j = i + 1; j < slotsDia.length; j++) {
          if (overlaps(slotsDia[i], slotsDia[j])) return rechazar(`⛔ No cabe en el día (en ${nombreDia})`);
        }
      }
    }
  } else {
    // ── ESTIRAR: única excepción que empuja (pared en pinnedStart) ──
    // Encoger NUNCA se rechaza (libera espacio; puede ser la única vía para
    // arreglar un día desbordado): el candado de rango de abajo no aplica.
    const encogeRedim =
      Math.round(duration * 60) <
      Math.round((codec.parse(act.endTime) - codec.parse(act.startTime)) * 60);
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let changed = false;
      for (const day of [...daySet].sort((a, b) => a - b)) {
        const pared = { inicio: toMin(pinnedStart), dur: Math.max(0, Math.round(duration * 60)) };
        const res = ladoRedim === 'arriba'
          ? resolveParedArriba(slotsOn(day).map(aM), actId, pared)
          : resolvePared(slotsOn(day).map(aM), actId, pared);
        for (const sM of res) {
          const s = aHoras(sM);
          if (sameSlot(times.get(s.id)!, s)) continue;
          if (s.id !== actId && breaksElsewhere(s.id, s, day)) continue; // ex-C3: queda solape local
          times.set(s.id, s);
          changed = true;
          byId.get(s.id)?.daysOfWeek.forEach(d => daySet.add(d));
        }
      }
      if (!changed) break;
    }
    // Candado del límite: NINGÚN día puede quedar fuera de rango (sin
    // recorte) — salvo al ENCOGER, que siempre está permitido.
    if (!encogeRedim) {
      for (const day of daySet) {
        const fuera = slotsOn(day).some(s => s.start < startHour - EPS || s.end > endHour + EPS);
        if (fuera) return rechazar('⛔ No cabe en el día');
      }
    }
  }

  const byDay = new Map<number, Map<string, Slot>>();
  for (const day of daySet) {
    byDay.set(day, new Map(slotsOn(day).map(s => [s.id, s])));
  }
  return { byDay, times, valido: true, motivo: '' };
}

/**
 * Capacidad de ESTIRAR de un día (minutos): cuánto puede crecer el bloque
 * `movedId` hacia `lado` antes de TOpar con otro bloque o con el límite del
 * día — el hueco real del lado menos la duración total de los vecinos del
 * tramo que la cadena empujaría (piso 0). La vista acota el deseo del
 * puntero por esta cifra ANTES de resolver: así el estirar SIEMPRE topa
 * (con un bloque o con el borde) y jamás se rechaza (regla del usuario:
 * "debe permitir estirarlo libremente hasta topar con otro bloque o con
 * el final del día").
 */
export function capacidadResizeDay(
  slots: Slot[],
  movedId: string,
  lado: 'arriba' | 'abajo',
  startHour = 0,
  endHour = 24
): number {
  const minM = toMin(startHour);
  const maxM = toMin(endHour);
  const N = slots.map(aM).sort(porInicio);
  const i = N.findIndex(x => x.id === movedId);
  if (i === -1) return 0;
  const b = N[i];
  if (lado === 'abajo') {
    return Math.max(0, maxM - finDe(b) - N.slice(i + 1).reduce((s, x) => s + x.dur, 0));
  }
  return Math.max(0, b.inicio - minM - N.slice(0, i).reduce((s, x) => s + x.dur, 0));
}

/**
 * Capacidad de estirar GLOBAL (minutos) para el resize semanal: la MÍNIMA
 * entre todos los días de la actividad (la duración es global — al estirar,
 * la pared empuja en cadena en cada día). Acotando el deseo del puntero por
 * esta cifra, el commit jamás desborda ningún día → el estirar SIEMPRE
 * topa, nunca se rechaza con ⛔.
 */
export function capacidadResizeWeekly(
  activities: Activity[],
  actId: string,
  lado: 'arriba' | 'abajo',
  codec: TimeCodec,
  startHour = 0,
  endHour = 24
): number {
  const act = activities.find(a => a.id === actId);
  if (!act) return 0;
  const dias = act.daysOfWeek.length ? act.daysOfWeek : [0];
  let min = Infinity;
  for (const d of dias) {
    const daySlots = activities
      .filter(a => a.daysOfWeek.includes(d))
      .map(a => ({ id: a.id!, start: codec.parse(a.startTime), end: codec.parse(a.endTime) }));
    min = Math.min(min, capacidadResizeDay(daySlots, actId, lado, startHour, endHour));
  }
  return min;
}

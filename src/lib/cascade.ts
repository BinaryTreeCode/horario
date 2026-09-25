/**
 * Resolución de colisiones del drag & drop — semántica "hueco libre"
 * (infografía: 1 mover a hueco → se coloca; 2 no cabe/encima → ⛔ vuelve;
 * 3 estirar usa el hueco y empuja vecinos; 4 límite del día = no crece).
 *
 * Un solo dueño: cuando cambia la matemática, cambia en ambos lados.
 * Pura y testeada (cascade.test.ts). Todo en MINUTOS ENTEROS desde la
 * medianoche (blindaje anti-flotantes); las vistas convierten HH:mm ↔ min.
 *
 *  - MOVER: el punto de suelta no puede caer dentro de otro bloque (⛔).
 *    Si cae en un hueco, el bloque se coloca dentro del hueco con snap,
 *    nunca pisando a los vecinos. Si el hueco es más chico que el bloque,
 *    el gesto es inválido (el fantasma se pinta igual, en rojo, y al soltar
 *    el bloque vuelve a su sitio).
 *  - ESTIRAR: el nuevo borde se acota por el hueco libre real (la suma de
 *    duraciones de los vecinos del lado, no sus posiciones) y lo que avanza
 *    empuja en cadena a los vecinos preservando sus duraciones.
 *  - LÍMITE: nada sale de [minDia, maxDia]; si no hay espacio libre, no crece.
 */
export interface Bloque {
  id: string;
  /** Minutos desde medianoche. */
  inicio: number;
  /** Duración en minutos (> 0). */
  duracion: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const finDe = (b: Bloque) => b.inicio + b.duracion;
export const snapMin = (m: number, snap: number) => Math.round(m / snap) * snap;

export interface PlanMover {
  /** Bloques finales del día destino (incluye el movido). */
  destino: Bloque[];
  /** Bloques finales del día origen (= destino si mismoDia). */
  origen: Bloque[];
  /** Posición propuesta del arrastrado (pinta el fantasma aunque sea inválido). */
  bb: Bloque;
  valido: boolean;
  /** '' si válido; si no, el motivo para el usuario. */
  motivo: string;
  /** La vista lo rellena: día → bloques finales, para el preview. */
  cambios?: Record<number, Bloque[]>;
}

/**
 * Plan de MOVER: `minuto` es el punto de suelta (del dedo) y `offsetMin`
 * el agarre relativo del bloque. `origen`/`destino` vienen SIN el arrastrado
 * ya removido... salvo `mismoDia`, donde `origen` sí lo incluye (se filtra
 * acá) y es el mismo array que `destino`.
 */
export function planMover(
  origen: Bloque[],
  destino: Bloque[],
  mismoDia: boolean,
  id: string,
  bloque: Bloque,
  minuto: number,
  offsetMin: number,
  minDia: number,
  maxDia: number,
  snap: number
): PlanMover {
  // En cross-day la actividad puede YA vivir en el día destino: su propia
  // instancia actual se filtra para que no se choque consigo misma.
  const otros = (mismoDia ? origen : destino).filter(x => x.id !== id);

  // El punto de suelta cae DENTRO de otro bloque → prohibido (regla 2).
  const encima = otros.some(o => minuto >= o.inicio && minuto < finDe(o));
  // Hueco libre alrededor del punto de suelta.
  const ini = Math.max(minDia, ...otros.filter(o => finDe(o) <= minuto).map(finDe));
  const fn = Math.min(maxDia, ...otros.filter(o => o.inicio > minuto).map(o => o.inicio));
  const cabe = !encima && fn - ini >= bloque.duracion;

  const deseado = snapMin(minuto - offsetMin, snap);
  const bb: Bloque = {
    id,
    inicio: cabe
      ? clamp(deseado, ini, fn - bloque.duracion)
      : clamp(deseado, minDia, maxDia - bloque.duracion), // ghost rojo: posición visual libre
    duracion: bloque.duracion
  };

  const nuevoDestino = [...otros, bb].sort((a, b) => a.inicio - b.inicio);
  const nuevoOrigen = mismoDia
    ? nuevoDestino
    : origen.filter(x => x.id !== id).sort((a, b) => a.inicio - b.inicio);

  return {
    destino: nuevoDestino,
    origen: nuevoOrigen,
    bb,
    valido: cabe,
    motivo: encima ? '⛔ Encima de otro bloque' : cabe ? '' : '⛔ No cabe en este hueco'
  };
}

export interface PlanResize {
  /** Día completo con el estirado y sus vecinos empujados. */
  bloques: Bloque[];
  bb: Bloque;
  /** La vista lo rellena: día → bloques finales, para el preview. */
  cambios?: Record<number, Bloque[]>;
}

/**
 * Plan de ESTIRAR (regla 3+4): crece/recoge hasta el hueco libre real —
 * la suma de duraciones de los vecinos del lado, no sus posiciones — y
 * empuja en cadena a quien pisa, preservando duraciones y sin salir del día.
 */
export function planResize(
  bloques: Bloque[],
  id: string,
  lado: 'arriba' | 'abajo',
  minuto: number,
  minDia: number,
  maxDia: number,
  snap: number
): PlanResize {
  // La cadena de empuje asume vecinos ORDENADOS por inicio: con el orden de
  // la BD (arbitrario) empujaría bloques equivocados y dejaría solapes.
  const N = bloques.map(b => ({ ...b })).sort((a, b) => a.inicio - b.inicio);
  const i = N.findIndex(x => x.id === id);
  if (i === -1) return { bloques: N, bb: { id, inicio: minDia, duracion: 0 } };
  const b = N[i];

  if (lado === 'abajo') {
    const libre = maxDia - finDe(b) - N.slice(i + 1).reduce((s, x) => s + x.duracion, 0);
    const E = clamp(snapMin(minuto, snap), b.inicio + snap, finDe(b) + Math.max(0, libre));
    b.duracion = E - b.inicio;
    let cursor = finDe(b);
    for (let k = i + 1; k < N.length; k++) {
      if (N[k].inicio < cursor) N[k].inicio = Math.min(cursor, maxDia - N[k].duracion);
      cursor = Math.max(cursor, finDe(N[k]));
    }
  } else {
    const libre = b.inicio - minDia - N.slice(0, i).reduce((s, x) => s + x.duracion, 0);
    const F = finDe(b);
    const S = clamp(snapMin(minuto, snap), b.inicio - Math.max(0, libre), F - snap);
    b.inicio = S;
    b.duracion = F - S;
    let cursor = S;
    for (let k = i - 1; k >= 0; k--) {
      if (finDe(N[k]) > cursor) N[k].inicio = Math.max(cursor - N[k].duracion, minDia);
      cursor = Math.min(cursor, N[k].inicio);
    }
  }
  return { bloques: N.sort((x, y) => x.inicio - y.inicio), bb: b };
}

/**
 * ex-C3: ¿el nuevo horario del bloque `id` pisaría a alguien en OTRO día
 * donde también vive? `otrosDias` son los bloques completos de esos días.
 * Evita la corrupción silenciosa al editar la plantilla de una actividad
 * multi-día: lo válido en el día visible puede chocar en otro.
 */
export function chocaEnOtrosDias(cambios: Bloque[], id: string, otrosDias: Bloque[][]): boolean {
  const movidos = cambios.filter(b => b.id === id);
  if (movidos.length === 0) return false;
  return otrosDias.some(dia =>
    movidos.some(m =>
      dia.some(o => o.id !== id && m.inicio < finDe(o) && o.inicio < finDe(m))
    )
  );
}

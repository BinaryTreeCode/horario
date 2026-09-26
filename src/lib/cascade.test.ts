import { describe, test, expect } from 'bun:test';
import { resolveDayCascade, resolveResizeDay, resolveNudgeDay, propagateWeekly, capacidadResizeDay, capacidadResizeWeekly } from './cascade';
import type { Activity } from './types';

const codec = {
  parse: (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h + m / 60;
  },
  format: (h: number) => {
    const total = Math.round(h * 60);
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    return `${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
  }
};

const s = (id: string, start: number, end: number) => ({ id, start, end });

/** Mapa id → slot para aserciones legibles. */
const byId = (out: { id: string; start: number; end: number }[]) =>
  out.reduce((m, x) => m.set(x.id, x), new Map<string, { id: string; start: number; end: number }>());

describe('resolveDayCascade — hueco libre', () => {
  test('cae en el hueco y respeta sus límites aunque el dedo se pase', () => {
    // a 8-9.5, hueco 9.5-12, r 12-13. Deseado 11:40 (dedo 11:50 − agarre 10min)
    // → clampa al fin del hueco menos duración: 11:00. Nadie se mueve.
    const slots = [s('a', 8, 9.5), s('r', 12, 13), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 11.6667, 12.6667), 11.8333, false, 7, 22);
    expect(p.valido).toBe(true);
    expect(p.accion).toBe('hueco');
    expect(p.motivo).toBe('');
    expect(p.movido.start).toBe(11);
    expect(p.movido.end).toBe(12);
    expect(byId(p.slots).get('a')).toEqual(s('a', 8, 9.5));
    expect(byId(p.slots).get('r')).toEqual(s('r', 12, 13));
  });

  test('hueco más chico que el bloque → INSERCIÓN CERCANA (nunca ⛔, F4)', () => {
    // a 8-10, hueco 10-10:45, r 10:45-12; bloque de 1h: NO cabe → el vecino
    // más próximo al dedo (10.5 → a dista 2.5h; r dista 0.25h) es r: mita
    // superior → x inserta ANTES de r (10:45): tramo compacto r 11:45-13.
    const slots = [s('a', 8, 10), s('r', 10.75, 12), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 10.5, 11.5), 10.5, false, 7, 22);
    expect(p.valido).toBe(true);
    expect(p.accion).toBe('insertar');
    expect(p.movido).toEqual(s('x', 10.75, 11.75));
    expect(byId(p.slots).get('r')).toEqual(s('r', 11.75, 13));
    expect(byId(p.slots).get('a')).toEqual(s('a', 8, 10));
  });

  test('hueco que ajusta exacto: el bloque se clampa dentro del hueco', () => {
    // Hueco 7:00-8:00 (60 min) y bloque de 60 min: solo cabe pegado a 7:00,
    // aunque el dedo pida 7:30 (el clamp del hueco manda, no el snap).
    const slots = [s('a', 8, 9), s('x', 12, 13)];
    const p = resolveDayCascade(slots, s('x', 7.5, 8.5), 7.2, false, 7, 22);
    expect(p.valido).toBe(true);
    expect(p.movido.start).toBe(7);
    expect(p.movido.end).toBe(8);
  });

  test('F4: inserción cercana con finger en el borde superior del hueco chico (vecino = pisado de arriba)', () => {
    // a 8-10, hueco 10-10:45, r 10:45-12; dedo en 10.1 → vecino más próximo
    // es a (su fin 10 dista 0.1): mitad inferior (dedo tras su fin) → x
    // inserta DESPUÉS de a (10): x 10-11 y r empujado conservando duración
    // (11-12.25 — el empuje absorbe huecos, no encoge a nadie).
    const slots = [s('a', 8, 10), s('r', 10.75, 12), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 10.5, 11.5), 10.1, false, 7, 22);
    expect(p.valido).toBe(true);
    expect(p.movido).toEqual(s('x', 10, 11));
    expect(byId(p.slots).get('r')).toEqual(s('r', 11, 12.25));
    expect(byId(p.slots).get('a')).toEqual(s('a', 8, 10));
  });

  test('F4: entre columnas, hueco chico → inserción cercana (vecino más próximo)', () => {
    // Destino: b 8-9, hueco 9-9:30, r 9:30-11; x (1h) cae en 9:10 → no cabe
    // en el hueco → vecino más próximo es b (su fin 9 dista 0.10; r dista
    // 0.33) → x inserta DESPUÉS de b: x 9-10 y r empujado (10-11.5).
    const slots = [s('b', 8, 9), s('r', 9.5, 11)];
    const p = resolveDayCascade(slots, s('x', 9.1667, 10.1667), 9.1667, true, 7, 22);
    expect(p.valido).toBe(true);
    expect(p.movido).toEqual(s('x', 9, 10));
    expect(byId(p.slots).get('b')).toEqual(s('b', 8, 9));
    expect(byId(p.slots).get('r')).toEqual(s('r', 10, 11.5));
  });
});

describe('resolveDayCascade — mitades: insertar ANTES/DESPUÉS (adelantamiento)', () => {
  test('dedo en la mitad SUPERIOR del pisado → inserta ANTES (tramo compactado)', () => {
    // x (15-16, al final del día) suelta con el dedo a las 8.2 (mitad superior
    // de b 8-9) → x ADELANTA al tope y el tramo queda COMPACTO: x 8-9,
    // b 9-10, r 10-11; el hueco liberado (11-16) queda al final.
    const slots = [s('b', 8, 9), s('r', 9, 10), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 15, 16), 8.2, false, 7, 22);
    expect(p.valido).toBe(true);
    expect(p.accion).toBe('insertar');
    expect(byId(p.slots).get('x')).toEqual(s('x', 8, 9));
    expect(byId(p.slots).get('b')).toEqual(s('b', 9, 10));
    expect(byId(p.slots).get('r')).toEqual(s('r', 10, 11));
  });

  test('dedo en la mitad INFERIOR del pisado → inserta DESPUÉS (retroceso compacto)', () => {
    // x (8-9, primero del día) suelta con dedo 11.8 (mitad inferior de r
    // 11-12) → x retrocede al final del tramo COMPACTADO: b 8-9, r 9-10 y
    // x 10-11 — el hueco 10-11 se CIERRA y el liberado (11-12) queda al final.
    const slots = [s('x', 8, 9), s('b', 9, 10), s('r', 11, 12)];
    const p = resolveDayCascade(slots, s('x', 8, 9), 11.8, false, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('b')).toEqual(s('b', 8, 9));
    expect(m.get('r')).toEqual(s('r', 9, 10));
    expect(m.get('x')).toEqual(s('x', 10, 11));
  });

  test('SIN REEMPLAZOS: el día conserva exactamente los mismos ids', () => {
    const slots = [s('a', 8, 9), s('b', 9, 10), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 8.5, 9.5), 8.1, false, 7, 22);
    const ids = p.slots.map(x => x.id).sort();
    expect(ids).toEqual(['a', 'b', 'x']);
  });

  test('adelantamiento en el medio: el tramo se compacta y lo externo queda intacto', () => {
    // Orden: a 7-8, b 8-9, c 9-10, hueco 10-12, d 12-13. x=c suelta sobre b
    // (dedo 8.2, mitad superior) → orden a, c, b, d: c 8-9, b 9-10 y d
    // INTACTO (fuera del tramo) — el hueco liberado 10-13 queda entre b y d.
    const slots = [s('a', 7, 8), s('b', 8, 9), s('c', 9, 10), s('d', 12, 13)];
    const p = resolveDayCascade(slots, s('c', 9, 10), 8.2, false, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('a')).toEqual(s('a', 7, 8));
    expect(m.get('c')).toEqual(s('c', 8, 9));
    expect(m.get('b')).toEqual(s('b', 9, 10));
    expect(m.get('d')).toEqual(s('d', 12, 13)); // fuera del tramo: intacto
  });

  test('retroceso al fondo: la pila entera avanza un puesto (rotación completa)', () => {
    // x 7-8, b 8-9, c 9-10. x suelta sobre mitad inferior de c (9.8) →
    // orden b, c, x: b toma el 7-8 de x, c el 8-9 de b y x el 9-10 de c —
    // cada bloque del tramo avanza un puesto conservando su duración.
    const slots = [s('x', 7, 8), s('b', 8, 9), s('c', 9, 10)];
    const p = resolveDayCascade(slots, s('x', 7, 8), 9.8, false, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('b')).toEqual(s('b', 7, 8));
    expect(m.get('c')).toEqual(s('c', 8, 9));
    expect(m.get('x')).toEqual(s('x', 9, 10));
  });

  test('insertar ANTES con hueco intermedio: la compactación cierra el hueco del tramo', () => {
    // a 11-12, r 12-13, LIBRE 13-15, x 15-16. x suelta mitad superior de r
    // (12.2) → orden a, x, r: el tramo (x, r) se compacta desde 12 → x 12-13,
    // r 13-14; a intacto y el hueco liberado (14-16) al final. La compactación
    // nunca extiende el span → nada desborda el día.
    const slots = [s('a', 11, 12), s('r', 12, 13), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 15, 16), 12.2, false, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('a')).toEqual(s('a', 11, 12));
    expect(m.get('x')).toEqual(s('x', 12, 13));
    expect(m.get('r')).toEqual(s('r', 13, 14));
  });

  test('la compactación NUNCA desborda el día: solo contrae el span', () => {
    // x (15-16) inserta ANTES de r (7-8, al límite del día): el tramo se
    // compacta desde 7 → x 7-8, r 8-9 (span encogido, jamás extendido).
    const slots = [s('r', 7, 8), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 15, 16), 7.2, false, 7, 22);
    expect(p.valido).toBe(true);
    expect(byId(p.slots).get('x')).toEqual(s('x', 7, 8));
    expect(byId(p.slots).get('r')).toEqual(s('r', 8, 9));
  });
});

describe('resolveDayCascade — entre columnas (crossInto)', () => {
  test('mitad superior: ancla al inicio del pisado y empuja la cadena abajo', () => {
    // Destino: b 8-9, r 9-10. Llega x (1h) con dedo 8.2 → x 8-9 pegado,
    // b empujado 9-10, r 10-11.
    const slots = [s('b', 8, 9), s('r', 9, 10)];
    const p = resolveDayCascade(slots, s('x', 8, 9), 8.2, true, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('x')).toEqual(s('x', 8, 9));
    expect(m.get('b')).toEqual(s('b', 9, 10));
    expect(m.get('r')).toEqual(s('r', 10, 11));
  });

  test('mitad inferior: ancla al fin del pisado y el resto queda CONTIGUO (compactado)', () => {
    // Destino: b 8-9, r 9-10, hueco 10-12, d 12-13. x (1h) dedo 9.8 →
    // x 10-11 y d se compacta pegado: 11-12 (el hueco se cierra).
    const slots = [s('b', 8, 9), s('r', 9, 10), s('d', 12, 13)];
    const p = resolveDayCascade(slots, s('x', 10, 11), 9.8, true, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('x')).toEqual(s('x', 10, 11));
    expect(m.get('d')).toEqual(s('d', 11, 12));
  });

  test('cadena que desborda el día → inválido (⛔)', () => {
    // Destino: b 8-9, r 9-10, d 10-11 y el día termina 11:30. x (1h) dedo
    // 8.2 → x 8-9, b 9-10, r 10-11, d empujado 11-12 → d desborda → ⛔.
    const slots = [s('b', 8, 9), s('r', 9, 10), s('d', 10, 11)];
    const p = resolveDayCascade(slots, s('x', 11, 12), 8.2, true, 7, 11.5);
    expect(p.valido).toBe(false);
    expect(p.motivo).toBe('⛔ No cabe en el día');
  });
});

describe('resolveResizeDay — estirar', () => {
  test('estirar hacia abajo empuja la cadena preservando duraciones', () => {
    // e 9-10, r 13-14, c 14-15. Dedo 13:30 → e 9-13:30, r 13:30-14:30, c 14:30-15:30.
    const slots = [s('e', 9, 10), s('r', 13, 14), s('c', 14, 15)];
    const p = resolveResizeDay(slots, 'e', 'abajo', 13.5, 7, 22);
    const m = byId(p.slots);
    expect(m.get('e')).toEqual(s('e', 9, 13.5));
    expect(m.get('r')).toEqual(s('r', 13.5, 14.5));
    expect(m.get('c')).toEqual(s('c', 14.5, 15.5));
  });

  test('el tope es el hueco libre REAL (suma de duraciones), no las posiciones', () => {
    // Día 16-22: c 20-21, l 21-22. Dedo 23:00 → c no crece más allá de 21
    // (libre = 22-21-60 = 0): los vecinos empujados no salen del día.
    const slots = [s('c', 20, 21), s('l', 21, 22)];
    const p = resolveResizeDay(slots, 'c', 'abajo', 23, 16, 22);
    const m = byId(p.slots);
    expect(m.get('c')).toEqual(s('c', 20, 21));
    expect(m.get('l')).toEqual(s('l', 21, 22));
    expect(p.valido).toBe(true);
  });

  test('estirar hacia arriba: fin fijo, crece hasta el límite del día y empuja arriba', () => {
    // t 8-9.5, e 10-11. Dedo 8:30 → e 8:30-11 (150min) y t 7-8:30.
    const slots = [s('t', 8, 9.5), s('e', 10, 11)];
    const p = resolveResizeDay(slots, 'e', 'arriba', 8.5, 7, 22);
    const m = byId(p.slots);
    expect(m.get('e')).toEqual(s('e', 8.5, 11));
    expect(m.get('t')).toEqual(s('t', 7, 8.5));
  });

  test('estirar hacia arriba con límite del día: el fin queda fijo', () => {
    const slots = [s('x', 8, 9)];
    const p = resolveResizeDay(slots, 'x', 'arriba', 0, 6, 24);
    expect(p.valido).toBe(true);
    expect(p.slots[0].start).toBe(6);
    expect(p.slots[0].end).toBe(9);
  });

  test('entrada desordenada: la cadena empuja por posición, no por orden de BD', () => {
    const slots = [s('c', 14, 15), s('e', 9, 10), s('r', 13, 14)];
    const p = resolveResizeDay(slots, 'e', 'abajo', 14.5, 7, 22);
    const m = byId(p.slots);
    expect(m.get('e')).toEqual(s('e', 9, 14.5));
    expect(m.get('r')).toEqual(s('r', 14.5, 15.5));
    expect(m.get('c')).toEqual(s('c', 15.5, 16.5));
  });
});

describe('resolveNudgeDay — teclado ±15 min', () => {
  test('ancla como pared y empuja en cadena lo que pisa (y lo que el empuje alcanza)', () => {
    // a 8-9, b 9-10, x 12-13. Nudge x a 8:30 → x 8:30-9:30 pisa a a →
    // a 9:30-10:30, y la cadena arrastra a b → 10:30-11:30.
    const slots = [s('a', 8, 9), s('b', 9, 10), s('x', 12, 13)];
    const p = resolveNudgeDay(slots, 'x', 8.5, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('x')).toEqual(s('x', 8.5, 9.5));
    expect(m.get('a')).toEqual(s('a', 9.5, 10.5));
    expect(m.get('b')).toEqual(s('b', 10.5, 11.5));
  });

  test('nudge a hueco libre no mueve a nadie', () => {
    const slots = [s('a', 8, 9), s('x', 12, 13)];
    const p = resolveNudgeDay(slots, 'x', 10, 7, 22);
    const m = byId(p.slots);
    expect(m.get('a')).toEqual(s('a', 8, 9));
    expect(m.get('x')).toEqual(s('x', 10, 11));
  });
});

describe('propagateWeekly — cierre transitivo', () => {
  const act = (id: string, start: string, end: string, days: number[]): Activity => ({
    id, name: id, categoryId: 'c', startTime: start, endTime: end, daysOfWeek: days,
    updatedAt: 0
  });

  test('el día del drop se siembra EXACTO (lo que se vio es lo que se guarda)', () => {
    const acts = [
      act('desa', '07:00', '08:00', [0]),
      act('x', '09:00', '10:00', [0, 2]),
      act('otro', '09:00', '10:00', [2])
    ];
    const res = propagateWeekly(
      acts, 'x', 8, 22, codec, [0, 2], undefined, 0, false,
      { day: 0, slots: [s('desa', 7, 8), s('x', 8, 9)] }
    );
    expect(res.times.get('x')!.start).toBe(8);
    expect(res.times.get('desa')!.start).toBe(7);
    // Martes: x anclado como pared en 8 → 'otro' empujado 9-10.
    expect(res.times.get('otro')!.start).toBe(9);
  });

  test('sin día destino: la pared ancla en pinnedStart en todos los días', () => {
    const acts = [
      act('x', '09:00', '10:00', [0, 1]),
      act('z', '09:00', '10:00', [1])
    ];
    const res = propagateWeekly(acts, 'x', 8, 22, codec, [0, 1]);
    expect(res.times.get('x')!.start).toBe(8);
    // Lunes: x pared 8-9. Martes: z pisa la pared → empujado 9-10.
    expect(res.times.get('z')!.start).toBe(9);
  });

  test('choque en otro día → EMPUJE EN CADENA (semántica demo, sin rechazo)', () => {
    // n vive lunes y martes (9-10); w martes 9-10; m lunes 8-9 se mueve a
    // 8:30 → el preview adelanta a n (9:30-10:30). n actúa como PARED: el
    // martes empuja a w a 10-11 (sin rechazo — el choque se CIERRA).
    const acts = [
      act('m', '08:00', '09:00', [0]),
      act('n', '09:00', '10:00', [0, 1]),
      act('w', '09:00', '10:00', [1])
    ];
    const res = propagateWeekly(acts, 'm', 8.5, 22, codec, [0], undefined, 0, false, {
      day: 0,
      slots: [s('m', 8.5, 9.5), s('n', 9.5, 10.5)]
    });
    expect(res.valido).toBe(true);
    expect(res.times.get('n')!.start).toBe(9.5);
    // Martes: n (pared 9.5-10.5) empuja a w → 10.5-11.5.
    expect(res.times.get('w')!.start).toBe(10.5);
  });

  test('cadena multi-día que desborda el rango de un día → rechazo con nombre del día', () => {
    // Día 7-22. n vive lunes y martes (9-10); martes además p 10-21 y q
    // 21-22 (día lleno hasta el borde). m lunes 8-9 se mueve a 8:30 → n
    // adelanta a 9:30-10:30 y su pared martes empuja p → q → 21:30-22:30:
    // desborda el límite (22) → ⛔ con el nombre del día.
    const acts = [
      act('m', '08:00', '09:00', [0]),
      act('n', '09:00', '10:00', [0, 1]),
      act('p', '10:00', '21:00', [1]),
      act('q', '21:00', '22:00', [1])
    ];
    const res = propagateWeekly(acts, 'm', 8.5, 22, codec, [0], undefined, 7, false, {
      day: 0,
      slots: [s('m', 8.5, 9.5), s('n', 9.5, 10.5)]
    });
    expect(res.valido).toBe(false);
    expect(res.motivo).toContain('Martes');
    expect(res.times.size).toBe(0);
  });

  test('resize multi-día: la pared conserva el inicio y usa la nueva duración', () => {
    const acts = [
      act('x', '09:00', '10:00', [0, 1]),
      act('z', '10:00', '11:00', [1])
    ];
    const res = propagateWeekly(acts, 'x', 9, 22, codec, [0, 1], 2, 0, true);
    expect(res.times.get('x')).toEqual(s('x', 9, 11));
    expect(res.times.get('z')!.start).toBe(11);
  });

  test('resize hacia ARRIBA: lo pisado sube en cadena (no traspasa la pared)', () => {
    // x 9-12 (pared anclada por su FIN en 12); w 10-11 pisa → sube a 8-9.
    const acts = [
      act('x', '09:00', '10:00', [1]),
      act('w', '10:00', '11:00', [1])
    ];
    const res = propagateWeekly(acts, 'x', 9, 22, codec, [1], 3, 0, true, undefined, 'arriba');
    expect(res.valido).toBe(true);
    expect(res.times.get('x')).toEqual(s('x', 9, 12));
    // w conservó su 1h y quedó CONTIGUO arriba de la pared: nunca 10-11 pisando.
    expect(res.times.get('w')).toEqual(s('w', 8, 9));
  });

  test('resize hacia ARRIBA: si la cadena sube del inicio del día → rechazo completo', () => {
    // Día 7-23. x 7:30-9:30 estira arriba a 7-9:30 (2.5h): w 8-8:30 no tiene
    // lugar (necesitaría 6:30-7) → candado del límite: nada se escribe.
    const acts = [
      act('x', '07:30', '09:30', [1]),
      act('w', '08:00', '08:30', [1])
    ];
    const res = propagateWeekly(acts, 'x', 7, 23, codec, [1], 2.5, 7, true, undefined, 'arriba');
    expect(res.valido).toBe(false);
    expect(res.times.size).toBe(0);
  });

  test('ENCOGER siempre está permitido, incluso en un día ya desbordado (daily)', () => {
    // Día 7-23. La BD vino envenenada: x 22:45-23:15 cruza el límite. Encoger
    // a 22:45-23:00 (o menos) DEBE funcionar: libera espacio, no agranda nada.
    const slots = [s('x', 22.75, 23.25)];
    const res = resolveResizeDay(slots, 'x', 'abajo', 23, 7, 23);
    expect(res.valido).toBe(true);
    expect(res.movido).toEqual(s('x', 22.75, 23));
  });

  test('ENCOGER semanal siempre está permitido aunque otro día quede desbordado', () => {
    // Lunes OK (x 9-10 solo ahí encoge); Martes venía desbordado (z cruza 22).
    // El encogimiento de x no agranda el desborde de z → permitido.
    const acts = [
      act('x', '20:00', '22:00', [0, 1]),
      act('z', '22:00', '22:30', [1])
    ];
    const res = propagateWeekly(acts, 'x', 20, 23, codec, [0, 1], 1, 7, true, undefined, 'abajo');
    expect(res.valido).toBe(true);
    expect(res.times.get('x')).toEqual(s('x', 20, 21));
    // z (no tocado) conserva su horario cruzado — se arregla a mano.
    expect(res.times.get('z')).toEqual(s('z', 22, 22.5));
  });

  test('drag entre columnas: el preview compacta al pisado y el commit lo siembra exacto', () => {
    const acts = [
      act('x', '09:00', '10:00', [0]),
      act('k', '09:30', '10:30', [4])
    ];
    // Viernes: x llega 10-11 y k (pisado, compactado) queda contiguo 11-12.
    const res = propagateWeekly(acts, 'x', 10, 22, codec, [4], undefined, 0, false, {
      day: 4,
      slots: [s('x', 10, 11), s('k', 11, 12)]
    });
    expect(res.valido).toBe(true);
    expect(res.times.get('x')!.start).toBe(10);
    expect(res.times.get('k')).toEqual(s('k', 11, 12));
  });

  test('drag entre columnas sin preview: si el slot pisa en el destino → empuja en cadena', () => {
    const acts = [
      act('x', '09:00', '10:00', [0]),
      act('k', '09:30', '10:30', [4])
    ];
    // x anclado 10-11 pisa a k (9:30-10:30) en viernes → k empujado a 11-12.
    const res = propagateWeekly(acts, 'x', 10, 22, codec, [4]);
    expect(res.valido).toBe(true);
    expect(res.times.get('x')).toEqual(s('x', 10, 11));
    expect(res.times.get('k')).toEqual(s('k', 11, 12));
  });
});

describe('capacidadResizeDay/Weekly — estirar SIEMPRE topa (nunca rechaza)', () => {
  const s = (id: string, start: number, end: number) => ({ id, start, end });
  const act = (id: string, start: string, end: string, days: number[]): Activity => ({
    id, name: id, categoryId: 'c', startTime: start, endTime: end, daysOfWeek: days,
    updatedAt: 0
  });
  test('capacidad = crecer empujando la cadena hasta el borde del día', () => {
    // e 9-10, r 13-14, día 7-22. La cadena corre a r (1h) hasta el borde:
    // e puede crecer 22h - 1h(r) - 10h = 660min → e 10-21, r 21-22.
    const slots = [s('e', 9, 10), s('r', 13, 14)];
    expect(capacidadResizeDay(slots, 'e', 'abajo', 7, 22)).toBe(660);
  });

  test('capacidad con dos vecinos: la suma de sus duraciones come el margen', () => {
    // e 9-10, r 13-14, c 14-15, día 7-16: 16h - 10h - 1h(r) - 1h(c) = 4h = 240min.
    const slots = [s('e', 9, 10), s('r', 13, 14), s('c', 14, 15)];
    expect(capacidadResizeDay(slots, 'e', 'abajo', 7, 16)).toBe(240);
  });

  test('capacidad hacia arriba: hueco libre + cadena hasta el inicio del día', () => {
    // r 9-10, e 13-14, día 7-22: e sube hasta 8:30 → 780-420-60 = 300min.
    const slots = [s('r', 9, 10), s('e', 13, 14)];
    expect(capacidadResizeDay(slots, 'e', 'arriba', 7, 22)).toBe(300);
  });

  test('capacidad 0 cuando la cadena ya llega al borde (día lleno)', () => {
    // Día 9-11 con e 9-10 y r 10-11: no hay margen → 0 en ambos lados.
    const slots = [s('e', 9, 10), s('r', 10, 11)];
    expect(capacidadResizeDay(slots, 'e', 'abajo', 9, 11)).toBe(0);
    expect(capacidadResizeDay(slots, 'r', 'arriba', 9, 11)).toBe(0);
  });

  test('capacidad semanal = MÍNIMO entre los días de la actividad', () => {
    // Lunes: e 9-10 con 1 vecino → 660. Martes: 2 vecinos (120min) → 600.
    // El estirar global se acota por el día más apretado → 600.
    const acts = [
      act('e', '09:00', '10:00', [0, 1]),
      act('r', '13:00', '14:00', [0]),
      act('w', '10:00', '11:00', [1]),
      act('v', '11:00', '12:00', [1])
    ];
    const cap = capacidadResizeWeekly(acts, 'e', 'abajo', codec, 7, 22);
    expect(cap).toBe(600);
  });

  test('estirar acotado por capacidad → resolveResizeDay siempre válido (sin ⛔)', () => {
    // Día 7-22, e 9-10, r 13-14, c 14-15: deseo 21h (más allá del tope de
    // 20h) → acotado a 9-20 (capacidad 600min) → válido, r/c corridos al borde.
    const slots = [s('e', 9, 10), s('r', 13, 14), s('c', 14, 15)];
    const cap = capacidadResizeDay(slots, 'e', 'abajo', 7, 22); // 600
    expect(cap).toBe(600);
    const tope = 10 + cap / 60; // 20
    const res = resolveResizeDay(slots, 'e', 'abajo', Math.min(21, tope), 7, 22);
    expect(res.valido).toBe(true);
    expect(res.movido).toEqual(s('e', 9, 20));
  });

  test('F4 limitadoPor: topa con un bloque (cadena), con el borde, o nada', () => {
    // Con vecino r (cadena 1h): deseo 21:30 topa con r (tope 21) → 'un bloque'.
    const slots = [s('e', 9, 10), s('r', 13, 14)];
    expect(resolveResizeDay(slots, 'e', 'abajo', 21.5, 7, 22).limitadoPor).toBe('un bloque');
    // Sin vecinos debajo y deseo más allá del fin del día → 'el fin del día'.
    expect(resolveResizeDay([s('e', 20, 21)], 'e', 'abajo', 23, 16, 22).limitadoPor).toBe('el fin del día');
    // Hacia arriba: sin vecinos y deseo antes del inicio del día → 'el inicio del día'.
    expect(resolveResizeDay([s('e', 7, 8)], 'e', 'arriba', 6, 7, 22).limitadoPor).toBe('el inicio del día');
    // Deseo dentro de la capacidad → nada limitó.
    expect(resolveResizeDay(slots, 'e', 'abajo', 12, 7, 22).limitadoPor).toBe('');
    // Encoger nunca reporta límite.
    expect(resolveResizeDay(slots, 'e', 'abajo', 9.5, 7, 22).limitadoPor).toBe('');
  });
});

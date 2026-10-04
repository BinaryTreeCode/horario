import { describe, test, expect } from 'bun:test';
import { resolveDayCascade, resolveResizeDay, resolveNudgeDay, propagateWeekly, capacidadResizeDay, capacidadResizeWeekly, barridoRetiro, barridoGanar, resolverGanarDias, resolverEstirarGlobal, horarioEfectivoDia, chocaHoras } from './cascade';
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
    expect(p.motivo).toBe('⛔ No cabe: el empuje desbordaría el día');
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

  test('día con bloque pre-fuera-de-rango: estirar que no lo empeora es válido', () => {
    // Caso real del usuario: Rutina 6:45-7:45 con inicio de día configurado a
    // las 7 → el día "venía desbordado" (Rutina fuera de rango). El candado
    // viejo (enRango del día COMPLETO) hacía que CUALQUIER estirar fuera ⛔
    // aunque el gesto no tocara a Rutina. Nuevo: solo rechaza si AGRANDA el
    // desborde (un bloque que estaba dentro queda fuera).
    // e 10-11 con hueco hasta 14 (r 13-14): estirar e a 12 empuja a r →
    // nadie nuevo sale del rango (7-14) → VÁLIDO aunque rutina siga fuera.
    const slots = [s('rutina', 6.75, 7.75), s('e', 10, 11), s('r', 13, 14)];
    const res = resolveResizeDay(slots, 'e', 'abajo', 12, 7, 14);
    expect(res.valido).toBe(true);
    expect(res.movido).toEqual(s('e', 10, 12));
    // Estirar MÁS allá del tope: la capacidad acota E al tope del día
    // (libre = maxM - fin - vecinos), así que r se apila contra el borde y
    // NADIE sale del rango — y el candado nuevo no castiga por la rutina
    // preexistente. El resultado es tope: e 10-13, r 13-14.
    const res2 = resolveResizeDay(slots, 'e', 'abajo', 15, 7, 14);
    expect(res2.valido).toBe(true);
    expect(res2.movido).toEqual(s('e', 10, 13));
    // Sin candado nuevo esto habría dado ⛔ por la rutina preexistente:
    const sinRutina = resolveResizeDay([s('e', 10, 11), s('r', 13, 14)], 'e', 'abajo', 12, 7, 14);
    expect(res.valido).toBe(sinRutina.valido); // misma suerte con o sin rutina fuera de rango
  });
});

describe('barridoRetiro — asa lateral: los días cruzados se eliminan', () => {
  // days de referencia: Lun(0)–Vie(4), como "trabajo" en la BD real.
  const LUN_VIE = [0, 1, 2, 3, 4];

  test('umbral de media columna (0 columnas cruzadas): gesto clásico — solo el día del asa', () => {
    // Asa del Domingo (6) hacia adentro (dirIn=-1): retira SOLO el Domingo.
    expect(barridoRetiro(LUN_VIE, 6, -1, 0)).toEqual([6]);
    // Asa del Lunes (0) hacia adentro (dirIn=+1): retira SOLO el Lunes.
    expect(barridoRetiro(LUN_VIE, 0, 1, 0)).toEqual([0]);
  });

  test('barrido de Domingo a Jueves: elimina Sábado y Viernes (el ejemplo del usuario)', () => {
    // days = Lun–Dom (el bloque completo), asa en Domingo (6), dirIn=-1,
    // 2 columnas completas cruzadas → Domingo (6, el día del asa), Sábado (5)
    // y Viernes (4) fuera; Jueves (3) queda como nuevo borde.
    //
    // El día del asa entra al barrido: el gesto es recortar la corrida DESDE
    // ahí. Antes se conservaba y la actividad quedaba huérfana en Domingo,
    // desconectada del Miércoles que quedaba al otro lado del hueco.
    const TODO_SEMANA = [0, 1, 2, 3, 4, 5, 6];
    expect(barridoRetiro(TODO_SEMANA, 6, -1, 2)).toEqual([6, 5, 4]);
  });

  test('el barrido retira el día del asa (regresión del reporte)', () => {
    // Caso reportado: Rutina de Miércoles a Domingo, asa en el borde derecho
    // del Domingo, el dedo cruza Sábado/Viernes/Jueves. Antes se retiraban
    // solo los tres cruzados y el Domingo sobrevivía solo.
    const RUTINA = [2, 3, 4, 5, 6];
    expect(barridoRetiro(RUTINA, 6, -1, 3)).toEqual([6, 5, 4, 3]);
    // Un solo día de barrido: se va el asa y el cruzado, ni más ni menos.
    expect(barridoRetiro(RUTINA, 6, -1, 1)).toEqual([6, 5]);
    // Y el gesto clásico (sin cruzar columnas) sigue siendo solo el asa.
    expect(barridoRetiro(RUTINA, 6, -1, 0)).toEqual([6]);
    // Cruzando los 4 días restantes el barrido cubre la corrida ENTERA: la
    // lista sale completa y la vista borra la actividad (no queda un bloque
    // sin días). Antes el día del asa se salvaba y el Miércoles sobrevivía
    // solo, huérfano.
    expect(barridoRetiro(RUTINA, 6, -1, 4)).toEqual([6, 5, 4, 3, 2]);
    // Al revés (asa en el Miércoles, la punta izquierda de la corrida) el asa
    // también entra: 3 columnas cruzadas se llevan Miércoles, Jueves, Viernes
    // y Sábado, y queda solo el Domingo.
    expect(barridoRetiro(RUTINA, 2, 1, 2)).toEqual([2, 3, 4]);
    expect(barridoRetiro(RUTINA, 2, 1, 3)).toEqual([2, 3, 4, 5]);
  });

  test('extremos exclusivos: el día bajo el dedo (columna incompleta) sobrevive', () => {
    // Asa en Viernes (4) de Lun–Vie, 2 columnas COMPLETAS hacia adentro
    // (dirIn=-1): el dedo cruzó Jueves(3) y Miércoles(2) y está DENTRO de
    // Martes (2.4 columnas en la vista → floor 2) → Martes sobrevive como
    // nuevo borde. El origen (Viernes) también cae: el gesto recorta desde ahí.
    expect(barridoRetiro(LUN_VIE, 4, -1, 2)).toEqual([4, 3, 2]);
    // Con 3 columnas COMPLETAS el dedo ya cruzó Martes entero: se retira
    // también (la vista pasa floor(|delta|/ancho), así que la columna bajo
    // el dedo solo sobrevive cuando el dedo está dentro de ella).
    expect(barridoRetiro(LUN_VIE, 4, -1, 3)).toEqual([4, 3, 2, 1]);
  });

  test('solo se retiran días que la actividad tiene (corrida con hueco)', () => {
    // Baño real: Lun(0), Mié(2), Vie(4). Asa del Viernes hacia adentro 3
    // columnas cruza Jueves(4-1*? no lo tiene), Miércoles(2, sí), Martes(1,
    // no lo tiene) → se retiran los que tiene: el asa (Vie) y Miércoles;
    // queda solo el Lunes.
    expect(barridoRetiro([0, 2, 4], 4, -1, 3)).toEqual([4, 2]);
  });

  test('corrida rota sin cruces válidos: cae al gesto clásico (día del asa)', () => {
    // Días Lun(0) y Vie(4): asa del Lunes, 2 columnas hacia adentro cruzan
    // Martes(1) y Miércoles(2) — no tiene ninguno → gesto clásico [0].
    expect(barridoRetiro([0, 4], 0, 1, 2)).toEqual([0]);
  });

  test('el barrido completo devuelve TODOS los días (la vista borra la actividad)', () => {
    // El reporte: "elimino de lunes a domingo pero lunes no se borra". La
    // función se obligaba a salvar el día del asa para no dejar el bloque sin
    // días, así que esa fila sobrevivía siempre. Ahora devuelve la corrida
    // entera y quien escribe (la vista) elimina la actividad.
    expect(barridoRetiro([0, 1], 0, 1, 5)).toEqual([0, 1]);
    expect(barridoRetiro(LUN_VIE, 0, 1, 99)).toEqual([0, 1, 2, 3, 4]);
    const SEMANA = [0, 1, 2, 3, 4, 5, 6];
    expect(barridoRetiro(SEMANA, 0, 1, 6)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Un barrido PARCIAL conserva el "no salta huecos": el dedo corto solo retira
    // el día del asa; el largo retira también los días que la actividad tiene.
    expect(barridoRetiro([0, 2, 4], 0, 1, 1)).toEqual([0]);
    expect(barridoRetiro([0, 2, 4], 0, 1, 2)).toEqual([0, 2]);
  });

  test('actividad de un solo día: sin gesto (no se ofrece retirar)', () => {
    expect(barridoRetiro([3], 3, -1, 0)).toEqual([]);
    expect(barridoRetiro([3], 3, -1, 4)).toEqual([]);
  });

  test('columnas negativas o fuera del arreglo se tratan como gesto clásico y se frenan en el borde', () => {
    // Columnas negativas (no debería pasar, defensivo): gesto clásico.
    expect(barridoRetiro(LUN_VIE, 2, -1, -3)).toEqual([2]);
    // Barrido que desborda el arreglo: asa del Sábado (5) de Lun–Vie con
    // dirIn=+1 solo cruza Domingo (6), que no está en days → sin cruces
    // válidos → cae al gesto clásico (retirar el Sábado, el día del asa).
    expect(barridoRetiro(LUN_VIE, 5, 1, 4)).toEqual([5]);
  });
});

describe('barridoGanar — asa lateral: la tira de días ganados (el caso reportado)', () => {
  // El reporte: "quiero estirar toda la semana pero solo me sirve hasta el
  // martes". El barrido de retiro cruzaba días; el de ganancia se quedaba en el
  // vecino inmediato, así que había que repetir el gesto día por día.
  //
  // Los fixtures usan bloques con la CORRIDA TERMINADA en el asa (solo Lunes, o
  // Lun–Mié): es la única situación en la que el asa hacia afuera existe (si el
  // vecino ya lo tiene, no hay qué ganar).
  const LUN = [0];
  const MIER = [2];

  test('umbral de media columna (0 columnas): gesto clásico — un solo día', () => {
    expect(barridoGanar(LUN, 0, 1, 0)).toEqual([1]);      // Lunes → Martes
    expect(barridoGanar([6], 6, -1, 0)).toEqual([5]);     // Domingo → Sábado
    expect(barridoGanar(LUN, 0, -1, 0)).toEqual([]);       // sin día previo: nada
  });

  test('el barrido gana el vecino MÁS cada columna COMPLETA que cruza el dedo', () => {
    // Bloque solo el Miércoles, asa a la derecha, 2 columnas completas: el
    // dedo cruzó Jueves(3) y Viernes(4) entero → se ganan Jueves, Viernes y
    // Sábado (el día bajo el dedo entra).
    expect(barridoGanar(MIER, 2, 1, 2)).toEqual([3, 4, 5]);
    // Una sola columna: vecino + 1.
    expect(barridoGanar(MIER, 2, 1, 1)).toEqual([3, 4]);
    // Hacia la izquierda: Lunes (1) y el barrido frena en 0. No "da la vuelta"
    // al Domingo: la semana es una tira, no un círculo.
    expect(barridoGanar(MIER, 2, -1, 2)).toEqual([1, 0]);
    expect(barridoGanar(MIER, 2, -1, 3)).toEqual([1, 0]);
  });

  test('ganar toda la semana desde el borde (el gesto pedido)', () => {
    // Bloque solo el Lunes, asa a la derecha: 4 columnas completas (el dedo
    // está DENTRO del Sábado) → Martes a Sábado.
    expect(barridoGanar(LUN, 0, 1, 4)).toEqual([1, 2, 3, 4, 5]);
    // 5 columnas: el dedo cruzó el Sábado entero y entra también el Domingo.
    expect(barridoGanar(LUN, 0, 1, 5)).toEqual([1, 2, 3, 4, 5, 6]);
    // Y al revés, desde el Domingo hasta el Lunes.
    expect(barridoGanar([6], 6, -1, 4)).toEqual([5, 4, 3, 2, 1]);
    expect(barridoGanar([6], 6, -1, 5)).toEqual([5, 4, 3, 2, 1, 0]);
  });

  test('la tira salta los días que ya tiene y sigue (el reporte)', () => {
    // Bloque en Lun(0), Mié(2) y Vie(4): asa del Lunes, el dedo cruza Martes(1),
    // Miércoles(2), Jueves(3) y Viernes(4). Los que ya tiene se SALTAN y el
    // dedo sigue; antes el barrido se cortaba en el Miércoles y estirar la
    // corrida al resto de la semana era imposible.
    expect(barridoGanar([0, 2, 4], 0, 1, 3)).toEqual([1, 3]);
    expect(barridoGanar([0, 2, 4], 0, 1, 4)).toEqual([1, 3, 5]);
    // El caso reportado: "Rutina" en Lunes y Jueves, asa del Lunes hasta el
    // borde del Domingo → gana todo menos el Jueves, que ya la tenía.
    expect(barridoGanar([0, 4], 0, 1, 6)).toEqual([1, 2, 3, 5, 6]);
    // Y al revés, desde el Jueves hacia la izquierda.
    expect(barridoGanar([4, 0], 4, -1, 4)).toEqual([3, 2, 1]);
    // Corrida Lun–Mié con el asa en el Miércoles: gana hasta el Domingo (igual
    // que antes: en esa tira no hay ningún día repetido).
    expect(barridoGanar([0, 1, 2], 2, 1, 3)).toEqual([3, 4, 5, 6]);
    // Si TODA la tira ya la tiene, no hay gesto (mismo contrato que antes).
    expect(barridoGanar([1, 2, 3, 4], 1, 1, 2)).toEqual([]);
  });

  test('bordes de la semana y columnas negativas (defensivo)', () => {
    expect(barridoGanar(LUN, 0, -1, 3)).toEqual([]);    // asa del Lunes a la izquierda
    expect(barridoGanar([6], 6, 1, 3)).toEqual([]);     // asa del Domingo a la derecha
    expect(barridoGanar(LUN, 0, 1, -3)).toEqual([1]);   // columnas negativas = gesto clásico
  });

  test('espejo del retiro: los dos barridos cuentan las columnas igual', () => {
    // Mismo bloque (Lun–Vie), asa en el Miércoles: 1 columna completa hacia
    // afuera gana 2 días; hacia adentro retira 2. La asimetría que sí se
    // conserva es la del extremo: el día bajo el dedo entra al ganar y se
    // salva al retirar.
    const dias = [0, 1, 2];
    expect(barridoGanar(dias, 2, 1, 1)).toEqual([3, 4]);
    expect(barridoRetiro(dias, 2, -1, 1)).toEqual([2, 1]);
    expect(barridoGanar(dias, 2, 1, 1).length).toBe(barridoRetiro(dias, 2, -1, 1).length);
  });
});

describe('resolverEstirarGlobal — crecer desde el modal como con el deslizable', () => {
  const a = (id: string, start: string, end: string, days: number[]): Activity => ({
    id, name: id, categoryId: 'c', startTime: start, endTime: end, daysOfWeek: days,
    updatedAt: 0
  });

  test('día apretado: topa por la capacidad del día más apretado y NO se rechaza', () => {
    // Rutina 9-10 en Lun-Vie. El Martes tiene detrás 2h + 8h hasta las 20: la
    // cadena hasta el fin del día (22) da 2h de recorrido. El deseo del modal
    // es 9-13 (crece 3h) pero la capacidad global es 2h → crece 2h y topa.
    const acts = [
      a('r', '09:00', '10:00', [0, 1, 2, 3, 4]),
      a('e', '10:00', '12:00', [1]),
      a('f', '12:00', '20:00', [1])
    ];
    const res = resolverEstirarGlobal(acts, 'r', 9, 13, codec, 7, 22, 'abajo');
    expect(res.valido).toBe(true);
    expect(res.toco, 'el deseo no entró entero y no lo avisó').toBe(true);
    expect(res.fin).toBe(12);                       // 10 + 2h de cadena
    expect(res.times.get('e')).toEqual(s('e', 12, 14));
    expect(res.times.get('f')).toEqual(s('f', 14, 22)); // hasta el borde del día
    expect(res.movidos.map(m => m.nombre)).toEqual(['e', 'f']);
  });

  test('con hueco de sobra: crece entero y empuja solo a quien choca', () => {
    const acts = [
      a('r', '09:00', '10:00', [0, 1]),
      a('e', '10:00', '11:00', [0, 1])
    ];
    const res = resolverEstirarGlobal(acts, 'r', 9, 12, codec, 7, 22, 'abajo');
    expect(res.valido).toBe(true);
    expect(res.toco).toBe(false);
    expect(res.fin).toBe(12);
    expect(res.times.get('r')).toEqual(s('r', 9, 12));
    expect(res.times.get('e')).toEqual(s('e', 12, 13));
    expect(res.movidos.map(m => m.nombre)).toEqual(['e']);
  });

  test('el empuje viaja a TODOS los días del vecino (horario global)', () => {
    const acts = [
      a('r', '09:00', '10:00', [0, 1]),
      a('e', '10:00', '11:00', [0, 1, 4])   // el vecino vive en 3 días
    ];
    const res = resolverEstirarGlobal(acts, 'r', 9, 12, codec, 7, 22, 'abajo');
    expect(res.valido).toBe(true);
    // Un solo horario global para "e": se aplicó a todos sus días.
    expect(res.times.get('e')).toEqual(s('e', 12, 13));
  });

  test('lado "arriba" (el modal movió el inicio): empuja la cadena hacia ARRIBA', () => {
    const acts = [
      a('r', '10:00', '11:00', [0]),
      a('e', '09:00', '09:30', [0])
    ];
    // El usuario quiere 7-11 (el fin 11 queda fijo): hay 2.5h hasta el inicio
    // del día menos lo que ocupa "e" → entra 7:30-11 y "e" sube a 7-7:30.
    const res = resolverEstirarGlobal(acts, 'r', 7, 11, codec, 7, 22, 'arriba');
    expect(res.valido).toBe(true);
    expect(res.inicio).toBe(7.5);
    expect(res.fin).toBe(11);
    expect(res.times.get('e')).toEqual(s('e', 7, 7.5));  // corrido hacia arriba
    expect(res.movidos.map(m => m.nombre)).toEqual(['e']);
  });

  test('sin crecimiento: NO empuja a nadie (mover/encoger lo valida el caller)', () => {
    const acts = [a('r', '09:00', '10:00', [0]), a('e', '10:00', '11:00', [0])];
    // Misma duración (1h), movida 1h antes: el choque lo valida el caller, no
    // hay empuje que resolver.
    const res = resolverEstirarGlobal(acts, 'r', 8, 9, codec, 7, 22, 'abajo');
    expect(res.valido).toBe(true);
    expect(res.toco).toBe(false);
    expect(res.movidos).toEqual([]);
    expect([...res.times.keys()]).toEqual(['r']);       // solo la actividad
    expect(res.times.get('r')).toEqual(s('r', 8, 9));
  });

  test('actividad inexistente o días sin la actividad: motivo, no excepción', () => {
    expect(resolverEstirarGlobal([], 'nope', 9, 12, codec, 7, 22).valido).toBe(false);
  });
});

describe('resolverGanarDias — ganar varios días con la misma hora (el gesto de días)', () => {
  const a = (id: string, start: string, end: string, days: number[]): Activity => ({
    id, name: id, categoryId: 'c', startTime: start, endTime: end, daysOfWeek: days,
    updatedAt: 0
  });

  test('sin colisión: nadie se mueve y la actividad entra en todos los días ganados', () => {
    const acts = [
      a('r', '09:00', '10:00', [0]),        // Rutina, solo el Lunes
      a('d', '10:30', '11:00', [1, 2])      // Desayuno en Mar y Mié, sin choque
    ];
    const res = resolverGanarDias(acts, 'r', [1, 2], codec, 22);
    expect(res.valido).toBe(true);
    expect(res.motivo).toBe('');
    expect(res.times.get('d')).toEqual(s('d', 10.5, 11)); // nadie corrido
    expect(res.times.get('r')).toEqual(s('r', 9, 10));     // la hora NO cambia
    // El preview tiene que traer el día completo de cada día ganado.
    expect([...res.porDia.keys()].sort((x, y) => x - y)).toEqual([0, 1, 2]);
    expect(res.porDia.get(1)!.get('r')).toEqual(s('r', 9, 10));
    expect(res.porDia.get(2)!.get('r')).toEqual(s('r', 9, 10));
  });

  test('la actividad conserva su hora aunque el día tenga hueco antes (el gesto es de DÍAS)', () => {
    // El día del Martes está libre de 7:00 a las 11:00. Ganar el Martes no
    // puede correr la Rutina a las 8:00: el gesto no es de horario.
    const acts = [a('r', '09:00', '10:00', [0]), a('e', '11:00', '12:00', [1])];
    const res = resolverGanarDias(acts, 'r', [1], codec, 22);
    expect(res.valido).toBe(true);
    expect(res.times.get('r')).toEqual(s('r', 9, 10));
    expect(res.times.get('e')).toEqual(s('e', 11, 12));
  });

  test('con colisión: empuja en cadena en el día ganado, una sola vez por bloque', () => {
    // Rutina 9-10 entra al Martes, donde Ejercicio ocupa 9:30-10:15 → la pared
    // empuja la cadena hacia abajo conservando duraciones.
    const acts = [
      a('r', '09:00', '10:00', [0]),
      a('e', '09:30', '10:15', [1]),
      a('c', '10:15', '10:30', [1])
    ];
    const res = resolverGanarDias(acts, 'r', [1], codec, 22);
    expect(res.valido).toBe(true);
    expect(res.times.get('e')).toEqual(s('e', 10, 10.75));
    expect(res.times.get('c')).toEqual(s('c', 10.75, 11));
    // El preview del día ganado es el horario que se va a guardar.
    expect(res.porDia.get(1)!.get('e')).toEqual(s('e', 10, 10.75));
  });

  test('ganar una tira entera empuja en todos los días (y no solo en el primero)', () => {
    const acts = [
      a('r', '09:00', '10:00', [0]),
      a('e', '09:30', '10:15', [1, 2, 3])
    ];
    const res = resolverGanarDias(acts, 'r', [1, 2, 3], codec, 22);
    expect(res.valido).toBe(true);
    // Un solo horario global para el vecino, y es el corrido en cada día.
    expect(res.times.get('e')).toEqual(s('e', 10, 10.75));
    for (const d of [1, 2, 3]) expect(res.porDia.get(d)!.get('e')).toEqual(s('e', 10, 10.75));
  });

  test('el empuje es GLOBAL: si el vecino vive en más días, también se los lleva', () => {
    // Ejercicio vive en Mar(1) y Vie(4). Ganar solo el Mar lo corre: su hora
    // es global, así que el Viernes queda corrido también y el preview tiene
    // que avisarlo (si no, al soltar el bloque salta de golpe).
    const acts = [
      a('r', '09:00', '10:00', [0]),
      a('e', '09:30', '10:15', [1, 4])
    ];
    const res = resolverGanarDias(acts, 'r', [1], codec, 22);
    expect(res.valido).toBe(true);
    expect(res.times.get('e')).toEqual(s('e', 10, 10.75));
    expect(res.porDia.get(4)!.get('e')).toEqual(s('e', 10, 10.75));
  });

  test('⛔ si la cadena desborda el día: el motivo NOMBRA el día y no se escribe nada', () => {
    // Día del Miércoles lleno hasta las 22:00: la pared no tiene dónde empujar.
    const acts = [
      a('r', '09:00', '10:00', [0]),
      a('e', '09:30', '21:59', [2]),
      a('c', '21:59', '22:00', [2])
    ];
    const res = resolverGanarDias(acts, 'r', [2], codec, 22);
    expect(res.valido).toBe(false);
    expect(res.motivo).toContain('Miércoles');
    expect(res.times.size).toBe(0);
    expect(res.porDia.size).toBe(0);
  });

  test('sin días nuevos no hay gesto (no escribe nada)', () => {
    const acts = [a('r', '09:00', '10:00', [0, 1])];
    expect(resolverGanarDias(acts, 'r', [1], codec, 22).valido).toBe(false);
    expect(resolverGanarDias(acts, 'r', [9, -1], codec, 22).valido).toBe(false);
    expect(resolverGanarDias(acts, 'no-existe', [2], codec, 22).valido).toBe(false);
  });

  test('un solape que YA existía no veta el gesto; uno nuevo sí', () => {
    // El Martes ya tenía a "e" y "c" encima (estado heredado, no lo introduce
    // el gesto). Ganar el Martes con la Rutina a las 9 no crea solape nuevo:
    // el horario de e/c no se toca.
    const acts = [
      a('r', '09:00', '10:00', [0]),
      a('e', '10:00', '11:00', [1]),
      a('c', '10:00', '11:00', [1])   // se solapa con e desde antes
    ];
    const res = resolverGanarDias(acts, 'r', [1], codec, 22);
    expect(res.valido).toBe(true);
    expect(res.times.get('e')).toEqual(s('e', 10, 11));
    expect(res.times.get('c')).toEqual(s('c', 10, 11));
  });

  test('dos días ganados con empujes distintos NO producen dos horarios', () => {
    // El Martes solo tiene hueco a medias: la pared lo acomoda más arriba; el
    // Miércoles tiene la cadena completa. Con un horario global por bloque hay
    // que elegir UN valor que sirva en los dos días (el que empuja más lejos).
    const acts = [
      a('r', '09:00', '10:00', [0]),
      a('e', '09:30', '10:15', [1, 2]),
      a('l', '10:15', '10:30', [2])
    ];
    const res = resolverGanarDias(acts, 'r', [1, 2], codec, 22);
    expect(res.valido).toBe(true);
    // Un solo horario para "e"...
    expect(res.times.get('e')!.start).toBe(10);
    // ...y en NINGÚN día queda pisado (el punto de este test).
    for (const d of [1, 2]) {
      const slots = [...res.porDia.get(d)!.values()];
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          expect(slots[i].start < slots[j].end && slots[j].start < slots[i].end,
            `solape en el día ${d}: ${slots[i].id} vs ${slots[j].id}`).toBe(false);
        }
      }
    }
  });

  test('una actividad de por medio NO bloquea la tira: la cadena sigue en la semana del vecino', () => {
    // El reporte: "si hay una actividad de por medio, no se puede extender".
    // Estado real (la semilla de la app): la actividad a ganar vive en
    // Lun–Vie 8:30-9; el Sábado ya tiene "Muro" 8-12; y "Trabajo" (Mar–Vie
    // 9-13) está justo debajo.
    //
    // Antes: el veto "si correr a este vecino rompe otro de sus días, no lo
    // corras" abortaba la cadena a mitad. "Muro" sí se corría (8-12 → 9-13),
    // pero "Trabajo" se quedaba en 9-13 ENCIMA de él y el gesto entero moría
    // con "No cabe: en Sábado Muro se pondría sobre Trabajo" — sin ganar nada.
    //
    // Ahora: el horario de un bloque es GLOBAL. Correr a "Trabajo" lo corre en
    // TODA su semana y la cadena sigue debajo (Almuerzo, Tomar sol).
    const acts = [
      a('cinta', '08:30', '09:00', [0, 1, 2, 3, 4]),
      a('muro', '08:00', '12:00', [5]),
      a('almuerzo', '13:00', '14:00', [0, 1, 2, 3, 4, 5, 6]),
      a('desayuno', '08:00', '08:30', [0, 1, 2, 3, 4, 5, 6]),
      a('rutina', '07:00', '08:00', [0, 1, 2, 3, 4, 5, 6]),
      a('sol', '17:30', '17:45', [0, 1, 2, 3, 4, 5, 6]),
      a('trabajo', '09:00', '13:00', [1, 2, 3, 4, 5]),
    ];
    const res = resolverGanarDias(acts, 'cinta', [5, 6], codec, 23);
    // Se muestra valido Y motivo juntos: el motivo era el síntoma en pantalla.
    expect({ valido: res.valido, motivo: res.motivo }).toEqual({ valido: true, motivo: '' });

    // El bloque entró en Sábado y en Domingo, con su misma hora.
    expect(res.porDia.get(5)!.get('cinta')).toEqual(s('cinta', 8.5, 9));
    expect(res.porDia.get(6)!.get('cinta')).toEqual(s('cinta', 8.5, 9));

    // El vecino se corrió en TODOS sus días, no solo en el del gesto: ese era
    // el veto que mataba la cadena.
    expect(res.times.get('trabajo')).toEqual(s('trabajo', 13, 17));
    for (const d of [1, 2, 3, 4, 5]) {
      expect(res.porDia.get(d)!.get('trabajo')).toEqual(s('trabajo', 13, 17));
    }

    // Y la cadena siguióAbajo en cada día: ni un solape en ninguno.
    for (const [d, m] of res.porDia) {
      const arr = [...m.values()];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          expect(arr[i].start < arr[j].end && arr[j].start < arr[i].end,
            `solape en el día ${d}: ${arr[i].id} vs ${arr[j].id}`).toBe(false);
        }
      }
    }
  });
});

/** Fixture mínimo de actividad para la validación de choques. */
const act = (id: string, name: string, startTime: string, endTime: string, daysOfWeek: number[], deletedAt?: number): Activity =>
  ({ id, categoryId: 'rutina', name, startTime, endTime, daysOfWeek, updatedAt: 0, ...(deletedAt ? { deletedAt } : {}) } as Activity);

describe('chocaHoras — solape [ini,fin) en minutos enteros', () => {
  test('bordes que se tocan NO chocan (extremos exclusivos)', () => {
    expect(chocaHoras('15:45', '16:00', '16:00', '16:30')).toBe(false);
    expect(chocaHoras('16:00', '16:30', '15:45', '16:00')).toBe(false);
  });

  test('solape parcial de 15 min sí choca (caso Baño vs trabajo (opcional) (copia))', () => {
    expect(chocaHoras('19:00', '19:45', '17:45', '19:15')).toBe(true);
    expect(chocaHoras('17:45', '19:15', '19:00', '19:45')).toBe(true);
  });

  test('idénticos y contenidos chocan', () => {
    expect(chocaHoras('08:00', '09:00', '08:00', '09:00')).toBe(true);
    expect(chocaHoras('08:30', '08:45', '08:00', '09:00')).toBe(true);
  });
});

describe('horarioEfectivoDia — qué actividades existen en un día', () => {
  const plantilla = [
    act('cop', 'trabajo (opcional) (copia)', '17:45', '19:15', [0, 1, 2, 3, 4]),
    act('ej', 'Ejercicio', '11:30', '12:15', [0, 2, 4]),
    act('bor', 'borrada', '12:00', '13:00', [0], 123),
    act('sab', 'de otro día', '10:00', '11:00', [5])
  ];

  test('sin override: plantilla del día, sin borradas, sin la editada', () => {
    const vigentes = horarioEfectivoDia(plantilla, undefined, 0, 'ej');
    expect(vigentes.map(a => a.id)).toEqual(['cop']);
  });

  test('con override: ES el día — bloques de plantilla ausentes NO existen', () => {
    // Override con ids PROPIOS (caso real: el override de Lunes no hereda
    // los ids de la plantilla). "cop" y "ej" de la plantilla NO deben
    // aparecer aunque daysOfWeek los incluya.
    const override = {
      day: 0,
      activities: [act('x1', 'Baño', '18:00', '19:30', [0]), act('x2', 'Cena', '19:30', '20:00', [0])],
      updatedAt: 0
    };
    const vigentes = horarioEfectivoDia(plantilla, override, 0, null);
    expect(vigentes.map(a => a.id)).toEqual(['x1', 'x2']);
  });

  test('con override: excluirId quita la actividad editada del override', () => {
    const override = {
      day: 0,
      activities: [act('x1', 'Baño', '18:00', '19:30', [0]), act('x2', 'Cena', '19:30', '20:00', [0])],
      updatedAt: 0
    };
    const vigentes = horarioEfectivoDia(plantilla, override, 0, 'x1');
    expect(vigentes.map(a => a.id)).toEqual(['x2']);
  });

  test('override vacío (activities: []) = día sin bloques, no cae a plantilla', () => {
    const override = { day: 0, activities: [], updatedAt: 0 };
    expect(horarioEfectivoDia(plantilla, override, 0, null)).toEqual([]);
  });
});

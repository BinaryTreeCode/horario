import { describe, test, expect } from 'bun:test';
import { resolveDayCascade, resolveResizeDay, resolveNudgeDay, propagateWeekly } from './cascade';
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

  test('hueco más chico que el bloque → inválido y el dedo manda en el ghost', () => {
    // a 8-10, hueco 10-10:45, r 10:45-12; bloque de 1h: NO cabe.
    const slots = [s('a', 8, 10), s('r', 10.75, 12), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 10.5, 11.5), 10.5, false, 7, 22);
    expect(p.valido).toBe(false);
    expect(p.motivo).toBe('⛔ No cabe en este hueco');
    // El ghost se pinta donde el dedo pide (solo clamp al día).
    expect(p.movido.start).toBe(10.5);
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
});

describe('resolveDayCascade — mitades: insertar ANTES/DESPUÉS (adelantamiento)', () => {
  test('dedo en la mitad SUPERIOR del pisado → inserta ANTES (rotación del tramo)', () => {
    // x (15-16, al final del día) suelta con el dedo a las 8.2 (mitad superior
    // de b 8-9) → x ADELANTA al tope: x 8-9, b 9-10 y r toma el slot viejo
    // de x (15-16) — el hueco 10-15 queda intacto entre b y r.
    const slots = [s('b', 8, 9), s('r', 9, 10), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 15, 16), 8.2, false, 7, 22);
    expect(p.valido).toBe(true);
    expect(p.accion).toBe('insertar');
    expect(byId(p.slots).get('x')).toEqual(s('x', 8, 9));
    expect(byId(p.slots).get('b')).toEqual(s('b', 9, 10));
    expect(byId(p.slots).get('r')).toEqual(s('r', 15, 16));
  });

  test('dedo en la mitad INFERIOR del pisado → inserta DESPUÉS (retroceso)', () => {
    // x (8-9, primero del día) suelta con dedo 11.8 (mitad inferior de r
    // 11-12) → x retrocede al final del tramo: b sube a 8-9, r a 9-10, el
    // hueco 10-11 queda entre r y x, y x cierra el tramo en 11-12 (span
    // original 8-12 conservado).
    const slots = [s('x', 8, 9), s('b', 9, 10), s('r', 11, 12)];
    const p = resolveDayCascade(slots, s('x', 8, 9), 11.8, false, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('b')).toEqual(s('b', 8, 9));
    expect(m.get('r')).toEqual(s('r', 9, 10));
    expect(m.get('x')).toEqual(s('x', 11, 12));
  });

  test('SIN REEMPLAZOS: el día conserva exactamente los mismos ids', () => {
    const slots = [s('a', 8, 9), s('b', 9, 10), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 8.5, 9.5), 8.1, false, 7, 22);
    const ids = p.slots.map(x => x.id).sort();
    expect(ids).toEqual(['a', 'b', 'x']);
  });

  test('adelantamiento en el medio: los intermedios rotan y los huecos externos quedan', () => {
    // Orden: a 7-8, b 8-9, c 9-10, hueco 10-12, d 12-13. x=c suelta sobre b
    // (dedo 8.2, mitad superior) → orden a, c, b, d: c 8-9, b 9-10 (rotación
    // del tramo), d INTACTO (fuera del tramo) y el hueco 10-12 se conserva.
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

  test('insertar ANTES con hueco intermedio: el hueco se conserva tras la rotación', () => {
    // a 11-12, r 12-13, LIBRE 13-15, x 15-16. x suelta mitad superior de r
    // (12.2) → orden a, x, r: x 12-13, el hueco 13-15 queda entre x y r,
    // y r aterriza en 15-16 (el slot que dejó x). El tramo permuta dentro
    // de su propio rango: nada desborda el día.
    const slots = [s('a', 11, 12), s('r', 12, 13), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 15, 16), 12.2, false, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('a')).toEqual(s('a', 11, 12));
    expect(m.get('x')).toEqual(s('x', 12, 13));
    expect(m.get('r')).toEqual(s('r', 15, 16));
  });

  test('la rotación NUNCA desborda el día: permuta dentro del rango del tramo', () => {
    // x (15-16) inserta ANTES de r (7-8, al límite del día): x toma el 7-8
    // de r y r el 15-16 de x. El span total 7-16 se conserva → siempre válido.
    const slots = [s('r', 7, 8), s('x', 15, 16)];
    const p = resolveDayCascade(slots, s('x', 15, 16), 7.2, false, 7, 22);
    expect(p.valido).toBe(true);
    expect(byId(p.slots).get('x')).toEqual(s('x', 7, 8));
    expect(byId(p.slots).get('r')).toEqual(s('r', 15, 16));
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

  test('mitad inferior: ancla al fin del pisado; el hueco absorbe el empuje', () => {
    // Destino: b 8-9, r 9-10, hueco 10-12, d 12-13. x (1h) dedo 9.8 →
    // x 10-11, d intacto (el hueco absorbe).
    const slots = [s('b', 8, 9), s('r', 9, 10), s('d', 12, 13)];
    const p = resolveDayCascade(slots, s('x', 10, 11), 9.8, true, 7, 22);
    expect(p.valido).toBe(true);
    const m = byId(p.slots);
    expect(m.get('x')).toEqual(s('x', 10, 11));
    expect(m.get('d')).toEqual(s('d', 12, 13));
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

  test('ex-C3: el empuje de un vecino no puede pisar en otro de SUS días', () => {
    // n vive lunes y martes (9-10); w martes 9-10; m lunes 8-9 se mueve a 8:30
    // pisando a n en lunes → n debería empujarse a 9:30, pero en martes
    // chocaría con w → rechazado: n queda solapado en lunes (9-10 original).
    const acts = [
      act('m', '08:00', '09:00', [0]),
      act('n', '09:00', '10:00', [0, 1]),
      act('w', '09:00', '10:00', [1])
    ];
    const res = propagateWeekly(acts, 'm', 8.5, 22, codec, [0], undefined, 0, false, {
      day: 0,
      slots: [s('m', 8.5, 9.5), s('n', 9.5, 10.5)]
    });
    // El slot exacto del preview pisa a n en martes (n debe 9:30-10:30 →
    // w 9-10 pisa) → n rechazado y por extensión el día cae a la pared.
    expect(res.times.get('n')!.start).toBe(9);
    expect(res.times.get('w')!.start).toBe(9);
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

  test('drag entre columnas: mineDays del destino incluye el día nuevo', () => {
    const acts = [
      act('x', '09:00', '10:00', [0]),
      act('k', '09:30', '10:30', [4])
    ];
    const res = propagateWeekly(acts, 'x', 10, 22, codec, [4]);
    expect(res.times.get('x')!.start).toBe(10);
    // k (9:30-10:30) pisa la pared 10-11 → empujado a 11-12.
    expect(res.times.get('k')!.start).toBe(11);
  });
});

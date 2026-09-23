import { describe, test, expect } from 'bun:test';
import { resolveDayCascade, propagateWeekly } from './cascade';
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

describe('resolveDayCascade — semántica local', () => {
  test('drop en hueco libre: el resto del día NO se mueve (huecos preservados)', () => {
    // a 7-8, hueco 8-9.5, b 9.5-10.5: soltar c (desde 10.75) en 8.25 no toca a b
    const out = byId(resolveDayCascade(
      [s('a', 7, 8), s('b', 9.5, 10.5), s('c', 8.25, 9.25)],
      22, 'c', 7, 10.75
    ));
    expect(out.get('c')!.start).toBe(8.25);
    expect(out.get('a')).toEqual(s('a', 7, 8));
    expect(out.get('b')).toEqual(s('b', 9.5, 10.5));
  });

  test('drop sobre UN bloque con origen despejado: INTERCAMBIO', () => {
    // b (1h) cae en 8-9 donde está a (1h): a va al origen de b (9-10) — sin hueco
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 8, 9), s('c', 10, 11.5)],
      22, 'b', 7, 9
    ));
    expect(out.get('b')).toEqual(s('b', 8, 9));
    expect(out.get('a')).toEqual(s('a', 9, 10)); // intercambiado al origen
    expect(out.get('c')).toEqual(s('c', 10, 11.5)); // nadie más se movió
  });

  test('swap guard: pisado más largo que el origen → empuje, no intercambio', () => {
    // b (2h) sobre a (1h): a (2h→1h) no cabe en el origen de b
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 8, 10)],
      22, 'b', 7, 9
    ));
    expect(out.get('b')!.start).toBe(8);
    expect(out.get('a')!.start).toBe(10); // empujado después de b
  });

  test('swap guard: el pisado al origen solaparía a un tercero → empuje', () => {
    // b (1h) sobre a (1h), pero c vive en el origen de b (9-9.75). El swap se
    // rechaza (a pisaría a c) → empuje: a cae en 9-10 pisa a c → c se empuja.
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 8, 9), s('c', 9, 9.75)],
      22, 'b', 7, 9
    ));
    expect(out.get('b')!.start).toBe(8);
    expect(out.get('a')!.start).toBe(9); // empujado tras b
    expect(out.get('c')!.start).toBe(10); // cadena: a aterrizó encima
  });

  test('sin origen (drag entre columnas): siempre empuje, nunca swap', () => {
    // a se empuja a 10.5-11.5 y aterriza sobre c (11-13) → la cadena continúa.
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 8.5, 10.5), s('c', 11, 13)],
      22, 'b', 7, null
    ));
    expect(out.get('a')!.start).toBe(10.5); // empujado
    expect(out.get('c')!.start).toBe(11.5); // cadena: a aterrizó encima
  });

  test('dos pisados: cadena local, lo de arriba y lo lejano intactos', () => {
    // d cae en 8.5-9.5 pisa a b (8.25-9.25) y a c (9-10)
    const out = byId(resolveDayCascade(
      [s('a', 7, 8), s('b', 8.25, 9.25), s('c', 9, 10), s('d', 8.5, 9.5)],
      22, 'd', 7, null
    ));
    expect(out.get('d')!.start).toBe(8.5);
    expect(out.get('a')).toEqual(s('a', 7, 8)); // arriba del drop: intacto
    expect(out.get('b')!.start).toBe(9.5); // pisado → empujado tras d
    expect(out.get('c')!.start).toBe(10.5); // en la cadena
  });

  test('el primer hueco libre corta la cadena', () => {
    // d (1.5h) cae en 8.5-10, empuja a y b; c está lejos tras el hueco 12-13
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 9, 10), s('c', 13, 14), s('d', 8.5, 10)],
      22, 'd', 7, null
    ));
    expect(out.get('d')).toEqual(s('d', 8.5, 10));
    expect(out.get('a')!.start).toBe(10);
    expect(out.get('b')!.start).toBe(11);
    expect(out.get('c')).toEqual(s('c', 13, 14)); // hueco 12-13 la protegió
  });

  test('día lleno: nada sale de [startHour, endHour] (A2)', () => {
    const out = resolveDayCascade(
      [s('a', 7, 8.5), s('b', 8, 9.5), s('c', 9, 10.5), s('d', 7, 9)],
      10, 'd', 7, null
    );
    for (const slot of out) {
      expect(slot.start).toBeGreaterThanOrEqual(7 - 0.001);
      expect(slot.end).toBeLessThanOrEqual(10 + 0.001);
    }
  });

  test('endHour 24: los slots llegan a 24:00 sin pasarse', () => {
    const out = resolveDayCascade([s('a', 22, 23.5), s('b', 23, 24.5)], 24, 'b', 7, null);
    for (const slot of out) {
      expect(slot.end).toBeLessThanOrEqual(24.001);
    }
  });

  test('minutos enteros: sin 09:60 por flotantes (9.999h)', () => {
    const out = resolveDayCascade([s('a', 9, 9.999), s('b', 10, 11)], 22, 'b', 7, null);
    for (const slot of out) {
      const totalMin = Math.round(slot.start * 60);
      expect(totalMin % 15).toBe(0);
    }
  });
});

describe('propagateWeekly', () => {
  const mkAct = (id: string, days: number[], start: string, end: string): Activity => ({
    id, name: id, categoryId: 'c', startTime: start, endTime: end,
    daysOfWeek: days, updatedAt: 0
  });

  const acts: Activity[] = [
    mkAct('desayuno', [0, 1, 2, 3, 4, 5, 6], '09:00', '09:30'),
    mkAct('trabajo1', [1, 2, 3, 4, 5], '09:15', '10:45'),
    mkAct('rutina', [4, 5, 6], '10:45', '11:45')
  ];

  test('mover trabajo1 a sábado 8:00: push consistente, cero solapes sin resolver', () => {
    const res = propagateWeekly(acts, 'trabajo1', 8, 22, codec, [5]);
    // trabajo1 8:00–9:30 pisa al desayuno (9:00) el sábado → empujado a 9:30.
    // Una fila = un horario: el push es global (opción elegida) y el cierre
    // garantiza que TODOS los días quedan resueltos — cero solapes heredados.
    expect(res.times.get('desayuno')!.start).toBeCloseTo(9.5, 3);
    for (let d = 0; d < 7; d++) {
      const slots = acts
        .filter(a => (a.id === 'trabajo1' ? d === 5 : a.daysOfWeek.includes(d)))
        .map(a => res.times.get(a.id!)!)
        .sort((x, y) => x.start - y.start);
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].start).toBeGreaterThanOrEqual(slots[i - 1].end - 0.001);
      }
    }
    // Rutina, lejos de la colisión, intacta.
    expect(res.times.get('rutina')!.start).toBe(10.75);
  });

  test('colisión nueva en destino empuja al vecino con duración preservada', () => {
    const res = propagateWeekly(acts, 'trabajo1', 9, 22, codec, [5]);
    const sab = res.byDay.get(5)!;
    expect(sab.get('trabajo1')!.start).toBe(9);
    expect(sab.get('desayuno')!.start).toBeCloseTo(10.5, 3);
    expect(sab.get('desayuno')!.end).toBeCloseTo(11, 3);
  });

  test('la propagación cierra transitivamente: vecinos afectados re-resuelven sus otros días', () => {
    const res = propagateWeekly(acts, 'desayuno', 9.25, 22, codec, [0, 1, 2, 3, 4, 5, 6]);
    const lunes = res.byDay.get(1)!;
    const t1 = lunes.get('trabajo1')!;
    expect(t1.start).toBeGreaterThanOrEqual(9.5 - 0.001); // empujado después del desayuno
  });

  test('drag entre columnas: mineDays sin el origen (quita lunes, agrega sábado)', () => {
    const res = propagateWeekly(acts, 'trabajo1', 12, 22, codec, [4, 5]);
    const t = res.times.get('trabajo1')!;
    expect(t.start).toBe(12);
    expect(t.end).toBe(13.5);
  });

  test('sin espacio en el día: compresión acotada, sin horas negativas', () => {
    const tight: Activity[] = [
      mkAct('a', [0], '07:00', '08:30'),
      mkAct('b', [0], '08:00', '09:30'),
      mkAct('c', [0], '09:00', '10:30'),
      mkAct('movida', [1], '07:00', '09:00')
    ];
    const res = propagateWeekly(tight, 'movida', 7, 10, codec, [0]);
    for (const [, day] of res.byDay) {
      for (const slot of day.values()) {
        expect(slot.start).toBeGreaterThanOrEqual(7 - 0.001);
        expect(slot.end).toBeLessThanOrEqual(10 + 0.001);
      }
    }
  });
});

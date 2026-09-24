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

describe('resolveDayCascade — semántica local con regla de mitades', () => {
  test('drop en hueco libre: el resto del día NO se mueve (huecos preservados)', () => {
    // a 7-8, hueco 8-9.5, b 9.5-10.5: soltar c en 8.25 no toca a nadie
    const out = byId(resolveDayCascade(
      [s('a', 7, 8), s('b', 9.5, 10.5), s('c', 8.25, 9.25)],
      22, 'c', 7
    ));
    expect(out.get('c')!.start).toBe(8.25);
    expect(out.get('a')).toEqual(s('a', 7, 8));
    expect(out.get('b')).toEqual(s('b', 9.5, 10.5));
  });

  test('mitad superior del pisado → queda ARRIBA pegado, sin empujar nada', () => {
    // b cae dentro de a (8-9) con centro en 8 (mitad superior)
    // → b sube pegado 7-8 (termina donde empieza a), a intacto.
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 7.5, 8.5)],
      22, 'b', 7
    ));
    expect(out.get('b')).toEqual(s('b', 7, 8));
    expect(out.get('a')).toEqual(s('a', 8, 9));
  });

  test('empate de centros (drop coincidente) → ABAJO: lo espera quien suelta en la parte baja', () => {
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 8, 9)],
      22, 'b', 7
    ));
    expect(out.get('a')).toEqual(s('a', 8, 9));
    expect(out.get('b')).toEqual(s('b', 9, 10));
  });

  test('mitad inferior del pisado → queda DEBAJO pegado', () => {
    // b cae en 8.5-9.5 dentro de a (8-9): centro 9 > 8.5 (mitad inferior)
    // → b baja pegado 9-10 (empieza donde termina a), a intacto.
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 8.5, 9.5)],
      22, 'b', 7
    ));
    expect(out.get('a')).toEqual(s('a', 8, 9));
    expect(out.get('b')).toEqual(s('b', 9, 10));
  });

  test('mitad superior con el hueco ocupado → toma el inicio del pisado y lo empuja', () => {
    // z ocupa el hueco 7-7.5 sobre a: b (drop 7.5-8.5, mitad superior) no cabe
    // pegado arriba → entra en 8-9 (inicio del pisado) y empuja a a; z intacto.
    const out = byId(resolveDayCascade(
      [s('z', 7, 7.5), s('a', 8, 9), s('b', 7.5, 8.5)],
      22, 'b', 7
    ));
    expect(out.get('b')).toEqual(s('b', 8, 9));
    expect(out.get('a')!.start).toBe(9);
    expect(out.get('z')).toEqual(s('z', 7, 7.5));
  });

  test('mitad inferior empuja en cadena lo que el destino pisa', () => {
    // b (15min) cae en la mitad inferior de a (8-9) → baja pegado 9-9:15, pero
    // c vive ahí → c baja a 9:15-10:15; a intacto.
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('c', 9, 10), s('b', 8.5, 8.75)],
      22, 'b', 7
    ));
    expect(out.get('a')).toEqual(s('a', 8, 9));
    expect(out.get('b')).toEqual(s('b', 9, 9.25));
    expect(out.get('c')!.start).toBe(9.25);
  });

  test('keepPlace (resize): el arrastrado conserva su inicio y solo empuja', () => {
    // Estirar b hasta 9.5: la regla de mitades no aplica (no se reubica) y
    // empuja a a, que estorbaba.
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 8, 9.5)],
      22, 'b', 7, true
    ));
    expect(out.get('b')).toEqual(s('b', 8, 9.5));
    expect(out.get('a')!.start).toBe(9.5);
  });

  test('dos pisados: mitades contra el CORTADO (centro del drop), cadena al resto', () => {
    // d (8.5-9.5, centro 9) pisa b (8.25-9.25) y c (9-10): el cortado es b
    // (contiene el centro). Centro 9 > centro de b 8.75 → mitad inferior →
    // d queda DEBAJO de b (9.25), b intacto y c empujado en cadena.
    const out = byId(resolveDayCascade(
      [s('a', 7, 8), s('b', 8.25, 9.25), s('c', 9, 10), s('d', 8.5, 9.5)],
      22, 'd', 7
    ));
    expect(out.get('d')).toEqual(s('d', 9.25, 10.25));
    expect(out.get('a')).toEqual(s('a', 7, 8)); // arriba del drop: intacto
    expect(out.get('b')).toEqual(s('b', 8.25, 9.25)); // cortado: intacto
    expect(out.get('c')!.start).toBe(10.25); // en la cadena
  });

  test('pila contigua pisada: se INSERTA entre los bloques (no desliza junta)', () => {
    // Pila b (9-10) + c (10-11) pegados. d (1h) cae 9.25-10.25, centro 9.75
    // ∈ b → mitades: centro 9.75 > 9.5 (mitad inferior de b) → d queda DEBAJO
    // de b (10-11) y c (lo que seguía pegado) baja en cadena: la pila se parte.
    const out = byId(resolveDayCascade(
      [s('b', 9, 10), s('c', 10, 11), s('d', 9.25, 10.25)],
      22, 'd', 7
    ));
    expect(out.get('b')).toEqual(s('b', 9, 10)); // arriba del corte: intacto
    expect(out.get('d')).toEqual(s('d', 10, 11)); // insertado ENTRE b y c
    expect(out.get('c')).toEqual(s('c', 11, 12)); // desplazado por la inserción
  });

  test('el primer hueco libre corta la cadena', () => {
    // d (1.5h) cae 8.5-10 (centro 9.25 ∈ b 9-10, mitad superior): mitades →
    // sube pegado al inicio de b (9). a queda intacto (no lo pisa el final),
    // b baja en cadena y c está protegido por el hueco 12-13.
    const out = byId(resolveDayCascade(
      [s('a', 8, 9), s('b', 9, 10), s('c', 13, 14), s('d', 8.5, 10)],
      22, 'd', 7
    ));
    expect(out.get('d')).toEqual(s('d', 9, 10.5));
    expect(out.get('a')).toEqual(s('a', 8, 9));
    expect(out.get('b')!.start).toBe(10.5);
    expect(out.get('c')).toEqual(s('c', 13, 14)); // hueco 12-13 la protegió
  });

  test('día lleno: nada sale de [startHour, endHour] (A2)', () => {
    const out = resolveDayCascade(
      [s('a', 7, 8.5), s('b', 8, 9.5), s('c', 9, 10.5), s('d', 7, 9)],
      10, 'd', 7
    );
    for (const slot of out) {
      expect(slot.start).toBeGreaterThanOrEqual(7 - 0.001);
      expect(slot.end).toBeLessThanOrEqual(10 + 0.001);
    }
  });

  test('endHour 24: los slots llegan a 24:00 sin pasarse', () => {
    const out = resolveDayCascade([s('a', 22, 23.5), s('b', 23, 24.5)], 24, 'b', 7);
    for (const slot of out) {
      expect(slot.end).toBeLessThanOrEqual(24.001);
    }
  });

  test('minutos enteros: sin 09:60 por flotantes (9.999h)', () => {
    const out = resolveDayCascade([s('a', 9, 9.999), s('b', 10, 11)], 22, 'b', 7);
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

  test('mover trabajo1 a sábado 8:00: mitad superior → sube pegado, desayuno intacto', () => {
    const res = propagateWeekly(acts, 'trabajo1', 8, 22, codec, [5]);
    // Centro del drop (8:45) en la mitad superior del desayuno (9:00-9:30)
    // → trabajo1 sube pegado 7:30-9:00 y el desayuno NO se mueve.
    expect(res.times.get('trabajo1')!.start).toBeCloseTo(7.5, 3);
    expect(res.times.get('desayuno')!.start).toBe(9);
    for (let d = 0; d < 7; d++) {
      const slots = acts
        .filter(a => (a.id === 'trabajo1' ? [4, 5].includes(d) : a.daysOfWeek.includes(d)))
        .map(a => res.times.get(a.id!)!)
        .sort((x, y) => x.start - y.start);
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].start).toBeGreaterThanOrEqual(slots[i - 1].end - 0.001);
      }
    }
    // Rutina, lejos de la colisión, intacta.
    expect(res.times.get('rutina')!.start).toBe(10.75);
  });

  test('mitad inferior en el destino: el arrastrado queda debajo del pisado', () => {
    const res = propagateWeekly(acts, 'trabajo1', 9, 22, codec, [5]);
    const sab = res.byDay.get(5)!;
    // Centro del drop (9:45) en la mitad inferior del desayuno (9:00-9:30)
    // → trabajo1 baja pegado 9:30-11:00; desayuno intacto.
    expect(sab.get('trabajo1')!.start).toBe(9.5);
    expect(sab.get('desayuno')!.start).toBe(9);
    expect(sab.get('desayuno')!.end).toBe(9.5);
  });

  test('la propagación cierra transitivamente: vecinos afectados re-resuelven sus otros días', () => {
    const res = propagateWeekly(acts, 'desayuno', 9.25, 22, codec, [0, 1, 2, 3, 4, 5, 6]);
    const lunes = res.byDay.get(1)!;
    // Mitad superior del trabajo1 (9:15-10:45 = 9.25-10.75) → desayuno sube
    // pegado 8:45-9:15 (8.75-9.25).
    expect(lunes.get('desayuno')!.end).toBeCloseTo(9.25, 3);
    expect(lunes.get('trabajo1')!.start).toBe(9.25);
  });

  test('drag entre columnas: mineDays sin el origen (quita lunes, agrega sábado)', () => {
    const res = propagateWeekly(acts, 'trabajo1', 12, 22, codec, [4, 5]);
    const t = res.times.get('trabajo1')!;
    expect(t.start).toBe(12);
    expect(t.end).toBe(13.5);
  });

  test('resize multi-día (keepPlace): misma duración en todos los días, inicio intacto', () => {
    // Estirar Rutina (10:45-11:45) a 1.5h: en TODOS sus días conserva 10:45 y
    // empuja solo lo que pisa; el desayuno (9:00-9:30) no se entera.
    const res = propagateWeekly(acts, 'rutina', 10.75, 22, codec, [4, 5, 6], 1.5, 0, true);
    expect(res.times.get('rutina')!.start).toBe(10.75);
    expect(res.times.get('rutina')!.end).toBeCloseTo(12.25, 3);
    // El push del vecino solo si no rompe sus otros días (protección ex-C3).
    for (const d of [4, 5, 6]) {
      const day = res.byDay.get(d)!;
      expect(day.get('rutina')!.start).toBe(10.75);
    }
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

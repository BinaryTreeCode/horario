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

describe('resolveDayCascade', () => {
  test('sin colisiones, no toca nada', () => {
    const out = resolveDayCascade([s('a', 7, 8), s('b', 9, 10)], 22, undefined, 7);
    expect(out).toEqual([s('a', 7, 8), s('b', 9, 10)]);
  });

  test('push-down preserva duración', () => {
    const out = resolveDayCascade([s('a', 7, 8), s('b', 7.5, 9)], 22, undefined, 7);
    const b = out.find(x => x.id === 'b')!;
    expect(b.start).toBe(8);
    expect(b.end).toBe(9.5);
  });

  test('empate con pin: la existente se empuja, no se solapa', () => {
    // Drop a las 9:00 exacto (encima de b): la pared (dragged) va primero
    const out = resolveDayCascade([s('b', 9, 10), s('dragged', 9, 10.5)], 22, 'dragged', 7);
    const b = out.find(x => x.id === 'b')!;
    const d = out.find(x => x.id === 'dragged')!;
    expect(d.start).toBe(9);
    expect(b.start).toBeGreaterThanOrEqual(10.5 - 0.001); // empujada después de la pared
  });

  test('la pared (pin) nunca se mueve ni se recorta', () => {
    const out = resolveDayCascade([s('a', 7, 8), s('dragged', 8, 10), s('c', 9, 11)], 22, 'dragged', 7);
    const d = out.find(x => x.id === 'dragged')!;
    expect(d.start).toBe(8);
    expect(d.end).toBe(10);
  });

  test('día lleno: nada sale por debajo de startHour (A2)', () => {
    // 7:00–10:00 con 3.5h de actividades: la compresión no puede crear 06:30
    const out = resolveDayCascade(
      [s('a', 7, 8.5), s('b', 8, 9.5), s('c', 9, 10.5), s('dragged', 7, 9)],
      10, 'dragged', 7
    );
    for (const slot of out) {
      expect(slot.start).toBeGreaterThanOrEqual(7 - 0.001);
      expect(slot.end).toBeLessThanOrEqual(10 + 0.001);
    }
  });

  test('endHour 24: los slots llegan a 24:00 sin pasarse', () => {
    const out = resolveDayCascade([s('a', 22, 23.5), s('b', 23, 24.5)], 24, undefined, 7);
    for (const slot of out) {
      expect(slot.end).toBeLessThanOrEqual(24.001);
    }
  });

  test('minutos enteros: sin 09:60 por flotantes (9.999h)', () => {
    // Duración con flotante feo: 9:00 → 10:59.94
    const out = resolveDayCascade([s('a', 9, 9.999), s('b', 10, 11)], 22, undefined, 7);
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
    // Una fila = un horario: el push es global (opción 2 elegida) y el cierre
    // garantiza que TODOS los días quedan resueltos — eso es lo opuesto a la
    // corrupción ex-C3 (solapes heredados que nadie calculó).
    expect(res.times.get('desayuno')!.start).toBeCloseTo(9.5, 3);
    // Aserción fuerte: ningún par de actividades se solapa en NINGÚN día.
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
    // trabajo1 a las 9:00-10:30 empuja desayuno (9:00-9:30) a 10:30-11:00
    expect(sab.get('trabajo1')!.start).toBe(9);
    expect(sab.get('desayuno')!.start).toBeCloseTo(10.5, 3);
    expect(sab.get('desayuno')!.end).toBeCloseTo(11, 3);
  });

  test('la propagación cierra transitivamente: vecinos afectados re-resuelven sus otros días', () => {
    // Desayuno (todos los días) a las 9:15: colisiona con trabajo1 (9:15) en L-V.
    // El push cambia trabajo1, lo que afecta SUS días → iteración extra.
    const res = propagateWeekly(acts, 'desayuno', 9.25, 22, codec, [0, 1, 2, 3, 4, 5, 6]);
    const lunes = res.byDay.get(1)!;
    const t1 = lunes.get('trabajo1')!;
    expect(t1.start).toBeGreaterThanOrEqual(9.5 - 0.001); // empujado después del desayuno
  });

  test('drag entre columnas: mineDays sin el origen (quita lunes, agrega sábado)', () => {
    const res = propagateWeekly(acts, 'trabajo1', 12, 22, codec, [4, 5]);
    // El horario global final es único (una fila = un horario)
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

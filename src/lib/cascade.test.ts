import { describe, test, expect } from 'bun:test';
import { planMover, planResize, chocaEnOtrosDias, finDe, snapMin, type Bloque } from './cascade';

/** Día de pruebas: 6:00 (360) a 24:00 (1440), snap 15. */
const MIN = 360, MAX = 1440, SNAP = 15;
const b = (id: string, inicio: number, duracion: number): Bloque => ({ id, inicio, duracion });

describe('planMover — regla 1: a hueco libre se coloca', () => {
  test('cae en el hueco y respeta sus límites aunque el dedo se pase', () => {
    // a 8:00-9:30, hueco 9:30-12:00, r 12:00-13:00. Dedo 11:50 con agarre
    // 10 min → deseado 11:40 → clampa al fin del hueco menos duración: 11:00.
    const otros = [b('a', 480, 90), b('r', 720, 60)];
    const p = planMover([...otros, b('x', 900, 60)], otros, true, 'x', b('x', 900, 60), 710, 10, MIN, MAX, SNAP);
    expect(p.valido).toBe(true);
    expect(p.motivo).toBe('');
    expect(p.bb.inicio).toBe(660); // 11:00-12:00, pegado al vecino r
    expect(finDe(p.bb)).toBeLessThanOrEqual(720);
  });

  test('hueco más chico que el bloque: inválido, ghost libre clampado al día', () => {
    // a 8-10, hueco 10-10:45, r 10:45-12; bloque de 1h: NO cabe. La propuesta
    // queda donde el dedo pide (solo clamp al día): es el ghost rojo.
    const otros = [b('a', 480, 120), b('r', 645, 75)];
    const p = planMover([...otros, b('x', 900, 60)], otros, true, 'x', b('x', 900, 60), 630, 0, MIN, MAX, SNAP);
    expect(p.valido).toBe(false);
    expect(p.motivo).toBe('⛔ No cabe en este hueco');
    expect(p.bb.inicio).toBe(630);
  });

  test('mismo día: el arrastrado entra al hueco elegido', () => {
    const arr = [b('a', 480, 60), b('x', 900, 30), b('r', 990, 60)];
    const p = planMover(arr, arr, true, 'x', b('x', 900, 30), 540, 0, MIN, MAX, SNAP);
    expect(p.valido).toBe(true);
    expect(p.destino.find(x => x.id === 'x')!.inicio).toBe(540); // 9:00
  });

  test('entre días: el origen pierde el bloque, el destino lo gana', () => {
    const lunes = [b('a', 480, 60), b('x', 900, 60)];
    const martes = [b('r', 600, 120)]; // hueco 6:00-10:00
    const p = planMover(lunes, martes, false, 'x', b('x', 900, 60), 480, 0, MIN, MAX, SNAP);
    expect(p.origen.some(x => x.id === 'x')).toBe(false);
    expect(p.destino.map(x => x.id).sort()).toEqual(['r', 'x']);
    expect(p.destino.find(x => x.id === 'x')!.inicio).toBe(480);
  });
});

describe('planMover — regla 2: encima de otro bloque es ⛔', () => {
  test('punto de suelta dentro de un vecino: inválido con motivo explícito', () => {
    const otros = [b('a', 480, 120), b('r', 720, 60)];
    const p = planMover([...otros, b('x', 990, 60)], otros, true, 'x', b('x', 990, 60), 750, 0, MIN, MAX, SNAP);
    expect(p.valido).toBe(false);
    expect(p.motivo).toBe('⛔ Encima de otro bloque');
  });

  test('borde exacto del vecino (su fin) NO cuenta como encima', () => {
    const otros = [b('a', 480, 60)];
    const p = planMover([...otros, b('x', 900, 30)], otros, true, 'x', b('x', 900, 30), 540, 0, MIN, MAX, SNAP);
    expect(p.valido).toBe(true);
  });
});

describe('planResize — regla 3: usa el hueco y empuja vecinos', () => {
  test('estirar hacia abajo empuja la cadena preservando duraciones', () => {
    // e 9:00-10:00, r 13:00-14:00, c 14:00-15:00. Dedo 13:30: e crece hasta
    // 13:30 y empuja a r (13:30-14:30) y a c (14:30-15:30).
    const arr = [b('e', 540, 60), b('r', 780, 60), b('c', 840, 60)];
    const p = planResize(arr, 'e', 'abajo', 810, MIN, MAX, SNAP);
    const e = p.bloques.find(x => x.id === 'e')!;
    const r = p.bloques.find(x => x.id === 'r')!;
    const c = p.bloques.find(x => x.id === 'c')!;
    expect(e.inicio).toBe(540);
    expect(e.duracion).toBe(270); // 9:00-13:30
    expect(r.inicio).toBe(810);
    expect(r.duracion).toBe(60);
    expect(c.inicio).toBe(870);
    expect(c.duracion).toBe(60);
  });

  test('si el dedo para antes del vecino, nadie se mueve', () => {
    const arr = [b('e', 540, 60), b('r', 780, 60), b('c', 840, 60)];
    const p = planResize(arr, 'e', 'abajo', 690, MIN, MAX, SNAP); // 11:30
    const r = p.bloques.find(x => x.id === 'r')!;
    expect(r.inicio).toBe(780);
  });

  test('estirar hacia arriba sube el inicio y empuja a los de arriba', () => {
    // t 8:00-9:30, e 10:00-11:00. Dedo 8:30: e sube a 8:30 (150 min) y t
    // termina empujado a 7:00-8:30.
    const arr = [b('t', 480, 90), b('e', 600, 60)];
    const p = planResize(arr, 'e', 'arriba', 510, MIN, MAX, SNAP);
    const e = p.bloques.find(x => x.id === 'e')!;
    const t = p.bloques.find(x => x.id === 't')!;
    expect(e.inicio).toBe(510);
    expect(e.duracion).toBe(150); // 8:30-11:00
    expect(t.inicio).toBe(420);
    expect(t.duracion).toBe(90);
  });

  test('recoger (encoger) no toca a los vecinos', () => {
    const arr = [b('e', 540, 240), b('r', 780, 60)];
    const p = planResize(arr, 'e', 'abajo', 600, MIN, MAX, SNAP); // encoger a 1h
    const r = p.bloques.find(x => x.id === 'r')!;
    expect(r.inicio).toBe(780);
  });

  test('entrada DESORDENADA: la cadena empuja por posición, no por orden de BD', () => {
    // Mismo escenario del test de cadena pero con el orden que devuelve la BD
    // (arbitrario). Sin el sort interno, el empuje tocaba bloques equivocados.
    const arr = [b('c', 840, 60), b('e', 540, 60), b('r', 780, 60)];
    const p = planResize(arr, 'e', 'abajo', 870, MIN, MAX, SNAP); // dedo 14:30
    const e = p.bloques.find(x => x.id === 'e')!;
    const r = p.bloques.find(x => x.id === 'r')!;
    const c = p.bloques.find(x => x.id === 'c')!;
    expect(e.duracion).toBe(330); // 9:00-14:30
    expect(r.inicio).toBe(870);
    expect(c.inicio).toBe(930);
  });
});

describe('planResize — regla 4: el límite del día corta', () => {
  test('sin espacio libre no crece más allá del hueco real', () => {
    // Día 16-22: c 20-21, l 21-22. Dedo en 23:00 → c no pasa de 21:00.
    const arr = [b('c', 1200, 60), b('l', 1260, 60)];
    const p = planResize(arr, 'c', 'abajo', 1380, 960, 1320, SNAP);
    const c = p.bloques.find(x => x.id === 'c')!;
    expect(finDe(c)).toBe(1260);
    expect(p.bloques.every(x => finDe(x) <= 1320)).toBe(true);
  });

  test('estirar hacia arriba crece hasta el límite del día con el fin fijo', () => {
    const arr = [b('x', 480, 60)];
    const p = planResize(arr, 'x', 'arriba', 0, 360, 1440, SNAP); // dedo 00:00
    // El fin (9:00) queda fijo; crece hacia arriba llenando el hueco libre
    // (120 min) hasta el inicio del día: 6:00-9:00 = 180 min.
    expect(p.bloques[0].inicio).toBe(360);
    expect(p.bloques[0].duracion).toBe(180);
  });
});

describe('chocaEnOtrosDias — ex-C3 para la plantilla multi-día', () => {
  test('detecta si el nuevo horario pisa en otro día del bloque', () => {
    const martes = [b('w', 490, 30)];
    expect(chocaEnOtrosDias([b('n', 480, 60)], 'n', [martes])).toBe(true);
    // Si en el otro día el hueco es libre, no hay choque.
    const martesLibre = [b('w', 600, 30)];
    expect(chocaEnOtrosDias([b('n', 480, 60)], 'n', [martesLibre])).toBe(false);
  });

  test('el propio bloque movido no se cuenta a sí mismo', () => {
    expect(chocaEnOtrosDias([b('n', 480, 60)], 'n', [[b('n', 900, 30)]])).toBe(false);
  });
});

describe('utilidades', () => {
  test('snapMin redondea al múltiplo más cercano', () => {
    expect(snapMin(607, 15)).toBe(600);
    expect(snapMin(616, 15)).toBe(615);
    expect(snapMin(623, 15)).toBe(630);
  });
});

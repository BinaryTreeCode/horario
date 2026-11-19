import { describe, expect, test } from 'bun:test';
import { actualizarDireccion, calcularPasoAutoScroll, contraElGesto } from './dragEngine';

/**
 * El auto-scroll de bordes es geometría pura: este test fija el contrato de
 * `calcularPasoAutoScroll` (franjas, intersección visible y carril mínimo)
 * sin depender de un navegador. La lógica de cuándo se aplica (scroller real
 * vs. página) vive en `edgeTick` y se verifica en Playwright.
 */
describe('calcularPasoAutoScroll', () => {
  const EDGE = 56;
  const SPEED = 12;

  test('en el centro no desplaza', () => {
    expect(calcularPasoAutoScroll(400, 0, 800)).toBe(0);
  });

  test('en la franja de inicio sube/retrocede', () => {
    expect(calcularPasoAutoScroll(10, 0, 800)).toBe(-SPEED);
    expect(calcularPasoAutoScroll(EDGE - 1, 0, 800)).toBe(-SPEED);
  });

  test('en la franja del final baja/avanza', () => {
    expect(calcularPasoAutoScroll(790, 0, 800)).toBe(SPEED);
    expect(calcularPasoAutoScroll(800 - EDGE + 1, 0, 800)).toBe(SPEED);
  });

  test('justo en el borde de la franja no desplaza', () => {
    expect(calcularPasoAutoScroll(EDGE, 0, 800)).toBe(0);
    expect(calcularPasoAutoScroll(800 - EDGE, 0, 800)).toBe(0);
  });

  test('la franja se mide sobre la intersección VISIBLE, no sobre el rect completo', () => {
    // Vista Día: el contenedor va de 1946 a 3546 (se sale por abajo) y el
    // viewport termina en 568. Con el rect completo, y=540 jamás estaría en
    // la franja de los últimos 56px; con la intersección visible sí.
    const min = 0;
    const max = 568;
    expect(calcularPasoAutoScroll(540, min, max)).toBe(SPEED);
    expect(calcularPasoAutoScroll(500, min, max)).toBe(0); // 512 = borde de la franja
    expect(calcularPasoAutoScroll(280, min, max)).toBe(0);
  });

  test('carril visible menor a dos franjas no desplaza (no hay zona central)', () => {
    expect(calcularPasoAutoScroll(50, 0, EDGE * 2)).toBe(0);
    expect(calcularPasoAutoScroll(10, 0, 100)).toBe(0);
  });

  test('acepta franja y velocidad personalizadas', () => {
    expect(calcularPasoAutoScroll(10, 0, 800, 20, 4)).toBe(-4);
    expect(calcularPasoAutoScroll(790, 0, 800, 20, 4)).toBe(4);
  });
});

/**
 * El filtro que impide que el auto-scroll pelee con el dedo: arrastrar el asa
 * lateral hacia adentro mientras el borde derecho de la grilla scrollea movía
 * el contenido justo al revés y el gesto se anulaba solo.
 */
describe('contraElGesto', () => {
  test('mismo sentido que el dedo: se permite', () => {
    expect(contraElGesto(12, 1)).toBe(false);
    expect(contraElGesto(-12, -1)).toBe(false);
  });

  test('sentido opuesto: se veta', () => {
    expect(contraElGesto(12, -1)).toBe(true);
    expect(contraElGesto(-12, 1)).toBe(true);
  });

  test('sin movimiento previo o sin paso no hay veto', () => {
    expect(contraElGesto(12, 0)).toBe(false);
    expect(contraElGesto(0, -1)).toBe(false);
    expect(contraElGesto(0, 0)).toBe(false);
  });
});

describe('actualizarDireccion', () => {
  test('un desvío vertical puro (dx === 0) conserva dirX para contraElGesto', () => {
    const dir = { dirX: 0, dirY: 0 };
    actualizarDireccion(dir, -6, 0);
    expect(dir.dirX).toBe(-1);
    expect(contraElGesto(12, dir.dirX)).toBe(true);

    // Desvío vertical de 1px sin movimiento horizontal: no debe borrar dirX.
    actualizarDireccion(dir, 0, 1);
    expect(dir.dirX).toBe(-1);
    expect(dir.dirY).toBe(1);
    expect(contraElGesto(12, dir.dirX)).toBe(true);
  });

  test('un desvío horizontal puro (dy === 0) conserva dirY', () => {
    const dir = { dirX: 0, dirY: 0 };
    actualizarDireccion(dir, 0, -4);
    actualizarDireccion(dir, 3, 0);
    expect(dir.dirX).toBe(1);
    expect(dir.dirY).toBe(-1);
  });

  test('dx === 0 y dy === 0 mantiene ambos sentidos intactos', () => {
    const dir = { dirX: 1, dirY: -1 };
    actualizarDireccion(dir, 0, 0);
    expect(dir).toEqual({ dirX: 1, dirY: -1 });
  });
});

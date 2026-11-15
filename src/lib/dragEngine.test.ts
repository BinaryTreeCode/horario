import { describe, expect, test } from 'bun:test';
import { calcularPasoAutoScroll } from './dragEngine';

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

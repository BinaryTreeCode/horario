import { describe, test, expect } from 'bun:test';
import { paletaSugerida, colorSugerido, SUGERENCIAS } from './paletaCategorias';

describe('paletaCategorias: sugerencia al crear', () => {
  test('sin categorías, la primera sugerencia es el primer color curado', () => {
    expect(colorSugerido([])).toBe('#55854f');
    expect(paletaSugerida([]).length).toBe(SUGERENCIAS);
  });

  test('no sugiere un color que ya está en uso', () => {
    const sugerencias = paletaSugerida(['#55854f']);
    expect(sugerencias).not.toContain('#55854f');
  });

  test('no sugiere un color que se lee como uno en uso (mismo matiz)', () => {
    // Mismo verde con luminosidad cercana: en la grilla es "el mismo color".
    const sugerencias = paletaSugerida(['#4a7c44']);
    expect(sugerencias).not.toContain('#55854f');
  });

  test('cada creación consume un color: la siguiente sugerencia es otra', () => {
    const usados: string[] = [];
    const creados: string[] = [];
    for (let i = 0; i < 5; i++) {
      const color = colorSugerido(usados);
      creados.push(color);
      usados.push(color);
    }
    expect(new Set(creados).size).toBe(creados.length);
  });

  test('la franja tiene siempre el mismo tamaño, aunque se agote la paleta curada', () => {
    // Los diez colores curados en uso: la franja se completa con
    // matices generados y nunca devuelve menos sugerencias.
    const todos = ['#55854f', '#8d6235', '#2a3752', '#3e9c9a', '#6cc28a', '#7fb2da', '#7b5ea7', '#d98a3a', '#b0526b', '#5d8aa8'];
    const sugerencias = paletaSugerida(todos);
    expect(sugerencias.length).toBe(SUGERENCIAS);
    expect(new Set(sugerencias).size).toBe(SUGERENCIAS);
  });

  test('con categorías de todos los matices, sigue sugiriendo (nunca se cuelga)', () => {
    // Matices cada 30° cubren el círculo: el filtro estricto no
    // da ninguno y el relajado tiene que rescatar la franja.
    const usados: string[] = [];
    for (let h = 0; h < 360; h += 30) {
      usados.push(`#${Math.round(Math.sin(h) * 127 + 128).toString(16).padStart(2, '0')}88${Math.round(Math.cos(h) * 127 + 128).toString(16).padStart(2, '0')}`);
    }
    expect(paletaSugerida(usados).length).toBe(SUGERENCIAS);
  });

  test('ignora entradas vacías (categoría sin color no bloquea la paleta)', () => {
    expect(paletaSugerida(['', undefined as unknown as string]).length).toBe(SUGERENCIAS);
  });

  test('es determinista: la misma entrada da la misma paleta', () => {
    const a = paletaSugerida(['#1a2a44', '#8b5a2b']);
    const b = paletaSugerida(['#1a2a44', '#8b5a2b']);
    expect(a).toEqual(b);
  });
});

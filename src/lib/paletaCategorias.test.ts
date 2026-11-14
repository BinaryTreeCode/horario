import { describe, test, expect } from 'bun:test';
import {
  paletaSugerida,
  colorSugerido,
  SUGERENCIAS,
  hexAHsl,
  hslAHex,
  generarArmonia,
  armonizarCategorias,
  PALETAS_TEMATICAS
} from './paletaCategorias';

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
    const todos = ['#55854f', '#8d6235', '#2a3752', '#3e9c9a', '#6cc28a', '#7fb2da', '#7b5ea7', '#d98a3a', '#b0526b', '#5d8aa8'];
    const sugerencias = paletaSugerida(todos);
    expect(sugerencias.length).toBe(SUGERENCIAS);
    expect(new Set(sugerencias).size).toBe(SUGERENCIAS);
  });

  test('con categorías de todos los matices, sigue sugiriendo (nunca se cuelga)', () => {
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

describe('paletaCategorias: conversión HSL y HEX', () => {
  test('hexAHsl convierte colores conocidos', () => {
    const [h, s, l] = hexAHsl('#ff0000');
    expect(h).toBe(0);
    expect(s).toBe(100);
    expect(l).toBe(50);
  });

  test('hslAHex devuelve string hexadecimal #rrggbb válido de 7 caracteres', () => {
    const hex = hslAHex(120, 100, 50);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
    expect(hex.toLowerCase()).toBe('#00ff00');
  });

  test('roundtrip hex -> hsl -> hex mantiene el color', () => {
    const original = '#55854f';
    const [h, s, l] = hexAHsl(original);
    const vuelto = hslAHex(h, s, l);
    // Pueden variar levemente por redondeo de enteros en porcentajes
    const [h2, s2, l2] = hexAHsl(vuelto);
    expect(Math.abs(h - h2)).toBeLessThanOrEqual(2);
    expect(Math.abs(s - s2)).toBeLessThanOrEqual(2);
    expect(Math.abs(l - l2)).toBeLessThanOrEqual(2);
  });
});

describe('paletaCategorias: generador de armonías cromáticas', () => {
  const base = '#2d5a27'; // verde bosque

  test('análoga genera la cantidad pedida con matices cercanos', () => {
    const armonia = generarArmonia(base, 'analoga', 5);
    expect(armonia.length).toBe(5);
    for (const c of armonia) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // Todos los colores deben estar a menos de 60° del base
    const [hBase] = hexAHsl(base);
    for (const c of armonia) {
      const [h] = hexAHsl(c);
      const diff = Math.abs(h - hBase) % 360;
      const dist = diff > 180 ? 360 - diff : diff;
      expect(dist).toBeLessThanOrEqual(60);
    }
  });

  test('monocromática mantiene el mismo matiz pero varía luminosidad', () => {
    const armonia = generarArmonia(base, 'monocromatica', 4);
    expect(armonia.length).toBe(4);
    const [hBase] = hexAHsl(base);
    for (const c of armonia) {
      const [h] = hexAHsl(c);
      expect(Math.abs(h - hBase)).toBeLessThanOrEqual(1);
    }
    // Las luminosidades deben ser crecientes o distintas
    const luminosidades = armonia.map(c => hexAHsl(c)[2]);
    expect(luminosidades[0]).toBeLessThan(luminosidades[luminosidades.length - 1]);
  });

  test('complementaria incluye matices opuestos', () => {
    const armonia = generarArmonia(base, 'complementaria', 4);
    expect(armonia.length).toBe(4);
    const [hBase] = hexAHsl(base);
    // El segundo elemento debe ser el complementario (~180°)
    const [hComp] = hexAHsl(armonia[1]);
    const diff = Math.abs(hComp - hBase) % 360;
    const dist = diff > 180 ? 360 - diff : diff;
    expect(Math.abs(dist - 180)).toBeLessThanOrEqual(5);
  });

  test('tríada genera colores espaciados en 120°', () => {
    const armonia = generarArmonia(base, 'triada', 3);
    expect(armonia.length).toBe(3);
    const [h0] = hexAHsl(armonia[0]);
    const [h1] = hexAHsl(armonia[1]);
    const [h2] = hexAHsl(armonia[2]);

    const dist01 = (Math.abs(h1 - h0) % 360);
    const min01 = dist01 > 180 ? 360 - dist01 : dist01;
    expect(Math.abs(min01 - 120)).toBeLessThanOrEqual(5);

    const dist02 = (Math.abs(h2 - h0) % 360);
    const min02 = dist02 > 180 ? 360 - dist02 : dist02;
    expect(Math.abs(min02 - 120)).toBeLessThanOrEqual(5);
  });

  test('equidistante distribuye uniformemente en 360°', () => {
    const armonia = generarArmonia(base, 'equidistante', 6);
    expect(armonia.length).toBe(6);
    // Cada paso debe ser ~60°
    for (let i = 1; i < armonia.length; i++) {
      const [hPrev] = hexAHsl(armonia[i - 1]);
      const [hCurr] = hexAHsl(armonia[i]);
      const diff = (hCurr - hPrev + 360) % 360;
      expect(Math.abs(diff - 60)).toBeLessThanOrEqual(2);
    }
  });
});

describe('paletaCategorias: armonizarCategorias', () => {
  const cats = [
    { id: 'cat-1', label: 'Trabajo', color: '#111111' },
    { id: 'cat-2', label: 'Estudio', color: '#222222' },
    { id: 'cat-3', label: 'Rutina', color: '#333333' }
  ];

  test('armoniza usando un preset de la naturaleza', () => {
    const resultado = armonizarCategorias(cats, 'bosque');
    expect(resultado.length).toBe(3);
    expect(resultado[0].id).toBe('cat-1');
    expect(resultado[1].id).toBe('cat-2');
    expect(resultado[2].id).toBe('cat-3');
    // Los colores asignados vienen del preset bosque
    const preset = PALETAS_TEMATICAS.find(p => p.id === 'bosque')!;
    expect(resultado[0].color).toBe(preset.colores[0]);
    expect(resultado[1].color).toBe(preset.colores[1]);
    expect(resultado[2].color).toBe(preset.colores[2]);
  });

  test('armoniza usando una armonía cromática con pivote explícito', () => {
    const resultado = armonizarCategorias(cats, 'triada', '#ff5722');
    expect(resultado.length).toBe(3);
    expect(new Set(resultado.map(r => r.color)).size).toBe(3);
  });

  test('lista vacía devuelve lista vacía sin fallar', () => {
    expect(armonizarCategorias([], 'oceano')).toEqual([]);
  });
});

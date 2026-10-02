import { describe, test, expect } from 'bun:test';
import { desProxy, esEstructurable, desProxyVerificado } from './snapshot';

describe('desProxy', () => {
  test('copia en profundidad: el resultado no comparte referencias con el original', () => {
    const original = { id: 'a', steps: [{ id: 's1', title: 'x' }], tags: ['uno'] };
    const copia = desProxy(original);

    expect(copia).toEqual(original);
    expect(copia).not.toBe(original);
    expect(copia.steps).not.toBe(original.steps);
    expect(copia.steps[0]).not.toBe(original.steps[0]);
    expect(copia.tags).not.toBe(original.tags);
  });

  test('las mutaciones del original no alcanzan la copia', () => {
    const original = { id: 'a', steps: [{ id: 's1', title: 'x' }] };
    const copia = desProxy(original);

    original.steps[0].title = 'cambiado';
    original.steps.push({ id: 's2', title: 'nuevo' });

    expect(copia.steps).toHaveLength(1);
    expect(copia.steps[0].title).toBe('x');
  });

  // Esta es la razón de existir del módulo: un proxy de $state no se puede
  // structured-clonar, y db.put() justamente usa structured clone.
  test('neutraliza proxies que structuredClone rechazaría', () => {
    const proxificado = new Proxy(
      { id: 'a', steps: new Proxy([{ id: 's1', title: 'x' }], {}) },
      {},
    );

    expect(esEstructurable(proxificado)).toBe(false);

    const limpio = desProxy(proxificado);
    expect(esEstructurable(limpio)).toBe(true);
    expect(limpio.id).toBe('a');
    expect(limpio.steps[0].title).toBe('x');
  });

  test('no se cuelga con ciclos', () => {
    const ciclico: Record<string, unknown> = { id: 'a' };
    ciclico.self = ciclico;

    const copia = desProxy(ciclico);
    expect(copia.id).toBe('a');
  });

  test('preserva Date, Map y Set', () => {
    const original = {
      when: new Date(1700000000000),
      mapa: new Map([['k', { n: 1 }]]),
      set: new Set([1, 2]),
    };
    const copia = desProxy(original);

    expect(copia.when.getTime()).toBe(1700000000000);
    expect(copia.when).not.toBe(original.when);
    expect(copia.mapa.get('k')).toEqual({ n: 1 });
    expect(copia.set.has(2)).toBe(true);
  });

  test('deja pasar los valores primitivos tal cual', () => {
    expect(desProxy(undefined)).toBeUndefined();
    expect(desProxy(null)).toBeNull();
    expect(desProxy(42)).toBe(42);
    expect(desProxy('texto')).toBe('texto');
  });
});

describe('esEstructurable', () => {
  test('acepta datos planos y rechaza proxies y funciones', () => {
    expect(esEstructurable({ a: 1, b: [1, 2] })).toBe(true);
    expect(esEstructurable(new Proxy({}, {}))).toBe(false);
    expect(esEstructurable(() => 1)).toBe(false);
  });

  // Documenta por qué el blindaje anterior era inútil: Array.isArray
  // devuelve true también para un proxy de array.
  test('Array.isArray no detecta proxies, por eso no servía como comprobación', () => {
    const proxyDeArray = new Proxy([], {});
    expect(Array.isArray(proxyDeArray)).toBe(true);
    expect(esEstructurable(proxyDeArray)).toBe(false);
  });
});

describe('desProxyVerificado', () => {
  test('devuelve datos planos cuando la entrada es un proxy', () => {
    const limpio = desProxyVerificado(new Proxy({ id: 'a', steps: [] }, {}), 'la actividad');
    expect(esEstructurable(limpio)).toBe(true);
    expect(limpio.id).toBe('a');
  });

  test('lanza un error legible cuando el valor sigue sin ser clonable', () => {
    const conFuncion = { id: 'a', when: { run: () => 1 } };
    expect(() => desProxyVerificado(conFuncion, 'la actividad')).toThrow(
      /no se puede guardar la actividad/i,
    );
  });
});
import { describe, test, expect } from 'bun:test';
import { resolverTema, esTemaValido, type Tema } from './tema';

/**
 * El tema tiene tres preferencias pero solo dos se pintan. La resolucion
 * (preferencia + preferencia del SO -> tema efectivo) es pura a proposito:
 * es lo que decide si <html> queda en data-tema="claro" u "oscuro", y ese
 * atributo es lo unico que el CSS mira. Si esta funcion se rompe, el bug
 * visible es "el boton dice Oscuro y la pantalla sigue clara" (o al reves),
 * que es justo lo que no se nota en un test de UI.
 */
describe('resolverTema', () => {
  test('una preferencia explicita gana siempre, diga lo que diga el SO', () => {
    expect(resolverTema('oscuro', false)).toBe('oscuro');
    expect(resolverTema('oscuro', true)).toBe('oscuro');
    expect(resolverTema('claro', false)).toBe('claro');
    expect(resolverTema('claro', true)).toBe('claro');
  });

  test('"sistema" sigue al SO en las dos direcciones', () => {
    expect(resolverTema('sistema', true)).toBe('oscuro');
    expect(resolverTema('sistema', false)).toBe('claro');
  });

  test('sin preferencia del SO (entorno sin matchMedia) queda en claro', () => {
    expect(resolverTema('sistema', false)).toBe('claro');
  });
});

describe('esTemaValido', () => {
  test('acepta solo las tres preferencias del catalogo', () => {
    for (const v of ['claro', 'oscuro', 'sistema'] as Tema[]) {
      expect(esTemaValido(v)).toBe(true);
    }
  });

  // La fila de settings puede venir de una mano ajena (archivo importado de
  // otra version, editada a mano, o sync de un cliente viejo). Si un valor
  // raro llegara al atributo, la app quedaria sin paleta: por eso la
  // validacion es parte del arranque, no una confianza.
  test('rechaza basura sin tirar excepcion', () => {
    for (const v of [undefined, null, '', 'dark', 'Dark', 'noche', 0, 1, true, {}, []]) {
      expect(esTemaValido(v)).toBe(false);
    }
  });
});
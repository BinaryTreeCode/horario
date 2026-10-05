import { describe, test, expect } from 'bun:test';
import { resolverTema, esTemaValido, temaOpuesto, type Tema, type TemaEfectivo } from './tema';

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

/**
 * El interruptor del header tiene una sola regla: cada pulsación cambia de
 * verdad lo que se ve. Se decide sobre el tema EFECTIVO, no sobre la
 * preferencia, asi que con la preferencia en "sistema" (el estado por defecto
 * de una instalacion nueva) tambien cambia: si en vez de mirar la preferencia
 * devolviera "sistema" para "sistema", el boton no haria nada y el usuario
 * concluiria que esta roto.
 */
describe('temaOpuesto', () => {
  test('siempre devuelve el contrario del tema que se ve', () => {
    expect(temaOpuesto('claro')).toBe('oscuro');
    expect(temaOpuesto('oscuro')).toBe('claro');
  });

  test('nunca devuelve "sistema": el atajo sale de el, no vuelve a el', () => {
    // Dos pulsaciones seguidas vuelven al punto de partida, que es lo que hace
    // util un interruptor binario.
    for (const inicial of ['claro', 'oscuro'] as TemaEfectivo[]) {
      const ida = temaOpuesto(inicial);
      expect(ida, 'el atajo tiene que fijar un tema concreto').not.toBe('sistema');
      expect(temaOpuesto(ida)).toBe(inicial);
    }
  });

  test('con la preferencia en "sistema" el atajo respeta lo que se ve', () => {
    // La combinacion que el usuario ve al primer uso: el SO manda y el boton
    // propone lo contrario de la pantalla, no "sistema" ni el orden de un ciclo.
    expect(temaOpuesto(resolverTema('sistema', false))).toBe('oscuro');
    expect(temaOpuesto(resolverTema('sistema', true))).toBe('claro');
  });
});
import { describe, it, expect } from 'bun:test';
import { esSemilla, seleccionables, cursorPushTras, cursorPull } from './sync';

// La sincronización entre dispositivos se decide en tres cálculos puros: qué
// filas viajan, hasta dónde avanza el cursor del push y dónde queda el del
// pull. Los tres estaban mal y ninguno se podía probar sin IndexedDB: ahora
// son funciones puras con contrato explícito.

describe('esSemilla', () => {
  it('trata updatedAt 0 como semilla (la app la puso, no el usuario)', () => {
    expect(esSemilla({ updatedAt: 0 })).toBe(true);
  });

  it('trata cualquier updatedAt positivo como cambio del usuario', () => {
    expect(esSemilla({ updatedAt: 1 })).toBe(false);
    expect(esSemilla({ updatedAt: Date.now() })).toBe(false);
  });

  it('no explota con un updatedAt ausente o NaN', () => {
    // Los datos venidos de BDs viejas migrated por v4 pueden venir undefined.
    expect(esSemilla({ updatedAt: undefined as unknown as number })).toBe(true);
    expect(esSemilla({ updatedAt: NaN })).toBe(true);
  });
});

describe('seleccionables', () => {
  const filas = [
    { id: 'a', updatedAt: 0 },   // semilla: fuera
    { id: 'b', updatedAt: 100 }, // ya subida (cursor 100): fuera
    { id: 'c', updatedAt: 101 }, // nueva: sí
    { id: 'd', updatedAt: 500 },
  ];

  it('solo deja lo posterior al cursor y descarta la semilla', () => {
    expect(seleccionables(filas, 100).map(f => f.id)).toEqual(['c', 'd']);
  });

  it('con cursor 0 (dispositivo nuevo) la semilla NO sube, pero el resto sí', () => {
    // El bug: en un dispositivo recién abierto, el push de cursor 0 subía las 6
    // actividades de ejemplo con su propio UUID. Cada dispositivo metía una
    // copia en el servidor y el pull traía las de los demás como duplicados.
    expect(seleccionables(filas, 0).map(f => f.id)).toEqual(['b', 'c', 'd']);
  });

  it('el cursor es estricto: una fila con updatedAt igual al cursor ya subió', () => {
    expect(seleccionables([{ id: 'x', updatedAt: 100 }], 100)).toEqual([]);
  });

  it('no muta la entrada', () => {
    const copia = [...filas];
    seleccionables(filas, 100);
    expect(filas).toEqual(copia);
  });
});

describe('cursorPushTras', () => {
  it('nunca avanza más allá del reloj del dispositivo', () => {
    // Las filas locales se sellan con Date.now(): un cursor por delante de ese
    // reloj empuja al futuro todo lo que el usuario cree después.
    expect(cursorPushTras([{ updatedAt: 1900 }], 0, 2000)).toBe(1900);
  });

  it('se queda en el mayor updatedAt realmente enviado', () => {
    // Reenviar un lote viejo es inofensivo (el LWW del servidor es estricto);
    // saltárselo es pérdida silenciosa. Ante la duda, atrás.
    expect(cursorPushTras([{ updatedAt: 300 }, { updatedAt: 700 }], 200, 1000)).toBe(700);
  });

  it('si no se envió nada, el cursor NO avanza (reintenta en el próximo push)', () => {
    expect(cursorPushTras([], 400, 9999)).toBe(400);
  });

  it('nunca retrocede por debajo del cursor que ya había', () => {
    expect(cursorPushTras([{ updatedAt: 100 }], 800, 1000)).toBe(800);
  });

  it('aguanta un reloj local adelantado (mayor que el del servidor)', () => {
    // Reloj del móvil 5 min por delante: el cursor se queda en "ahora" y no se
    // salta nada de lo que se cree en el siguiente minuto.
    expect(cursorPushTras([{ updatedAt: 300000 }], 0, 300000)).toBe(300000);
  });

  it('una fila que LLEGÓ del servidor no congela los cambios locales', () => {
    // El bug que destapó el guard e2e: al arrancar, el pull trae filas
    // selladas por el reloj del servidor y el push de arranque las reenvía. Con
    // el servidor un minuto adelantado, "el mayor enviado" era un minuto
    // FUTURO y todo lo que el usuario creara en esa ventana no volvía a subir
    // nunca, sin error ni aviso.
    const ahora = 1_000_000;
    const filaDelServidor = { updatedAt: ahora + 60_000 };
    expect(cursorPushTras([filaDelServidor], 0, ahora)).toBe(ahora);
  });
});

describe('cursorPull', () => {
  it('retrocede el cursor para solapar lecturas', () => {
    // Un cambio remoto con updatedAt <= serverTime que el SELECT aún no veía
    // se perdía para siempre. El solape lo recupera en el siguiente pull.
    expect(cursorPull(100000, 5000)).toBe(95000);
  });

  it('con un servidor recién arrancado nunca da negativo', () => {
    expect(cursorPull(1000, 5000)).toBe(0);
  });

  it('con solape 0 deja el cursor justo en el reloj del servidor', () => {
    expect(cursorPull(100000, 0)).toBe(100000);
  });
});

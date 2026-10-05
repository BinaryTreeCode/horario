import { describe, it, expect } from 'bun:test';
import {
  esSemilla, seleccionables, cursorPushTras, cursorPull,
  acotarFechaRemota, sesgoDe, sellarParaServidor, reestampar,
} from './sync';

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

describe('acotarFechaRemota', () => {
  it('acota al reloj local la fecha de una fila que el servidor fecha en el futuro', () => {
    // Servidor 60s adelantado: sin acotar, la fila queda localmente en el
    // futuro y envenena el cursor del push siguiente.
    expect(acotarFechaRemota({ id: 'x', updatedAt: 1_060_000 }, 1_000_000)).toEqual({ id: 'x', updatedAt: 1_000_000 });
  });

  it('sube un milisegimo la fila que la nube ya tiene (el empate perpetuo)', () => {
    // El +1 es lo que hace que el push siguiente la acepte: si la copia local
    // queda con EXACTAMENTE la fecha que hay en la nube, el guard estricto del
    // servidor (updatedAt < incoming) la rechaza otra vez, y otra, y otra.
    expect(acotarFechaRemota({ id: 'x', updatedAt: 900_000 }, 1_000_000)).toEqual({ id: 'x', updatedAt: 900_001 });
  });

  it('traduce al reloj local la fecha de un servidor adelantado', () => {
    // 10 min de desfase: la fila llega sellada 600 s por delante de nuestro reloj.
    // Sin traducción, la copia local nace en el futuro; con ella, nace donde el
    // otro dispositivo creó el cambio (más un ms, para ganarle al guard).
    const sesgo = sesgoDe(1_600_000, 1_000_000);
    expect(sesgo).toBe(600_000);
    expect(acotarFechaRemota({ id: 'x', updatedAt: 1_600_500 }, 1_100_000, sesgo)).toEqual({ id: 'x', updatedAt: 1_000_501 });
  });

  it('no muta la fila original (el resto de la fila viene intacta)', () => {
    const remota = { id: 'x', name: 'Rota', updatedAt: 1_060_000 };
    const acotada = acotarFechaRemota(remota, 1_000_000);
    expect(remota.updatedAt).toBe(1_060_000);
    expect(acotada.name).toBe('Rota');
  });

  it('LA CADENA COMPLETA: un cambio hecho despues del pull sigue viéndose al empujar', () => {
    // El agujero que hacia fallar el guard de sync ~1 de cada 15 corridas:
    //   1) el pull deja la fila del servidor con su fecha (60s adelantada), o sea
    //      localmente en el FUTURO,
    //   2) esa fila sube en el push siguiente y cursorPushTras la recorta al reloj
    //      de la RESPUESTA, que ya es posterior al cambio que la persona hizo
    //      mientras el push volaba,
    //   3) seleccionables filtra por > cursor: ese cambio queda por debajo y no
    //      vuelve a subirse nunca. Sin error y sin aviso.
    //
    // El reloj del push responde DESPUES del cambio (T_respuesta > T_cambio), que
    // es exactamente la condición que hace perder la fila.
    const relojPull = 1_000_000;
    const filaRemota = acotarFechaRemota({ id: 'remota', updatedAt: relojPull + 60_000 }, relojPull);
    expect(filaRemota.updatedAt, 'la fila del servidor quedo en el futuro').toBe(relojPull);

    // La persona edita un segundo después del pull, con el push en vuelo.
    const cambioLocal = { id: 'escrito-durante-el-push', updatedAt: relojPull + 1 };
    const respuestaDelPush = relojPull + 50;
    const cursor = cursorPushTras([filaRemota], 0, respuestaDelPush);

    expect(seleccionables([cambioLocal], cursor).length, 'el cambio local quedo invisible para siempre').toBe(1);
  });
});

describe('el desfase con el reloj del servidor', () => {
  it('lo que va adelantado su reloj, en milisegundos', () => {
    expect(sesgoDe(1_060_000, 1_000_000)).toBe(60_000);
    expect(sesgoDe(1_000_000, 1_000_000)).toBe(0);
    expect(sesgoDe(940_000, 1_000_000)).toBe(-60_000); // el servidor, atrasado
  });

  it('con desfase, un cambio del dispositivo CONGELADO gana en el push', () => {
    // Este es el agujero que auditamos: con el reloj del dispositivo 10 min
    // atrasado, cada cambio nacia con una fecha que el guard estricto del
    // servidor rechazaba. Sin traducir el sello al reloj del servidor, el
    // push se agotaba en silencio y el pull devolvia la version vieja.
    const ahora = 1_000_000;
    const serverTime = ahora + 600_000;
    const sesgo = sesgoDe(serverTime, ahora);

    // Lo que hay en la nube: un cambio de hace un minuto, en el reloj del servidor.
    const enNube = serverTime - 60_000;
    const cambioLocal = { id: 'editada-ahora', updatedAt: ahora + 1_000 };
    const enviado = sellarParaServidor(cambioLocal, sesgo);

    expect(enviado.updatedAt, 'el guard < del servidor lo rechazaria').toBeGreaterThan(enNube);
    // Y el sello local NO se toca: solo cambia lo que sale por la red.
    expect(cambioLocal.updatedAt).toBe(ahora + 1_000);
  });

  it('no muta la fila que sella', () => {
    const fila = { id: 'x', name: 'Ruta', updatedAt: 100 };
    expect(sellarParaServidor(fila, 60_000)).toEqual({ id: 'x', name: 'Ruta', updatedAt: 60_100 });
    expect(fila.updatedAt).toBe(100);
  });

  it('sin desfase (la primera push, todavia sin respuestas) el sello es el de siempre', () => {
    expect(sellarParaServidor({ updatedAt: 100 }, 0)).toEqual({ updatedAt: 100 });
  });
});

describe('reestampar: la salida del callejon del rechazo', () => {
  it('pone la fila un ms por encima de lo que hay en la nube', () => {
    expect(reestampar(1_000_000, 5_000_000)).toBe(5_000_001);
  });

  it('traduce con el desfase: lo que sale tiene que GANARLE al servidor', () => {
    const local = 1_000_000;
    const remoto = local + 60_000;
    const sesgo = 60_000;
    const nuevo = reestampar(local, remoto, sesgo);
    expect(nuevo + sesgo).toBeGreaterThan(remoto);
  });

  it('nunca baja una fila que ya es mas nueva que la nube', () => {
    expect(reestampar(9_000_000, 5_000_000)).toBe(9_000_000);
  });

  it('LA CADENA DEL RECHAZO: lo rechazado vuelve a subir y no se pierde', () => {
    // El bug critico de la auditoria, reproducido con las funciones reales:
    //   1) el servidor rechaza una fila por su guard LWW pero contabilizaba
    //      igual el envio (pushed++ estaba fuera del where),
    //   2) el cliente avanzaba lastPushAt por encima de ella,
    //   3) seleccionables filtra por > cursor, asi que la fila ya no volvia a
    //      entrar en ningun push y el pull la sobrescribia con la vieja.
    const cursorPrevio = 1_000;
    const lote = [
      { id: 'aceptada', updatedAt: 2_000 },
      { id: 'rechazada', updatedAt: 3_000 }, // en la nube hay una de 5.000
    ];
    const rechazados = [{ t: 'a', k: 'rechazada', u: 5_000 }];

    // El cursor se calculatesolo con lo que el servidor CONFIRMO.
    const rechazadas = new Set(rechazados.map(r => `${r.t}:${r.k}`));
    const aceptadas = lote.filter(f => !rechazadas.has(`a:${f.id}`));
    const cursor = cursorPushTras(aceptadas, cursorPrevio, 3_001);
    expect(cursor).toBe(2_000);

    // La fila rechazada sigue estando por encima del cursor: el siguiente push
    // la elige otra vez, con la fecha que le devuelve el servidor por encima.
    const siguiente = seleccionables(lote, cursor).map(f => f.id);
    expect(siguiente, 'la fila rechazada se perdio para siempre').toEqual(['rechazada']);

    const resellada = reestampar(lote[1].updatedAt, rechazados[0].u, 0);
    expect(resellada, 'tiene que ganarle a lo que hay en la nube').toBe(5_001);
    expect(seleccionables([{ id: 'rechazada', updatedAt: resellada }], cursor).length).toBe(1);
  });
});

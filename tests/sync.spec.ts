import { test, expect } from '@playwright/test';

// Regresión de la nube entre dispositivos. El síntoma que veía el usuario era
// "sincronizar entre dispositivos no sirve": con la cookie de sesión vigente
// (dura 30 días) casi ninguna sesión pasa por el login interactivo, y el motor
// se quedaba en 'local' para siempre — los hooks de Dexie descartaban cada
// cambio y solo el botón de Ajustes empujaba algo. Estos guards simulan la
// nube con page.route y verifican el comportamiento real del cliente:
//   1) al arrancar con cookie, el motor habla con /api/sync (antes: nunca);
//   2) el pull va ANTES que el push (al revés, el dispositivo nuevo sube su
//      semilla y pisa el horario real del otro);
//   3) la semilla (updatedAt 0) nunca viaja a la nube.

/** Sesión falsa: el cliente solo mira que /api/auth?op=me devuelva user. */
async function conSesion(page: import('@playwright/test').Page) {
  await page.route('**/api/auth?op=me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'u1', email: 'sync@test.dev', name: null } }),
    })
  );
}

interface NubeFalsa {
  pushes: any[];
  pulls: number;
  /** Cambia lo que hay en la nube en caliente (para probar un pull manual). */
  setRemotas: (filas: any[]) => void;
}

/* Los textos del menú son i18n y el navegador de los tests puede arrancar en
   español o en inglés: los guards solo verifican estructura + acción, no un
   idioma concreto. SIN anclas ^$ a propósito: el botón de subir lleva dentro
   el badge de pendientes ("Subir a la nube 3"), así que el texto del botón
   nunca es exactamente la etiqueta y un regex anclado no lo encontraba. */
const TEXTO_SUBIR = /Subir a la nube|Upload to the cloud/;
const TEXTO_BAJAR = /Bajar de la nube|Download from the cloud/;
const TEXTO_NUBE = /nube|cloud/i;

/** Abre el menú de Datos del header (si ya está abierto, no hace nada). */
async function abrirMenuDatos(page: import('@playwright/test').Page) {
  const btn = page.locator('.menu-datos-wrap button');
  await expect(btn).toBeVisible({ timeout: 20_000 });
  if (await page.locator('.menu-datos').count() === 0) await btn.click();
  await expect(page.locator('.menu-datos')).toBeVisible({ timeout: 10_000 });
  // La apertura ANIMA el menú (escala + desplazamiento). Un clic mientras se
  // mueve calcula el punto contra la caja equivocada: cae dentro del menú pero
  // fuera del botón, así que el único efecto es cerrar el menú. Sin esto el
  // guard de "Bajar" fallaba 3 de cada 4 veces sin que hubiera ningún error.
  await page.locator('.menu-datos').evaluate(el =>
    Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})))
  );
}

/**
 * Nube en memoria. `remotas` son las filas que "el otro dispositivo" tiene;
 * el GET devuelve las que aún no se han pedido (since=0 → todas, como un
 * dispositivo recién estrenado).
 *
 * SKEW_MS simula el reloj del servidor adelantado al del dispositivo, que es
 * lo que pasa de verdad (Neon contra un portátil con la hora sin ajustar). No
 * es decorativo: es lo que hace que el cursor del push importe.
 */
const SKEW_MS = 60_000;

async function conNube(page: import('@playwright/test').Page, iniciales: any[] = []): Promise<NubeFalsa> {
  const remotas = [...iniciales];
  const estado: NubeFalsa = {
    pushes: [],
    pulls: 0,
    setRemotas: filas => { remotas.length = 0; remotas.push(...filas); },
  };
  const serverTime = () => Date.now() + SKEW_MS;
  await page.route('**/api/sync*', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      const cuerpo = JSON.parse(req.postData() || '{}');
      estado.pushes.push(cuerpo);
      const filas = [
        ...(cuerpo.activities ?? []),
        ...(cuerpo.categories ?? []),
        ...(cuerpo.settings ?? []),
        ...(cuerpo.dayOverrides ?? []),
      ].length;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, pushed: filas, serverTime: serverTime() }),
      });
    }
    estado.pulls++;
    const since = Number(new URL(req.url()).searchParams.get('since') ?? '0') || 0;
    const nuevas = remotas.filter(r => (r.updatedAt ?? 0) > since);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        categories: [], activities: nuevas, settings: [], dayOverrides: [],
        serverTime: serverTime(), hasMore: false,
      }),
    });
  });
  return estado;
}

/** Actividad tal como la devuelve el servidor (updatedAt real, no semilla). */
function remota(nombre: string, startTime = '06:00', endTime = '06:30'): any {
  return {
    id: 'remota-' + nombre.replace(/\W+/g, '-'),
    categoryId: 'rutina',
    name: nombre,
    startTime,
    endTime,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    // Sello del reloj del SERVIDOR, no del dispositivo: es el reloj que ve la
    // fila en la nube real y, sobre todo, el que usa el cursor del pull. Con el
    // reloj local la fila quedaba SIEMPRE por debajo del cursor (que va 60s
    // adelantado por SKEW_MS) y ningún pull posterior podía verla: el guard
    // "Bajar trae lo del otro" solo pasaba por suerte, cuando el intercambio
    // de filas ocurría antes del pull de arranque.
    updatedAt: Date.now() + SKEW_MS,
  };
}

/** Espera a que la rejilla de la Semana esté pintada. */
async function esperarSemana(page: import('@playwright/test').Page) {
  await expect(page.locator('.day-column').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.activity-item').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('Sincronización entre dispositivos', () => {
  test.beforeEach(async ({ page }) => {
    // Perfil limpio (como el resto de suites): la semilla es determinista.
    await page.goto('/');
    await page.evaluate(() => indexedDB.deleteDatabase('ScheduleDB'));
    // Las rutas se montan DESPUÉS del goto inicial pero ANTES de la recarga
    // que usa la app de verdad: si no, el arranque real ya habría hablado con
    // /api/sync sin interceptar.
    await conNube(page, []);
    await conSesion(page);
    await page.reload();
  });

  test('al abrir la app con la sesión vigente, el motor sube y baja solo', async ({ page }) => {
    const nube = await conNube(page, [remota('Llegó de la nube')]);
    await conSesion(page);

    await page.goto('/');
    await esperarSemana(page);
    // El bug: sin arrancarSync(), status se quedaba en 'local' y no pasaba
    // NADA por /api/sync hasta que el usuario pulsara "Sincronizar ahora".
    await expect
      .poll(() => nube.pulls + nube.pushes.length, { timeout: 20_000, message: 'el motor nunca habló con la nube' })
      .toBeGreaterThan(0);

    // Y lo que bajó de la nube tiene que verse en la rejilla, no solo "bajar".
    await esperarSemana(page);
    await expect(page.locator('.activity-item[title="Llegó de la nube"]').first()).toBeVisible();
  });

  test('el reloj del servidor adelantado no traga cambios futuros', async ({ page }) => {
    // El bug silencioso: lastPushAt = serverTime. Si el servidor va un minuto
    // por delante, todo lo que el usuario cree en el siguiente minuto queda con
    // updatedAt POR DEBAJO del cursor y ya no vuelve a subirse nunca — sin
    // error, sin aviso, solo un dispositivo que nunca se actualiza.
    const nube = await conNube(page, [remota('Rota de arranque')]);
    await conSesion(page);
    await page.goto('/');
    await esperarSemana(page);
    // El arranque sube lo que el pull trajo y con eso queda fijado el cursor
    // del push. Si ese cursor se toma del reloj del servidor (adelantado 60s),
    // el cambio de abajo ya nace "en el pasado" y no vuelve a subir nunca.
    await expect.poll(() => nube.pushes.length, { timeout: 20_000 }).toBeGreaterThan(0);

    await page.evaluate(async () => {
      await (globalThis as any).__npDb.activities.put({
        id: 'con-reloj-adelantado',
        categoryId: 'rutina',
        name: 'Despues del arranque',
        startTime: '12:00',
        endTime: '13:00',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        updatedAt: Date.now(),
      });
    });

    await expect
      .poll(() => nube.pushes.flatMap(p => p.activities ?? []).map(a => a.name), { timeout: 20_000 })
      .toContain('Despues del arranque');
  });

  test('un cambio del usuario sí llega a la nube sin pulsar nada', async ({ page }) => {
    const nube = await conNube(page, []);
    await conSesion(page);

    await page.goto('/');
    await esperarSemana(page);
    const antes = nube.pushes.length;

    // Mutación por el MISMO camino que usa la app: la instancia Dexie (expuesta
    // en dev como __npDb). Escribir con la API nativa de IndexedDB NO valdría —
    // los hooks que encolan el sync viven en Dexie, no en el navegador.
    await page.evaluate(async () => {
      const db = (globalThis as any).__npDb;
      await db.activities.put({
        id: 'editada-por-guard',
        categoryId: 'rutina',
        name: 'Cambio mio',
        startTime: '10:00',
        endTime: '11:00',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        updatedAt: Date.now(),
      });
    });

    await expect
      .poll(() => nube.pushes.length, { timeout: 20_000, message: 'el cambio local nunca llegó a la nube' })
      .toBeGreaterThan(antes);

    const enviados = nube.pushes.slice(antes).flatMap(p => p.activities ?? []);
    expect(enviados.some(a => a.name === 'Cambio mio')).toBe(true);
  });

  test('sin sesión no se habla con la nube (modo local puro)', async ({ page }) => {
    await page.unroute('**/api/auth?op=me');
    await page.reload();
    const nube = await conNube(page, []);
    await esperarSemana(page);
    await page.waitForTimeout(4000); // por encima del debounce de 3s
    expect(nube.pushes.length, 'sin sesión no debe empujar nada').toBe(0);
  });

  test('el menú ofrece subir y bajar, no solo el archivo', async ({ page }) => {
    // El pedido: "quiero poder subir y bajar de la nube". El menú tenía
    // únicamente acciones de archivo (Descargar / Restaurar) y la nube solo
    // se controlaba desde un panel aparte.
    await esperarSemana(page);
    await abrirMenuDatos(page);
    await expect(page.locator('.menu-datos button', { hasText: TEXTO_SUBIR })).toBeVisible();
    await expect(page.locator('.menu-datos button', { hasText: TEXTO_BAJAR })).toBeVisible();
    // Y no desaparecen las de archivo: son caminos distintos.
    await expect(page.locator('.menu-datos button')).toHaveCount(5);
  });

  test('el botón "Bajar de la nube" trae lo que cambió en el otro dispositivo', async ({ page }) => {
    const nube = await conNube(page, [remota('Del otro, version vieja')]);
    await conSesion(page);
    await page.goto('/');
    await esperarSemana(page);
    // El arranque ya bajó la primera fila; ahora la nube recibe OTRA. Si el
    // botón no hiciera un pull de verdad, esta nunca aparecería.
    //
    // Se ESPERA el pull de arranque en vez de adivinar con un timeout fijo: si
    // el intercambio ocurre antes de que termine, el pull de arranque se
    // lleva las dos filas y el cursor deja a la nueva por debajo — el guard
    // fallaba 2 de cada 3 veces por esa carrera, no por el botón.
    await expect
      .poll(() => nube.pulls, { timeout: 20_000, message: 'el pull de arranque no ocurrió' })
      .toBeGreaterThan(0);
    nube.setRemotas([remota('Del otro, version vieja'), remota('Del otro, version nueva')]);

    await abrirMenuDatos(page);
    await page.locator('.menu-datos button', { hasText: TEXTO_BAJAR }).click();

    await esperarSemana(page);
    await expect(
      page.locator('.activity-item[title="Del otro, version nueva"]').first(),
      'el botón de bajar no trajo el cambio del otro dispositivo'
    ).toBeVisible({ timeout: 20_000 });
  });

  test('sin sesión el menú ofrece entrar, no botones de nube que fallan', async ({ page }) => {
    await page.unroute('**/api/auth?op=me');
    await page.reload();
    await esperarSemana(page);
    await abrirMenuDatos(page);
    await expect(page.locator('.menu-datos button', { hasText: TEXTO_SUBIR })).toHaveCount(0);
    await expect(page.locator('.menu-datos button', { hasText: TEXTO_BAJAR })).toHaveCount(0);
    // Un botón que lleva a error cada vez que se pulsa es peor que no tenerlo: en
    // su lugar hay UNO que abre Ajustes para entrar.
    await expect(page.locator('.menu-datos button', { hasText: TEXTO_NUBE })).toHaveCount(1);
  });
});

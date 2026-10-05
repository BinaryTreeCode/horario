import { test, expect } from '@playwright/test';
import { leerPixeles, esRojoSolido, esRojoDeLinea } from './helpers/pixeles';

// Regresión del display de texto en los bloques de la Semana: con columnas de
// piso móvil, un nombre que no cabe se partía a mitad de palabra dejando una
// letra huérfana en la segunda línea ("Almuerz/o", "descans/o"). El fix usa
// hyphens: auto + clamp de 1 línea en bloques ≤30 min; este test siembra los
// nombres problemáticos en IndexedDB y verifica que ninguna línea quede con
// resto mínimo sin guion visible, a los dos anchos más hostiles (320/425px).

interface ActividadSemilla {
  name: string;
  start: string;
  end: string;
  days: number[];
}

// Nombres que reprodugeron el bug (largos para columnas de 60px) + uno con
// espacio para cubrir el corte entre palabras. Slots de 45-90 min → 2 líneas
// posibles (los de ≤30 min truncan a 1 línea y no pueden huérfanas).
const SEMILLAS: ActividadSemilla[] = [
  { name: 'Almuerzo', start: '12:00', end: '13:00', days: [0, 1, 2, 3, 4] },
  { name: 'descanso', start: '15:00', end: '16:00', days: [0, 1, 2, 3, 4] },
  { name: 'salud y sueño', start: '21:30', end: '22:30', days: [0, 1, 2, 3, 4] },
  { name: 'wafles con mermelada', start: '09:00', end: '10:00', days: [5] },
  { name: 'meditación mindfulness', start: '07:00', end: '07:45', days: [6] }
];

async function sembrar(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate((semillas) => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('ScheduleDB');
    req.onsuccess = () => {
      const db = req.result;
      try {
        const now = Date.now();
        const catId = 'cat-a11y-test';
        const tx = db.transaction(['categories', 'activities'], 'readwrite');
        // La instalación nueva ahora trae actividades semilla (Rutina
        // matutina, Desayuno…): se limpian para que el detector de huérfanas
        // mida SOLO las semillas del test.
        tx.objectStore('activities').clear();
        tx.objectStore('categories').put({
          id: catId, label: 'Test', color: '#2d5a27', order: 99, updatedAt: now
        });
        const store = tx.objectStore('activities');
        for (const s of semillas) {
          store.put({
            id: crypto.randomUUID(),
            categoryId: catId,
            name: s.name,
            startTime: s.start,
            endTime: s.end,
            daysOfWeek: s.days,
            updatedAt: now
          });
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      } catch (e) { db.close(); reject(e); }
    };
    req.onerror = () => reject(req.error);
  }), SEMILLAS);
  await page.reload();
}

function detectorHuérfanas() {
  // Título ocupa ≥2 líneas y la última es una fracción mínima de la primera
  // (una letra o sílaba suelta) mientras la primera llena el ancho entero.
  const huérfanas: string[] = [];
  document.querySelectorAll('.activity-item').forEach(item => {
    const span = item.querySelector('.activity-title span');
    if (!span) return;
    const range = document.createRange();
    range.selectNodeContents(span);
    const rects = [...range.getClientRects()].filter(r => r.width > 1);
    if (rects.length >= 2) {
      const last = rects[rects.length - 1];
      const first = rects[0];
      const ancho = span.getBoundingClientRect().width;
      if (last.width < first.width * 0.35 && first.width >= ancho * 0.9) {
        huérfanas.push(span.textContent.trim());
      }
    }
  });
  return [...new Set(huérfanas)];
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => indexedDB.deleteDatabase('ScheduleDB'));
  await page.reload();
  await expect(page.locator('h1')).toContainText(/Nature Planner/i, { timeout: 30_000 });
});

for (const ancho of [320, 425]) {
  test(`Semana ${ancho}px: sin letras huérfanas en los títulos`, async ({ page }) => {
    await sembrar(page);
    await page.setViewportSize({ width: ancho, height: 800 });
    await expect(page.locator('.activity-item').first()).toBeVisible({ timeout: 30_000 });
    // Dejar que la tipografía y el layout se estabilicen tras el resize.
    await page.waitForTimeout(400);
    const huérfanas = await page.evaluate(detectorHuérfanas);
    expect(huérfanas, 'Títulos con letra huérfana: ' + huérfanas.join(', ')).toEqual([]);
  });
}

test('Semana: bloques ≤30 min truncan a 1 línea con tooltip completo', async ({ page }) => {
  await sembrar(page);
  // Semilla extra de 30 min exactos (2 slots → short → 1 línea).
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('ScheduleDB');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('activities', 'readwrite');
      tx.objectStore('activities').put({
        id: crypto.randomUUID(),
        categoryId: 'cat-a11y-test',
        name: 'tentetieso extraordinariamente largo',
        startTime: '11:00',
        endTime: '11:30',
        daysOfWeek: [0, 1, 2, 3, 4],
        updatedAt: Date.now()
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
  await page.reload();
  await page.setViewportSize({ width: 425, height: 800 });
  await expect(page.locator('.activity-item').first()).toBeVisible({ timeout: 30_000 });

  // La semilla repite en 5 días → 5 bloques; el primero basta.
  const bloque = page.locator('.activity-item', { hasText: 'tentetieso' }).first();
  await expect(bloque).toBeVisible();
  await expect(bloque).toHaveClass(/short/);
  await expect(bloque).toHaveAttribute('title', 'tentetieso extraordinariamente largo');
  // 1 línea VISIBLE: con nowrap+overflow hidden el rango de texto reporta 2
  // rects (el desbordado sigue existiendo geométricamente), así que la verdad
  // visual es la altura del span: 1 línea ≈ line-height (~13px), 2 ≈ doble.
  const alturaSpan = await bloque.evaluate((el: HTMLElement) => {
    const span = el.querySelector('.activity-title span')!;
    return span.getBoundingClientRect().height;
  });
  expect(alturaSpan).toBeLessThan(20);
});

/**
 * El chip de la hora actual (`.time-bar-label`) se APLASTABA en móvil: la línea
 * roja se veía, pero la etiqueta con la hora quedaba metida en una caja de 11px
 * de ancho para un texto de ~56px ("12:14 PM") — invisible. La causa no era el
 * ancho de pantalla sino un conflicto de cascada: en ≤480px aplican las media
 * queries de 768 y de 480, y la de 480 (que va después en el fuente) reponía
 * `right` sobre el `left` de la de 768. Con los dos lados puestos, el navegador
 * reparte el ancho sobrante y aplasta la etiqueta.
 *
 * El rango del día se fija a 0→24 para que la línea exista a CUALQUIER hora en
 * que corra el test (si no, de madrugada el `{#if isNowInRange}` no la pinta y
 * el guard no probaría nada).
 */
async function fijarRango24h(page: import('@playwright/test').Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('ScheduleDB');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const stamp = Date.now();
      store.put({ id: 'startHour', key: 'startHour', value: 0, updatedAt: stamp });
      store.put({ id: 'endHour', key: 'endHour', value: 24, updatedAt: stamp });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  }));
  await page.reload();
}

// 320/390/480 = los anchos donde el chip se aplastaba (480 es donde la media
// query de 480px empieza a aplicar; 320 es el celu más angosto que probamos).
// 768 = control: ahí el bloque de 480 no manda y el chip siempre estuvo bien.
// Piso de fuente: en móvil el chip se sube a 11px (0.7rem); a 768 manda la
// regla base de 0.65rem y se le pide menos para que el control no se acuse.
for (const [ancho, minFuentePx] of [[320, 11], [390, 11], [480, 11], [768, 9]] as const) {
  test(`Día ${ancho}px: la hora actual se lee en el chip rojo`, async ({ page }) => {
    await page.setViewportSize({ width: ancho, height: 800 });
    await fijarRango24h(page);
    await page.locator('#tab-day').click();

    const chip = page.locator('.time-bar-label');
    await expect(chip, 'la vista Día no pintó la línea de la hora actual')
      .toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(300);

    const medido = await chip.evaluate((el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const linea = document.querySelector('.time-bar-line');
      return {
        ancho: Math.round(r.width),
        alto: Math.round(r.height),
        texto: (el.textContent ?? '').trim(),
        // nowrap: si la caja se aplasta, el texto se sale (scrollWidth > clientWidth)
        recortado: el.scrollWidth > el.clientWidth + 1,
        largoDeLaLinea: Math.round(linea?.getBoundingClientRect().width ?? 0),
        fuentePx: parseFloat(getComputedStyle(el).fontSize)
      };
    });

    expect(medido.texto, `el chip no dice la hora: ${JSON.stringify(medido)}`)
      .toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/);
    expect(
      medido.ancho,
      `el chip de la hora quedó aplastado a ${medido.ancho}x${medido.alto}: ${JSON.stringify(medido)}`
    ).toBeGreaterThanOrEqual(40);
    expect(
      medido.recortado,
      `la hora se corta dentro del chip: ${JSON.stringify(medido)}`
    ).toBe(false);
    expect(
      medido.largoDeLaLinea,
      `la línea roja no tiene largo: ${JSON.stringify(medido)}`
    ).toBeGreaterThan(60);
    expect(
      medido.fuentePx,
      `la hora se dibuja a ${medido.fuentePx}px, se lee con lupa: ${JSON.stringify(medido)}`
    ).toBeGreaterThanOrEqual(minFuentePx);
  });
}

/**
 * La línea roja cruzaba la etiqueta de la hora y le partía el número en dos.
 *
 * No era un problema de geometría (la línea estaba bien ubicada en el tiempo:
 * 21:12 cae 20px bajo el "9:00 PM", que son 12 minutos a 100px/hora) sino de ORDEN
 * DE PINTADO: la etiqueta vive dentro del `.time-bar-dot` y la línea es su
 * hermano posterior, así que a igual nivel de apilado ganaba el hermano del
 * árbol. En escritorio no se nota porque la etiqueta queda a la izquierda del
 * punto; en móvil la etiqueta se ancla a la izquierda DENTRO del punto y la
 * línea entra ~60px dentro de ella.
 *
 * Por eso este guard lee PÍXELES del recorte y no la geometría: la geometría
 * estaba bien, lo mal era quién se pintaba encima. La línea es una corrida
 * horizontal continua, así que si atraviesa la etiqueta deja una tira de píxeles
 * rojos al 50% más ancha que el grosor de un glifo (medido con el bug: 50 de
 * 118). El antialias de los propios números también genera 1-2px rosados, por eso
 * la condición es sobre CORRIDAS de 4px o más.
 */
test('Día 390px: la línea roja no se pinta encima del número', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fijarRango24h(page);
  await page.locator('#tab-day').click();
  const chip = page.locator('.time-bar-label');
  await expect(chip, 'la vista Día no pintó la línea de la hora actual').toBeVisible({ timeout: 30_000 });
  await chip.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  const caja = await chip.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.x) - 16, y: Math.floor(r.y) - 6, width: Math.ceil(r.width) + 32, height: Math.ceil(r.height) + 12 };
  });
  const png = await page.screenshot({ clip: caja });
  const img = await leerPixeles(png);

  // La etiqueta: columnas con rojo sólido (fondo #c53030).
  let x0 = Infinity, x1 = -1;
  for (let x = 0; x < img.w; x++) {
    for (let y = 0; y < img.h; y++) {
      const [r, g, b] = img.px(x, y);
      if (esRojoSolido(r, g, b)) { if (x < x0) x0 = x; if (x > x1) x1 = x; break; }
    }
  }
  expect(x1, 'no se encontró la etiqueta en el recorte').toBeGreaterThan(x0);

  // Las filas de la línea: donde hay rojo al 50% FUERA de la etiqueta (a la
  // derecha, que es donde la línea sigue) y no en su borde redondeado.
  const filas: number[] = [];
  for (let y = 0; y < img.h; y++) {
    let fuera = 0;
    for (let x = x1 + 2; x < Math.min(img.w, x1 + 14); x++) {
      const [r, g, b] = img.px(x, y);
      if (esRojoDeLinea(r, g, b)) fuera++;
    }
    if (fuera >= 6) filas.push(y);
  }
  expect(filas.length, 'no se encontró la línea roja en el recorte').toBeGreaterThanOrEqual(2);

  // La corrida más larga de rojo de línea DENTRO de la etiqueta, en esas filas.
  let peorCorrida = 0;
  for (const y of filas) {
    let corrida = 0;
    for (let x = x0; x <= x1; x++) {
      const [r, g, b] = img.px(x, y);
      if (esRojoDeLinea(r, g, b)) {
        corrida++;
        peorCorrida = Math.max(peorCorrida, corrida);
      } else corrida = 0;
    }
  }
  expect(
    peorCorrida,
    `la línea roja se pintó encima de la etiqueta (corrida de ${peorCorrida}px dentro de un número de ${x1 - x0 + 1}px)`
  ).toBeLessThan(4);
});

/* ─────────────────────────── Modo oscuro ───────────────────────────────
 *
 * El tema no se comprueba mirando el atributo solamente: el atributo es lo
 * que el CSS mira, pero el fallo que importa es "dice oscuro y se ve claro".
 * Por eso el guard lee los colores COMPUTADOS del body y de un texto real de
 * la app, y exige que en oscuro el fondo sea de verdad más oscuro que el
 * texto (si alguien invierte un token, esta relación se rompe al instante).
 *
 * El atributo se lee de <html>, que es donde lo escribe lib/tema.ts; el
 * selector de Ajustes se maneja por `data-tema-opcion` y no por su texto, para
 * que el guard no dependa del idioma guardado en el dispositivo.
 */

/** Luminancia relativa 0-1 de un color `rgb(r, g, b)` de getComputedStyle. */
function luminancia(color: string): number {
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (!m) throw new Error(`no se pudo leer el color: ${color}`);
  const lin = [m[1], m[2], m[3]].map(v => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** Escribe (o borra con null) la fila de ajustes del tema. */
async function guardarTema(page: import('@playwright/test').Page, valor: string | null) {
  await page.evaluate((v: string | null) => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('ScheduleDB');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      if (v === null) store.delete('tema');
      else store.put({ id: 'tema', key: 'tema', value: v, updatedAt: Date.now() });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  }), valor);
}

/**
 * Espera a que el ARRANQUE haya resuelto el tema desde la BD y lo haya
 * pintado. No alcanza con esperar que el atributo exista: el script
 * anti-destello del <head> lo pone de entrada (leyendo el espejo de
 * localStorage), asi que esperarlo sin mas daria un "claro" de carrera.
 */
async function temaPintado(page: import('@playwright/test').Page): Promise<string | undefined> {
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.temaListo), { timeout: 30_000 })
    .toBe('1');
  return page.evaluate(() => document.documentElement.dataset.tema);
}

test('Modo oscuro: la preferencia guardada invierte fondo y texto', async ({ page }) => {
  await page.goto('/');
  await guardarTema(page, 'oscuro');
  await page.reload();
  expect(await temaPintado(page), 'la preferencia "oscuro" no llegó a <html>').toBe('oscuro');

  // La superficie real y el texto real, no los tokens: esto falla si la paleta
  // oscura no está aplicada aunque el atributo esté puesto. Se miden DOS
  // superficies porque el fondo de página y el de las tarjetas son tokens
  // distintos: con solo el primero, una paleta que se olvidara de las
  // tarjetas pasaría el guard (verificado: así no mordía).
  const colores = await page.evaluate(() => {
    const superficie = document.querySelector(
      '.daily-activity-card, .glass-panel, .stat-card, .week-block, .modal-content'
    );
    const texto = document.querySelector('h1, .day-title, .week-title');
    return {
      fondo: getComputedStyle(document.body).backgroundColor,
      superficie: superficie ? getComputedStyle(superficie).backgroundColor : null,
      que: superficie ? String(superficie.className).slice(0, 40) : null,
      texto: texto ? getComputedStyle(texto).color : getComputedStyle(document.body).color
    };
  });
  expect(colores.superficie, 'no se encontró ninguna superficie de la app para medir').not.toBeNull();
  const lf = luminancia(colores.fondo);
  const lc = luminancia(colores.superficie!);
  const lt = luminancia(colores.texto);
  expect(lf, `el fondo sigue siendo claro en modo oscuro (${colores.fondo})`).toBeLessThan(0.2);
  expect(lc, `la tarjeta "${colores.que}" sigue clara en modo oscuro (${colores.superficie})`).toBeLessThan(0.25);
  expect(lt, `el texto no subió en modo oscuro (${colores.texto})`).toBeGreaterThan(0.4);
  expect(lt, 'el texto quedó más oscuro que el fondo: la paleta está invertida')
    .toBeGreaterThan(lf * 3);
});

test('Ajustes: elegir "Oscuro" cambia la pantalla, guarda y sobrevive la recarga', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await guardarTema(page, 'claro');
  await page.reload();
  await temaPintado(page);

  const btnAjustes = page.locator('.header-actions button[aria-label="Open settings"], .header-actions button[aria-label="Abrir ajustes"]');
  await expect(btnAjustes, 'no aparece el botón de ajustes en el header').toBeVisible({ timeout: 30_000 });
  await btnAjustes.click();

  const opcion = page.locator('[data-tema-opcion="oscuro"]');
  await expect(opcion, 'Ajustes no pintó el selector de tema').toBeVisible({ timeout: 30_000 });
  await opcion.click();

  // El atributo cambia sin recargar: es lo que ve el usuario en el momento.
  expect(await page.evaluate(() => document.documentElement.dataset.tema),
    'elegir "Oscuro" no repintó la pantalla').toBe('oscuro');

  // Quedó en la BD (y por lo tanto viaja en el sync como los demás ajustes).
  const guardado = await page.evaluate(() => new Promise<string | null>((resolve, reject) => {
    const req = indexedDB.open('ScheduleDB');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('settings', 'readonly');
      const get = tx.objectStore('settings').get('tema');
      get.onsuccess = () => { db.close(); resolve(get.result ? get.result.value : null); };
      get.onerror = () => { db.close(); reject(get.error); };
    };
    req.onerror = () => reject(req.error);
  }));
  expect(guardado, 'el tema no se persistió en la tabla settings').toBe('oscuro');

  // Y sobrevive a la recarga (el splash del <head> no puede dejarlo en claro).
  await page.reload();
  expect(await temaPintado(page), 'al recargar se perdió el tema oscuro').toBe('oscuro');
});

test('Modo sistema: sin preferencia guardada sigue al tema del dispositivo', async ({ page }) => {
  await page.goto('/');
  await guardarTema(page, 'sistema');
  for (const [colorScheme, esperado] of [['dark', 'oscuro'], ['light', 'claro']] as const) {
    await page.emulateMedia({ colorScheme });
    await page.reload();
    expect(await temaPintado(page), `con el SO en ${colorScheme} el app quedó en el tema equivocado`)
      .toBe(esperado);
  }
});

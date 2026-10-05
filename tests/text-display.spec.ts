import { test, expect } from '@playwright/test';

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

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

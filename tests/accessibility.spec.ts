import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Regresión de accesibilidad: falla si axe encuentra alguna violación nueva.
// La única regla deshabilitada es 'region': la app aún no delimita landmarks
// con regiones etiquetadas; arreglarlo es una mejora propia, no un fallo de
// regresión. TODO lo demás (contraste, banners duplicados, targets) se corrige
// en el código, no se silencia aquí.
const DISABLED_RULES = ['region'];

// Locators por id estable (no por texto): la app arranca en el idioma que el
// usuario tenga guardado, y los tests deben pasar en es y en.
const TAB_DIA = '#tab-day';

async function runAxe(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page })
    .options({ resultTypes: ['violations'] })
    .disableRules(DISABLED_RULES)
    .analyze();
  return results.violations;
}

function formatear(violations: Awaited<ReturnType<typeof runAxe>>) {
  return violations
    .map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 5).map(n => n.target.join(' ')).join('; ')}`)
    .join('\n');
}

// Los modales entran con animación (fade/scale): axe composita colores a mitad
// de transición y reporta contrastes falsos. Esperar a que se asiente.
async function esperarAnimacion(page: import('@playwright/test').Page) {
  await page.waitForTimeout(600);
}

test.beforeEach(async ({ page }) => {
  // Perfil limpio: IndexedDB vacío → estado inicial determinista (sin datos del
  // navegador del developer). DeleteDatabase es asíncrono; reload para que la
  // app arranque fresca tras el borrado.
  await page.goto('/');
  await page.evaluate(() => indexedDB.deleteDatabase('ScheduleDB'));
  await page.reload();
  // Esperar a que la app hidrate (el h1 del header es la señal).
  await expect(page.locator('h1')).toContainText(/Nature Planner/i, { timeout: 30_000 });
});

test('Semana: sin violaciones de accesibilidad', async ({ page }) => {
  // Los donuts cargan lazy: su h2 es la señal de contenido listo.
  await expect(page.locator('.stat-card h2').first()).toBeVisible({ timeout: 30_000 });
  const violations = await runAxe(page);
  expect(violations, formatear(violations)).toEqual([]);
});

test('Día: sin violaciones de accesibilidad', async ({ page }) => {
  await page.locator(TAB_DIA).click();
  // Con perfil limpio no hay actividades: la señal de vista cargada es el
  // estado vacío (visible solo en día libre).
  await expect(page.locator('.empty-state')).toBeVisible({ timeout: 30_000 });
  const violations = await runAxe(page);
  expect(violations, formatear(violations)).toEqual([]);
});

test('Modal de actividad (creación): sin violaciones de accesibilidad', async ({ page }) => {
  await page.locator(TAB_DIA).click();
  await expect(page.locator('.empty-state')).toBeVisible({ timeout: 30_000 });
  // Día libre → tap en el track abre el modal de creación (mismo flujo que un
  // usuario real con perfil nuevo).
  await page.locator('.activities-track').click({ position: { x: 200, y: 300 } });
  const modal = page.locator('.modal-content[role="dialog"]');
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await esperarAnimacion(page);
  const violations = await runAxe(page);
  expect(violations, formatear(violations)).toEqual([]);
});

test('Ajustes: sin violaciones de accesibilidad', async ({ page }) => {
  // En desktop (≥1024px) las acciones viven en la sidebar; el último botón
  // es "Abrir ajustes". (En el header solo quedan logo/pestañas/sync.)
  await page.locator('.actions-sidebar .side-btn').last().click();
  const panel = page.locator('.modal-content');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await esperarAnimacion(page);
  const violations = await runAxe(page);
  expect(violations, formatear(violations)).toEqual([]);
});

test('Sin botones por debajo de 44px (regla del proyecto)', async ({ page }) => {
  await page.locator(TAB_DIA).click();
  await expect(page.locator('.empty-state')).toBeVisible({ timeout: 30_000 });
  const chicos = await page.evaluate(() => {
    return [...document.querySelectorAll('button')]
      .filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.height < 44 || r.width < 44);
      })
      .map(b => (b.getAttribute('aria-label') || b.textContent || '?').trim().slice(0, 40));
  });
  expect(chicos, 'Botones < 44px: ' + chicos.join(', ')).toEqual([]);
});

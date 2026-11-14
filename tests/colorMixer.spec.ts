import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const DISABLED_RULES = ['region'];

async function runAxe(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page })
    .options({ resultTypes: ['violations'] })
    .disableRules(DISABLED_RULES)
    .analyze();
  return results.violations;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => indexedDB.deleteDatabase('ScheduleDB'));
  await page.reload();
  await expect(page.locator('h1')).toContainText(/Nature Planner/i, { timeout: 30_000 });
});

test('Color Mixer: abrir desde Ajustes, armonizar todas las categorías y accesibilidad', async ({ page }) => {
  // 1. Abrir ajustes
  const btnAjustes = page.locator('.header-actions button[aria-label="Open settings"], .header-actions button[aria-label="Abrir ajustes"]');
  await expect(btnAjustes).toBeVisible({ timeout: 30_000 });
  await btnAjustes.click();
  await expect(page.locator('.modal-content')).toBeVisible({ timeout: 30_000 });

  // 2. Abrir mezclador desde el botón de la cabecera de categorías
  const mixerHeaderBtn = page.locator('.btn-mixer-header');
  await expect(mixerHeaderBtn).toBeVisible();
  await mixerHeaderBtn.click();

  // 3. El modal del mezclador debe estar abierto
  const mixerModalTitle = page.locator('#mixer-modal-title');
  await expect(mixerModalTitle).toBeVisible();

  // 4. Test de accesibilidad sin violaciones en el modal de mixer
  const violations = await runAxe(page);
  expect(violations).toEqual([]);

  // 5. Seleccionar una paleta armónica (Océano & Niebla)
  const oceanoPreset = page.locator('.preset-card').nth(1);
  await oceanoPreset.click();
  await expect(oceanoPreset).toHaveClass(/selected/);

  // 6. Aplicar a todas las categorías
  const applyBtn = page.locator('#mixer-modal-title').locator('xpath=ancestor::div[contains(@class,"modal-content")]//div[contains(@class,"modal-footer")]//button[contains(@class,"btn-primary")]');
  await applyBtn.click();

  // El modal del mixer debe cerrarse
  await expect(mixerModalTitle).not.toBeVisible();
});

test('Color Mixer: abrir individualmente desde una categoría y cambiar su color', async ({ page }) => {
  // 1. Abrir ajustes
  const btnAjustes = page.locator('.header-actions button[aria-label="Open settings"], .header-actions button[aria-label="Abrir ajustes"]');
  await expect(btnAjustes).toBeVisible({ timeout: 30_000 });
  await btnAjustes.click();
  await expect(page.locator('.modal-content')).toBeVisible({ timeout: 30_000 });

  // 2. Hacer clic en el botón de mixer de la primera categoría
  const firstCatMixerBtn = page.locator('.btn-cat-mixer').first();
  await expect(firstCatMixerBtn).toBeVisible();
  await firstCatMixerBtn.click();

  // 3. Debe abrirse en la pestaña individual
  const mixerModalTitle = page.locator('#mixer-modal-title');
  await expect(mixerModalTitle).toBeVisible();
  const tabIndividual = page.locator('#tab-individual');
  await expect(tabIndividual).toHaveAttribute('aria-selected', 'true');

  // 4. Seleccionar un swatch de armonía análoga
  const swatchAction = page.locator('.swatch-action').first();
  await expect(swatchAction).toBeVisible();
  await swatchAction.click();

  // 5. Aplicar a la categoría
  const applyBtn = page.locator('#mixer-modal-title').locator('xpath=ancestor::div[contains(@class,"modal-content")]//div[contains(@class,"modal-footer")]//button[contains(@class,"btn-primary")]');
  await applyBtn.click();

  // El modal debe cerrarse
  await expect(mixerModalTitle).not.toBeVisible();
});

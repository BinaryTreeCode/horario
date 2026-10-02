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
  // Con actividades semilla el día ya no está vacío: la señal de vista cargada
  // es el track del horario (existen con o sin actividades).
  await expect(page.locator('.activities-track').first()).toBeVisible({ timeout: 30_000 });
  const violations = await runAxe(page);
  expect(violations, formatear(violations)).toEqual([]);
});

test('Modal de actividad (creación): sin violaciones de accesibilidad', async ({ page }) => {
  await page.locator(TAB_DIA).click();
  await expect(page.locator('.activities-track').first()).toBeVisible({ timeout: 30_000 });
  // Tap en un hueco del track abre el modal de creación (mismo flujo que un
  // usuario real).
  await page.locator('.activities-track').first().click({ position: { x: 200, y: 300 } });
  const modal = page.locator('.modal-content[role="dialog"]');
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await esperarAnimacion(page);
  const violations = await runAxe(page);
  expect(violations, formatear(violations)).toEqual([]);
});

test('Ajustes: sin violaciones de accesibilidad', async ({ page }) => {
  // El header es visible en AMBAS vistas (la sidebar de Día fue retirada);
  // el botón de ajustes es el último del grupo de acciones.
  const btnAjustes = page.locator('.header-actions button[aria-label="Open settings"], .header-actions button[aria-label="Abrir ajustes"]');
  await expect(btnAjustes).toBeVisible({ timeout: 30_000 });
  await btnAjustes.click();
  const panel = page.locator('.modal-content');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await esperarAnimacion(page);
  const violations = await runAxe(page);
  expect(violations, formatear(violations)).toEqual([]);
});

/**
 * Viewports donde se comprueba la zona tactil. Antes solo corria en el de
 * playwright.config (1280x800) y solo en la vista Dia, con lo que el guard
 * era ciego a dos cosas: el layout ancho y los bloques de la grilla semanal.
 * Ahora se recorre movil, el de CI y uno ancho.
 */
const VIEWPORTS_PARA_44 = [
  { nombre: 'móvil 390x844', width: 390, height: 844 },
  { nombre: 'CI 1280x800', width: 1280, height: 800 },
  { nombre: 'ancho 1600x900', width: 1600, height: 900 },
];

/**
 * Zona interactiva REAL de los botones, medida por hit-testing.
 *
 * Medir solo getBoundingClientRect() miente: los bloques cortos de la grilla
 * amplian su zona con un ::before que no cambia el rect, asi que el rect
 * dice 24px cuando el dedo alcanza 44. Al reves, el rect nunca senala un
 * problema que el hit-testing no tenga. Por eso se recorre con
 * elementFromPoint.
 *
 * La medicion es vertical, que es la dimension que se aprieta: la altura la
 * fija la escala temporal del dia.
 */
async function zonasInteractivas(page: import('@playwright/test').Page, minimo: number): Promise<string[]> {
  return page.evaluate((min) => {
    const fallos: string[] = [];

    // 1) Candidatos por rect: solo los que ya de entrada se ven cortos.
    //    ElementFromPoint no mide nada fuera del viewport, asi que medir
    //    todo a ciegas se saltaria justo los bloques cortos de la tarde.
    //    OJO: los bloques de la rejilla semanal son <div role="button">, no
    //    <button> — buscarlos solo por etiqueta dejaba el guard mediendo
    //    cero bloques de la semana y pasaban en verde sin comprobar nada.
    const candidatos = [...document.querySelectorAll('button, [role="button"]')]
      .filter(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.height < min;
      });

    // 2) Cada candidato se trae al centro y se mide su zona real.
    for (const b of candidatos) {
      b.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      const r = b.getBoundingClientRect();
      const nombre = (b.getAttribute('aria-label') || b.textContent || '?').trim().slice(0, 44);
      const cx = r.left + r.width / 2;

      let arriba = r.top;
      for (let y = r.top; y >= r.top - 60; y -= 1) {
        const el = document.elementFromPoint(cx, y);
        if (el === b || b.contains(el)) arriba = y; else break;
      }
      let abajo = r.bottom;
      for (let y = r.bottom; y <= r.bottom + 60; y += 1) {
        const el = document.elementFromPoint(cx, y);
        if (el === b || b.contains(el)) abajo = y; else break;
      }

      const zona = Math.round(abajo - arriba);
      if (zona < min) fallos.push(`${nombre}: zona ${zona}px < ${min}px (rect ${Math.round(r.height)}px)`);
    }
    return fallos;
  }, minimo);
}

/** Emula puntero grueso (Chromium no lo trae por defecto en las pruebas). */
async function emularTactil(page: import('@playwright/test').Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // El layout puede cambiar al pasar a puntero grueso: hay que reasentar.
  await esperarAnimacion(page);
}

for (const vp of VIEWPORTS_PARA_44) {
  test.describe(`Zona táctil ≥44px en ${vp.nombre}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('Semana: zona táctil ≥44px con puntero grueso', async ({ page }) => {
      await expect(page.locator('.days-columns')).toBeVisible({ timeout: 30_000 });
      await esperarAnimacion(page);
      await emularTactil(page);
      const fallos = await zonasInteractivas(page, 44);
      expect(fallos, `Zona < 44px en Semana (${vp.nombre}, táctil): ` + fallos.join(' | ')).toEqual([]);
    });

    test('Semana: zona ≥24px con puntero fino (WCAG 2.5.8)', async ({ page }) => {
      await expect(page.locator('.days-columns')).toBeVisible({ timeout: 30_000 });
      await esperarAnimacion(page);
      // Con mouse, 24px cumple WCAG 2.2 AA (Target Size 2.5.8 pide 24x24) y
      // ampliar más solo robaría clics al bloque vecino.
      const fallos = await zonasInteractivas(page, 24);
      expect(fallos, `Zona < 24px en Semana (${vp.nombre}, ratón): ` + fallos.join(' | ')).toEqual([]);
    });

    test('Día: zona táctil ≥44px con puntero grueso', async ({ page }) => {
      await page.locator(TAB_DIA).click();
      // Con actividades semilla el día ya no está vacío: la señal de vista
      // cargada es el track del horario (existe con o sin actividades).
      await expect(page.locator('.activities-track').first()).toBeVisible({ timeout: 30_000 });
      await esperarAnimacion(page);
      await emularTactil(page);
      const fallos = await zonasInteractivas(page, 44);
      expect(fallos, `Zona < 44px en Día (${vp.nombre}, táctil): ` + fallos.join(' | ')).toEqual([]);
    });

    test('Día: zona ≥24px con puntero fino (WCAG 2.5.8)', async ({ page }) => {
      await page.locator(TAB_DIA).click();
      await expect(page.locator('.activities-track').first()).toBeVisible({ timeout: 30_000 });
      await esperarAnimacion(page);
      const fallos = await zonasInteractivas(page, 24);
      expect(fallos, `Zona < 24px en Día (${vp.nombre}, ratón): ` + fallos.join(' | ')).toEqual([]);
    });
  });
}

/**
 * Contraste REAL de todo el texto visible, componiendo el fondo a mano.
 *
 * Por que no basta con la regla color-contrast de axe: el body lleva un
 * patrón de puntos (radial-gradient en global.css) y axe no sabe calcular
 * contraste sobre un background-image. Clasifica esos nodos como
 * `incomplete` en lugar de `violation`, de modo que el assert de arriba
 * (violations == []) PASABA EN VERDE sin haber medido nada: en la rejilla
 * semanal entera noHabía ni un solo elemento queaxe dieron por "pasa".
 *
 * Aqui se compone el color de fondo mezclando las capas semitransparentes
 * desde el ancestro mas opaco hacia abajo, que es lo que hace el ojo. El
 * patrón de puntos se ignora (es un background-image): se mide contra el
 * color de fondo plano, que es el caso OPTIMISTA, asi que los colores que
 * pasan aqui tienen que cumplir ademas con el punto mas oscuro encima
 * (≈5% mas oscuro) para ser correctos de verdad.
 */
async function contrasteReal(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const srgb = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const luminancia = (rgb: number[]) => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]);
    const leer = (s: string) => { const n = (s.match(/[\d.]+/g) || []).map(Number); return { rgb: n.slice(0, 3), a: n.length > 3 ? n[3] : 1 }; };

    const fondoDe = (el: Element): number[] => {
      const capas: { rgb: number[]; a: number }[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = leer(getComputedStyle(n).backgroundColor);
        if (c.a > 0) { capas.push(c); if (c.a >= 0.999) break; }
      }
      let f = [255, 255, 255];
      for (let i = capas.length - 1; i >= 0; i--) {
        const { rgb, a } = capas[i];
        f = rgb.map((v, j) => v * a + f[j] * (1 - a));
      }
      return f;
    };

    const fallos: string[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const texto = [...el.childNodes]
        .filter(n => n.nodeType === 3)
        .map(n => (n.textContent || '').trim())
        .join(' ')
        .trim();
      if (!texto) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;

      const fondo = fondoDe(el);
      const c = leer(s.color);
      const fg = c.a < 1 ? fondo.map((v, j) => v * c.a + c.rgb[j] * (1 - c.a)) : c.rgb;
      const l1 = luminancia(fg), l2 = luminancia(fondo);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

      const fs = parseFloat(s.fontSize);
      const grande = fs >= 24 || (fs >= 18.66 && Number(s.fontWeight) >= 700);
      const minimo = grande ? 3 : 4.5;
      if (ratio < minimo) {
        const quien = (el.className || el.tagName).toString().split(' ').slice(0, 2).join('.');
        fallos.push(`${quien} "${texto.slice(0, 22)}" ${fs}px → ${ratio.toFixed(2)}:1 (mín ${minimo})`);
      }
    }
    return [...new Set(fallos)];
  });
}

test.describe('Contraste real (componiendo el fondo)', () => {
  test('Semana: todo el texto visible cumple AA', async ({ page }) => {
    await expect(page.locator('.stat-card h2').first()).toBeVisible({ timeout: 30_000 });
    await esperarAnimacion(page);
    const fallos = await contrasteReal(page);
    expect(fallos, 'Contraste < AA en Semana: ' + fallos.join(' | ')).toEqual([]);
  });

  test('Día: todo el texto visible cumple AA', async ({ page }) => {
    await page.locator(TAB_DIA).click();
    await expect(page.locator('.activities-track').first()).toBeVisible({ timeout: 30_000 });
    await esperarAnimacion(page);
    const fallos = await contrasteReal(page);
    expect(fallos, 'Contraste < AA en Día: ' + fallos.join(' | ')).toEqual([]);
  });

  test('Modal de actividad: todo el texto visible cumple AA', async ({ page }) => {
    await page.locator(TAB_DIA).click();
    await expect(page.locator('.activities-track').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.activities-track').first().click({ position: { x: 200, y: 300 } });
    await expect(page.locator('.modal-content[role="dialog"]')).toBeVisible({ timeout: 30_000 });
    await esperarAnimacion(page);
    const fallos = await contrasteReal(page);
    expect(fallos, 'Contraste < AA en el modal: ' + fallos.join(' | ')).toEqual([]);
  });
});

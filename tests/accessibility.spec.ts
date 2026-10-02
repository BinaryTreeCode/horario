import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

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
  // Horizontal de móvil: el ÚNICO caso con el alto tan escaso (390px) que la
  // cabecera compite de verdad por el espacio. Antes no lo cubria ninguno de
  // los tres de arriba (todos con 800px o mas de alto), y por eso se coló una
  // cabecera partida en dos filas que se comia el 37% de la pantalla.
  { nombre: 'horizontal 844x390', width: 844, height: 390 },
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

/**
 * La cabecera no puede comerse el alto de la pantalla.
 *
 * Es un guard de espacio, no de accesibilidad: la zona tactil ya la cubre
 * zonasInteractivas. Lo que se vigila aqui es que la cabecera no se parta en
 * varias filas cuando la pantalla es baja, porque el espacio que se come es
 * directamente espacio de horario invisible.
 *
 * Contexto del fallo que motiva el guard: en horizontal (844x390) el
 * breakpoint de 1199px convertía la cabecera en flex-wrap y se partía en dos
 * filas — 146px de cabecera, 37% del alto, dejando 196px útiles de un
 * timeline de dia que mide 1600px. Los tres bloques caben de sobra en una
 * fila (172 + 204 + 376 = 752px en 820 disponibles).
 */
test('Horizontal: la cabecera ocupa una sola fila y no se come el alto', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.days-columns')).toBeVisible({ timeout: 30_000 });
  await esperarAnimacion(page);

  const medida = await page.evaluate(() => {
    const cab = document.querySelector('.dashboard-header');
    if (!cab) return null;
    const hijos = [...cab.children];
    // "Filas" = lineas de base agrupadas: dos hijos estan en la misma fila si
    // sus centros verticales se solapan.
    const centros = hijos.map(e => {
      const r = e.getBoundingClientRect();
      return { nombre: e.className.toString().split(' ')[0], centro: r.top + r.height / 2, alto: r.height };
    }).sort((a, b) => a.centro - b.centro);
    let filas = 1;
    for (let i = 1; i < centros.length; i++) {
      const anterior = centros[i - 1];
      // Solapan verticalmente -> misma fila.
      const solapan = Math.abs(centros[i].centro - anterior.centro) < Math.max(anterior.alto, centros[i].alto) / 2;
      if (!solapan) filas++;
    }
    return {
      altoCabecera: Math.round(cab.getBoundingClientRect().height),
      altoViewport: window.innerHeight,
      filas,
    };
  });

  expect(medida, 'No se encontró .dashboard-header').not.toBeNull();
  expect(medida!.filas, `La cabecera se parte en ${medida!.filas} filas en horizontal: ${JSON.stringify(medida)}`).toBe(1);
  // Techo generoso a proposito: con una sola fila medida da 65px de 390 (17%).
  // Se corta en 30% para no hacer el test fragil ante cambios de tipografia.
  expect(
    medida!.altoCabecera / medida!.altoViewport,
    `La cabecera ocupa ${Math.round(medida!.altoCabecera / medida!.altoViewport * 100)}% del alto en horizontal`
  ).toBeLessThanOrEqual(0.3);
});

/**
 * La acción principal del modal tiene que estar en pantalla sin scroll.
 *
 * Cancelar/Guardar son lo que el usuario viene a hacer. Si el formulario es
 * más alto que la pantalla, el botón acaba fuera de vista y no hay ninguna
 * pista de que haya que desplazarse: en horizontal (844x390) el formulario
 * de creación mide 1040px dentro de un modal de 357px visibles, y Guardar
 * quedaba a 759px de scroll.
 *
 * El footer ya era sticky, pero solo con (max-width: 640px) — una condición
 * de ancho que no describe el problema, que es de altura. Por eso no se
 * activaba ni en horizontal ni en un escritorio de 800px de alto.
 */
const MODALES_CON_ALTURA_ESCASA = [
  { nombre: 'horizontal 844x390', width: 844, height: 390 },
  { nombre: 'escritorio corto 1280x800', width: 1280, height: 800 },
];

for (const vp of MODALES_CON_ALTURA_ESCASA) {
  test(`Modal: Guardar visible sin scroll en ${vp.nombre}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.locator(TAB_DIA).click();
    await expect(page.locator('.activities-track').first()).toBeVisible({ timeout: 30_000 });
    await esperarAnimacion(page);

    // Mismo camino que un usuario: tap en un hueco del track abre la creación.
    await page.locator('.activities-track').first().click({ position: { x: 200, y: 200 } });
    const modal = page.locator('.modal-content[role="dialog"]');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await esperarAnimacion(page);

    const estado = await page.evaluate(() => {
      const m = document.querySelector('.modal-content');
      if (!m) return null;
      // type=submit y no el texto: la etiqueta sale de i18n y los tests
      // tienen que pasar igual en español y en inglés.
      const b = m.querySelector('button[type="submit"]');
      if (!b) return { error: 'no hay botón submit en el modal' };
      const r = b.getBoundingClientRect();
      const footer = m.querySelector('footer');
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        viewport: window.innerHeight,
        sticky: footer ? getComputedStyle(footer).position : 'sin footer',
        // Alto del contenido vs. el del modal: si el formulario no cabe, el
        // pie tiene que ser el que se ancla.
        desborda: m.scrollHeight > m.clientHeight + 4,
      };
    });

    expect(estado, 'No se encontró el modal').not.toBeNull();
    expect((estado as any).error).toBeUndefined();
    if ((estado as any).desborda) {
      expect((estado as any).sticky, 'El formulario no cabe y el pie no es sticky').toBe('sticky');
    }
    expect(
      (estado as any).top >= 0 && (estado as any).bottom <= (estado as any).viewport,
      `Guardar fuera de pantalla en ${vp.nombre}: y=${(estado as any).top}..${(estado as any).bottom} en ${(estado as any).viewport}px`
    ).toBe(true);
  });
}

/**
 * ── C1: el deshacer tiene que existir Y decir la verdad ────────────────────
 *
 * El diálogo de borrado promete "podés deshacerlo con el botón Deshacer".
 * Dos de los tres flujos de borrado NO empujaban nada al historial
 * (ActivityModal.remove y WeeklyGrid.deleteActivity), así que el botón
 * quedaba deshabilitado justo después de prometer lo contrario. Además el
 * botón decía "Deshacer" a secas: sin decir QUÉ iba a deshacer.
 */

/** Botón Deshacer del header: se localiza por el icono, no por el texto (i18n). */
const BTN_DESHACER = '#btn-undo';
const BTN_REHACER = '#btn-redo';

/**
 * Abre el modal de una actividad desde la rejilla de la Semana y la borra por
 * el camino real: bloque → modal → Eliminar → confirmar.
 * Devuelve el nombre de la actividad borrada.
 */
async function borrarDesdeElModal(page: import('@playwright/test').Page): Promise<string> {
  const bloque = page.locator('.activity-item').first();
  await expect(bloque).toBeVisible({ timeout: 30_000 });
  const nombre = (await bloque.getAttribute('title')) ?? '';

  await bloque.click();
  const modal = page.locator('.modal-content[role="dialog"]');
  await expect(modal).toBeVisible({ timeout: 30_000 });

  // El de duplicar también es .btn-danger: se localiza por id, no por icono
  // (lucide no pone una clase por icono, solo .lucide-icon).
  const btnBorrar = modal.locator('#btn-delete-activity');
  await expect(btnBorrar).toBeVisible({ timeout: 30_000 });
  await btnBorrar.click();

  // Diálogo de confirmación: el mensaje es el que hace la promesa.
  const dialogo = page.locator('[role="alertdialog"]');
  await expect(dialogo).toBeVisible({ timeout: 30_000 });
  return nombre;
}

test('Borrar: el diálogo promete deshacer y el botón queda habilitado', async ({ page }) => {
  await expect(page.locator(BTN_DESHACER)).toBeDisabled();

  const nombre = await borrarDesdeElModal(page);

  // (a) El diálogo no dice que sea irreversible.
  const mensaje = await page.locator('[role="alertdialog"] p').innerText();
  expect(
    mensaje,
    'El diálogo sigue afirmando que no se puede deshacer'
  ).not.toMatch(/no se puede deshacer|cannot be undone|irreversible/i);

  await page.locator('[role="alertdialog"] .btn-confirm-ok').click();
  await expect(page.locator('[role="alertdialog"]')).toBeHidden({ timeout: 30_000 });

  // (b) El botón Deshacer se habilita de verdad.
  await expect(page.locator(BTN_DESHACER)).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator(BTN_REHACER)).toBeDisabled();

  // (c) El título nombra la actividad que se va a deshacer.
  const titulo = await page.locator(BTN_DESHACER).getAttribute('title');
  expect(titulo, 'El botón Deshacer no dice qué va a deshacer').toBeTruthy();
  expect(
    titulo!,
    `El title de Deshacer (${titulo}) no nombra la actividad (${nombre})`
  ).toContain(nombre);

  // El aria-label lleva lo mismo que el title (lectores de pantalla).
  expect(await page.locator(BTN_DESHACER).getAttribute('aria-label')).toBe(titulo);
});

test('Borrar y deshacer: la actividad vuelve a la rejilla', async ({ page }) => {
  const bloque = page.locator('.activity-item').first();
  await expect(bloque).toBeVisible({ timeout: 30_000 });
  const nombre = (await bloque.getAttribute('title')) ?? '';
  expect(nombre, 'El bloque no trae title con el nombre').toBeTruthy();

  // Una actividad de semana aparece en un bloque por cada día activo, así que
  // se cuenta SOLO los bloques de esa actividad: contar todos y esperar -1
  // daba un número arbitrario según cuántos días tuviera.
  const propios = page.locator(`.activity-item[title="${nombre}"]`);
  const antes = await propios.count();
  expect(antes, 'No se encontró ningún bloque de la actividad').toBeGreaterThan(0);

  await borrarDesdeElModal(page);
  await page.locator('[role="alertdialog"] .btn-confirm-ok').click();
  await expect(page.locator('[role="alertdialog"]')).toBeHidden({ timeout: 30_000 });

  // Tras borrar, sus bloques desaparecen de TODOS los días...
  await expect(propios).toHaveCount(0, { timeout: 30_000 });

  // ...y el Deshacer (por botón) los devuelve: la promesa era cierta.
  await page.locator(BTN_DESHACER).click();
  await expect(propios).toHaveCount(antes, { timeout: 30_000 });

  // Al deshacer, la pila de rehacer se habilita y nombra lo mismo.
  await expect(page.locator(BTN_REHACER)).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator(BTN_DESHACER)).toBeDisabled();
  const tituloRedo = await page.locator(BTN_REHACER).getAttribute('title');
  expect(tituloRedo, 'El botón Rehacer no dice qué va a rehacer').toBeTruthy();
  expect(tituloRedo!).toContain(nombre);
});

/**
 * Barrido de las claves de confirmación: ninguna debe afirmar irreversibilidad
 * si su flujo empuja al historial. Se lee el archivo de i18n como texto para
 * cubrir también los diálogos que este test no ejercita por UI.
 *
 * Las únicas que SÍ pueden decirlo son las de importar y borrar todo, que
 * llaman a clearUndo() por diseño.
 */
const IRREVERSIBLES_POR_DISENO = ['settings.importMsg', 'settings.wipeMsg'];

test('i18n: ningún diálogo de un flujo deshacible afirma que sea irreversible', async () => {
  const ruta = new URL('../src/lib/i18n.ts', import.meta.url);
  const fuente = await readFile(ruta, 'utf8');

  // Solo el bloque de español: el inglés se valida con el test de paridad.
  const bloqueEs = fuente.slice(0, fuente.indexOf("const en: Catalogo"));
  const entradas = [...bloqueEs.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm)];

  const offenses: string[] = [];
  let revisadas = 0;
  for (const [, clave, valor] of entradas) {
    if (!clave.startsWith('confirm.') && !clave.startsWith('modal.')) continue;
    if (IRREVERSIBLES_POR_DISENO.includes(clave)) continue;
    revisadas++;
    if (/no se puede deshacer|no podrá deshacerse|irreversible/i.test(valor)) {
      offenses.push(`${clave}: ${valor}`);
    }
  }

  expect(revisadas, 'No se encontraron claves confirm.*/modal.*: el test no mordería').toBeGreaterThan(5);
  expect(offenses, 'Diálogos que afirman irreversibilidad:\n' + offenses.join('\n')).toEqual([]);
});

/**
 * ── C4: la pista de primera ejecución ─────────────────────────────────────
 *
 * Arrastrar y tocar son los gestos de la app y no se descubren solos. La pista
 * aparece una vez sobre la rejilla y, una vez descartada, no vuelve: si
 * reapareciera en cada carga dejaría de ser una ayuda para ser ruido.
 */
const PISTA = '#pista-primera';

test('Pista: aparece en la primera visita y se descarta para siempre', async ({ page }) => {
  // beforeEach deja el perfil limpio: no hay nada en localStorage todavía.
  await expect(page.locator(PISTA)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`${PISTA} span.pista-texto`)).not.toBeEmpty();

  // Se descarta con su botón, no con un timeout.
  await page.locator(`${PISTA} button.pista-ok`).click();
  await expect(page.locator(PISTA)).toBeHidden({ timeout: 30_000 });

  // Recargar NO la trae de vuelta: la marca quedó en localStorage.
  await page.reload();
  await expect(page.locator('h1')).toContainText(/Nature Planner/i, { timeout: 30_000 });
  await page.waitForTimeout(800);
  await expect(page.locator(PISTA)).toHaveCount(0, { timeout: 30_000 });
});

test('Pista: el botón de descartar cumple la zona táctil de 44px', async ({ page }) => {
  await expect(page.locator(PISTA)).toBeVisible({ timeout: 30_000 });
  const alto = await page.locator(`${PISTA} button.pista-ok`).evaluate(
    el => Math.round(el.getBoundingClientRect().height)
  );
  // Una ✕ de 20px sería inalcanzable con el dedo: el botón es de texto y
  // tiene que respetar la misma regla que el resto de la app.
  expect(alto, `El botón de descartar mide ${alto}px de alto`).toBeGreaterThanOrEqual(44);
});

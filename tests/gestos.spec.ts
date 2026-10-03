import { test, expect } from '@playwright/test';

/**
 * Gestos de la Semana: regresiones de comportamiento que no se ven mirando el
 * CSS. Acá vive el barrido del asa lateral, que tiene la regla más sutil del
 * módulo: qué días se van cuando el dedo barre la corrida.
 */

test.beforeEach(async ({ page }) => {
  // Perfil limpio: IndexedDB vacío → la semilla de actividades es determinista
  // (mismos nombres, mismos días). Borrar la BD es asíncrono; se recarga para
  // que la app arranque fresca.
  await page.goto('/');
  await page.evaluate(() => indexedDB.deleteDatabase('ScheduleDB'));
  await page.reload();
  await expect(page.locator('h1')).toContainText(/Nature Planner/i, { timeout: 30_000 });
  // La rejilla cargada es la señal de que los bloques están pintados.
  await expect(page.locator('.day-column').first()).toBeVisible({ timeout: 30_000 });
});

/** Rectángulo del asa lateral derecha de un bloque, en coordenadas de viewport. */
async function asaDerecha(page: import('@playwright/test').Page) {
  const info = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.day-column')];
    const manejas = [...document.querySelectorAll('.resize-handle.hres-der')] as HTMLElement[];
    for (const h of manejas) {
      const col = h.closest('.day-column');
      if (!col) continue;
      const r = h.getBoundingClientRect();
      if (r.y < 0 || r.y > window.innerHeight || r.x < 0 || r.x > window.innerWidth) continue;
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        colW: col.getBoundingClientRect().width,
        dia: cols.indexOf(col),
        nombre: (h.closest('.activity-item') as HTMLElement | null)?.getAttribute('title') ?? '',
      };
    }
    return null;
  });
  expect(info, 'No se encontró un asa lateral visible en pantalla').not.toBeNull();
  return info!;
}

/** Rectángulo del asa lateral IZQUIERDA de un bloque visible. */
async function asaIzquierda(page: import('@playwright/test').Page) {
  const info = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.day-column')];
    const manejas = [...document.querySelectorAll('.resize-handle.hres-izq')] as HTMLElement[];
    for (const h of manejas) {
      const col = h.closest('.day-column');
      if (!col) continue;
      const r = h.getBoundingClientRect();
      if (r.y < 0 || r.y > window.innerHeight || r.x < 0 || r.x > window.innerWidth) continue;
      const dia = cols.indexOf(col);
      if (dia === 0) continue; // sin día previo no hay qué ganar
      const item = h.closest('.activity-item') as HTMLElement | null;
      const titulo = item?.getAttribute('title') ?? '';
      // Ganar el día previo solo se ofrece si la actividad NO está ahí: si ya
      // está, resolverHResize devuelve null y no hay gesto que medir.
      const yaEsta = [...cols[dia - 1].querySelectorAll('.activity-item')].some(
        b => (b as HTMLElement).getAttribute('title') === titulo
      );
      if (yaEsta) continue;
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        colW: col.getBoundingClientRect().width,
        dia,
        titulo,
      };
    }
    return null;
  });
  expect(info, 'No se encontró un asa IZQUIERDA visible que pueda ganar el día previo').not.toBeNull();
  return info!;
}

/**
 * Crea una actividad por la UI real (mismo camino que un usuario) para forzar
 * una colisión. Los toggles de día son `.day-toggle` con `aria-pressed` en
 * orden Lunes..Domingo, así que se eligen por índice y no por texto: el test
 * tiene que pasar igual en español y en inglés.
 */
async function crearActividad(
  page: import('@playwright/test').Page,
  nombre: string,
  inicio: string,
  fin: string,
  dias: number[]
) {
  await page.locator('.header-actions .btn-plus').click();
  const modal = page.locator('.modal-content[role="dialog"]');
  await expect(modal).toBeVisible({ timeout: 30_000 });

  await modal.locator('#act-name').fill(nombre);
  await modal.locator('#act-start').selectOption(inicio);
  await modal.locator('#act-end').selectOption(fin);

  const toggles = modal.locator('.day-toggle');
  const total = await toggles.count();
  expect(total, 'no se encontraron los toggles de día').toBe(7);
  for (let i = 0; i < total; i++) {
    const pressed = (await toggles.nth(i).getAttribute('aria-pressed')) === 'true';
    if (pressed !== dias.includes(i)) await toggles.nth(i).click();
  }

  await modal.locator('button[type="submit"]').click();
  await expect(modal).toBeHidden({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

test('Barrido del asa: al ganar un día, la marca es una banda, no la columna', async ({ page }) => {
  const asa = await asaIzquierda(page);

  // El asa IZQUIERDA arrastrada hacia AFUERA (izquierda) gana el día previo.
  await page.mouse.move(asa.x, asa.y);
  await page.mouse.down();
  await page.mouse.move(asa.x - asa.colW * 1.2, asa.y, { steps: 6 });

  const banda = page.locator('.hres-ganar-banda');
  await expect(banda, 'no apareció la banda del barrido').toBeVisible({ timeout: 30_000 });

  const medida = await banda.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const col = el.closest('.day-column')!.getBoundingClientRect();
    return {
      altoBanda: b.height,
      altoColumna: col.height,
      // ¿La banda cubre los vecinos? Si sí, el indicador sigue siendo la columna.
      tocaVecinos: b.height > col.height * 0.5,
    };
  });

  // El problema reportado: el indicador se extendía de arriba abajo y teñía
  // trabajo, Desayuno y Aseo 1, que no participan del gesto. La banda tiene
  // que marcar la franja horaria del bloque, no la columna.
  expect(
    medida.tocaVecinos,
    `la banda ocupa ${Math.round(medida.altoBanda)}px de una columna de ${Math.round(medida.altoColumna)}px: sigue siendo vertical`
  ).toBe(false);
  expect(medida.altoBanda, 'la banda no tiene altura').toBeGreaterThan(4);

  // NADA dentro de la columna puede marcar la columna completa. Un filete
  // de 3px sobre .slots-grid (que mide el 100% del alto) también es un
  // indicador vertical: el dedo se mueve en horizontal.
  const verticales = await banda.evaluate((el) => {
    const col = el.closest('.day-column')!;
    const altoCol = col.getBoundingClientRect().height;
    const culpables: string[] = [];
    for (const n of col.querySelectorAll('*')) {
      const r = n.getBoundingClientRect();
      if (r.height < altoCol * 0.5) continue; // no abarca la columna
      const cs = getComputedStyle(n);
      const marca =
        (cs.boxShadow && cs.boxShadow !== 'none') ||
        (cs.borderLeftWidth !== '0px' && cs.borderLeftStyle !== 'none') ||
        (cs.borderRightWidth !== '0px' && cs.borderRightStyle !== 'none') ||
        (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px');
      if (!marca) continue;
      const sel = n.tagName.toLowerCase() +
        (typeof n.className === 'string' && n.className.trim() ? '.' + n.className.trim().split(/\s+/).join('.') : '');
      culpables.push(`${sel} (alto ${Math.round(r.height)}px de ${Math.round(altoCol)}px)`);
    }
    return culpables;
  });
  expect(
    verticales,
    `indicadores verticales dentro de la columna: ${verticales.join(' | ')}`
  ).toEqual([]);

  await page.mouse.up();
});

/**
 * El empuje en cadena tiene que verse ANTES de soltar. Ganar un día a una
 * hora ocupada no solo agrega el bloque: corre a los vecinos que estén debajo.
 * Si eso no se anticipa, el bloque y los vecinos saltan al soltar.
 *
 * El guard mira la firma del preview contra la de la resolución real: si
 * divergen, el fantasma miente, que es peor que no dibujarlo.
 */
/**
 * El estirar vertical cambia la DURACIÓN, que es global: al soltar, el cambio
 * viaja a todos los días de la actividad. El preview solo pintaba el día donde
 * se agarró el asa, así que estirar desde el lunes se veía crecer el lunes y el
 * martes ya salía otro al soltar.
 *
 * El guard exige que se marquen TODOS los días, y que ese marking sea el mismo
 * antes y después de soltar.
 */
test('Estirar vertical: el preview se propaga a toda la semana', async ({ page }) => {
  const TITULO = /Rutina matutina/i;

  // Asa INFERIOR de una actividad que vive en varios días, visible en pantalla.
  const asa = await page.evaluate((re) => {
    const titulo = new RegExp(re.source, 'i');
    const cols = [...document.querySelectorAll('.day-column')];
    for (const item of document.querySelectorAll('.activity-item') as NodeListOf<HTMLElement>) {
      if (!titulo.test(item.getAttribute('title') ?? '')) continue;
      const enDias = cols.filter(c => [...c.querySelectorAll('.activity-item')]
        .some(b => titulo.test((b as HTMLElement).getAttribute('title') ?? ''))).length;
      if (enDias < 5) continue;
      // El asa de abajo es la que NO lleva .top ni .hres-*: crecer hacia abajo.
      const h = [...item.querySelectorAll('.resize-handle')].find(
        el => !el.classList.contains('top') && !el.classList.contains('hres-izq') && !el.classList.contains('hres-der')
      ) as HTMLElement | undefined;
      if (!h) continue;
      const r = h.getBoundingClientRect();
      if (r.y < 0 || r.y > window.innerHeight || r.x < 0 || r.x > window.innerWidth) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, enDias };
    }
    return null;
  }, { source: TITULO.source });
  expect(asa, 'no se encontró el asa inferior de una actividad de toda la semana').not.toBeNull();

  // Alto de la actividad en cada día, antes de tocar nada.
  const alturas = () => page.evaluate((re) => {
    const titulo = new RegExp(re.source, 'i');
    return [...document.querySelectorAll('.day-column')].map(c => {
      const el = [...c.querySelectorAll('.activity-item')]
        .find(b => titulo.test((b as HTMLElement).getAttribute('title') ?? '')) as HTMLElement | undefined;
      return el ? Math.round(el.getBoundingClientRect().height) : -1;
    });
  }, { source: TITULO.source });

  const antes = await alturas();

  await page.mouse.move(asa!.x, asa!.y);
  await page.mouse.down();
  await page.mouse.move(asa!.x, asa!.y + 130, { steps: 10 });
  await page.waitForTimeout(250);

  const marcados = await page.evaluate((re) => {
    const titulo = new RegExp(re.source, 'i');
    const cols = [...document.querySelectorAll('.day-column')];
    return cols.filter(c => [...c.querySelectorAll('.activity-item')]
      .some(b => b.classList.contains('redim-pendiente') && titulo.test((b as HTMLElement).getAttribute('title') ?? ''))).length;
  }, { source: TITULO.source });

  // Lo que se arregla: el preview ya no se queda en el día del asa.
  expect(
    marcados,
    `el preview marcó ${marcados} de ${asa!.enDias} días: no se propaga por la semana`
  ).toBeGreaterThan(1);

  await page.mouse.up();
  await page.waitForTimeout(700);

  const despues = await alturas();
  const conBloque = despues.map((h, i) => ({ h, i })).filter(x => x.h > 0);

  // Invariante real de una duración GLOBAL: tras soltar, todos los días
  // quedan con la MISMA altura. Si el preview pinta lo que el commit hace,
  // esto no puede fallar.
  // Tolerancia de 8px: entre días hay diferencias de renderizado legítimas
  // (miniatura, bordes) que no son de propagación. Lo que no puede pasar es
  // que un día se quede sin cambiar mientras los otros crecen.
  const referencia = conBloque[0].h;
  const dispares = conBloque.filter(x => Math.abs(x.h - referencia) > 8);
  expect(
    dispares,
    `tras estirar quedaron alturas distintas por día: ${JSON.stringify(conBloque)}`
  ).toEqual([]);

  // Y tiene que haber CRECIDO: sin esto el test pasaría estirando hacia cero.
  expect(conBloque[0].h, 'la actividad no creció').toBeGreaterThan(Math.max(...antes.filter(h => h > 0)));
});

test('Barrido: el fantasma del empuje coincide con lo que hace el commit', async ({ page }) => {
  // Con la semilla el gesto NUNCA choca: 'Trabajo' (09-13) es la única
  // actividad con días acotados y en Lunes esa franja está libre, así que el
  // guard pasaría sin comprobar nada. Creamos el choque de verdad: una
  // actividad que ocupa 09-13 SOLO el Lunes, y ganamos 'Trabajo' en el Lunes.
  await crearActividad(page, 'Choque de prueba', '09:00', '13:00', [0]);

  const asa = await asaIzquierda(page);
  expect(asa.titulo, 'el asa elegida no es Trabajo: el guard no probaría el empuje')
    .toContain('Trabajo');

  await page.mouse.move(asa.x, asa.y);
  await page.mouse.down();
  await page.mouse.move(asa.x - asa.colW * 1.2, asa.y, { steps: 6 });

  const banda = page.locator('.hres-ganar-banda');
  await expect(banda, 'no apareció la banda del barrido').toBeVisible({ timeout: 30_000 });

  // Estado del preview: ids y franjas de los fantasmas de empuje.
  // La columna destino se identifica por ÍNDICE: al soltar, la clase
  // col-hres-ganar desaparece con el preview.
  const destino = asa.dia - 1;
  const antes = await page.evaluate((d) => {
    const col = document.querySelectorAll('.day-column')[d]!;
    const fantasmas = [...col.querySelectorAll('.hres-empuje-fantasma')].map((el) => {
      const r = el.getBoundingClientRect();
      const colR = col.getBoundingClientRect();
      return { top: +(r.top - colR.top).toFixed(1), h: +r.height.toFixed(1) };
    });
    const apagados = col.querySelectorAll('.activity-item.hres-se-mueve').length;
    return { fantasmas, apagados, valido: !!col.querySelector('.hres-ganar-banda:not(.no-cabe)') };
  }, destino);

  // Soltar y comparar con el horario REALMENTE escrito en la grilla.
  await page.mouse.up();
  await page.waitForTimeout(500);

  const despues = await page.evaluate((d) => {
    const col = document.querySelectorAll('.day-column')[d]!;
    return [...col.querySelectorAll('.activity-item')].map((el) => {
      const r = el.getBoundingClientRect();
      const colR = col.getBoundingClientRect();
      return { top: +(r.top - colR.top).toFixed(1), h: +r.height.toFixed(1) };
    });
  }, destino);

  // Si el preview decía que el día no cabe, no debe haberse escrito nada:
  // todos los bloques deben seguir donde estaban (ningún apagado en preview).
  if (!antes.valido) {
    expect(antes.apagados, 'el preview marcaría movimiento en un día inválido').toBe(0);
    return;
  }

  // Cada fantasma tiene que existir después, en la misma franja.
  for (const f of antes.fantasmas) {
    const existe = despues.some(d => Math.abs(d.top - f.top) < 3 && Math.abs(d.h - f.h) < 3);
    expect(
      existe,
      `el fantasma (top ${f.top}, alto ${f.h}) no aparece en la grilla tras soltar`
    ).toBe(true);
  }
  expect(antes.fantasmas.length, 'sinmove nún sin fantasma').toBe(antes.apagados);
  // El guard solo sirve si hubo empuje de verdad: sin choques, 0 fantasmas.
  expect(antes.fantasmas.length, 'el test pasó sin comprobar nada: no hubo empuje').toBeGreaterThan(0);
  console.log('FANTASMAS VISTOS:', antes.fantasmas.length, 'APAGADOS:', antes.apagados);
});

/**
 * El reporte: "quiero estirar toda la semana pero solo me sirve hasta el
 * martes". Ganar días tenía barrido SOLO hacia adentro (el de retiro); hacia
 * afuera el asa se quedaba en el vecino inmediato, así que extender una
 * actividad a la semana entera obligaba a repetir el gesto día por día.
 *
 * Con la semilla esto se puede probar sin crear nada: la única actividad con
 * días acotados es 'Trabajo' (Lun–Vie), así que su asa derecha vive en el
 * Viernes, con Sábado y Domingo libres al otro lado.
 *
 * El guard exige que un barrido de 2 columnas paintE las DOS columnas ganadas
 * (banda + cabecera), que la pista las nombre a las dos, y que al soltar la
 * actividad exista en los dos días.
 */
/**
 * Asa DERECHA de la actividad `nombre`, exigiendo que las `libres` columnas
 * siguientes estén libres de esa misma actividad (si no, el barrido se frena y
 * el gesto no probaría nada) y que el asa esté en pantalla.
 */
async function asaDerechaConEspacio(page: import('@playwright/test').Page, nombre: string, libres: number) {
  const info = await page.evaluate(({ nombre, libres }) => {
    const cols = [...document.querySelectorAll('.day-column')];
    for (const h of document.querySelectorAll('.resize-handle.hres-der') as NodeListOf<HTMLElement>) {
      const col = h.closest('.day-column');
      if (!col) continue;
      const dia = cols.indexOf(col);
      if (dia + libres > 6) continue; // la tira no cabe en la semana
      const item = h.closest('.activity-item') as HTMLElement | null;
      if ((item?.getAttribute('title') ?? '') !== nombre) continue;
      const hay = Array.from({ length: libres }, (_, k) => dia + 1 + k).some(d =>
        [...cols[d].querySelectorAll('.activity-item')]
          .some(b => (b as HTMLElement).getAttribute('title') === nombre)
      );
      if (hay) continue;
      const r = h.getBoundingClientRect();
      if (r.y < 0 || r.y > window.innerHeight || r.x < 0 || r.x > window.innerWidth) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, colW: col.getBoundingClientRect().width, dia };
    }
    return null;
  }, { nombre, libres });
  expect(info, `no se vio un asa derecha de "${nombre}" con ${libres} días libres al otro lado`).not.toBeNull();
  return info!;
}

test('Barrido del asa: hacia afuera gana la tira entera de días, no solo el vecino', async ({ page }) => {// Con la semilla no alcanza: los ases de "Trabajo" caen en el borde de la
  // semana (donde solo queda un día libre) o fuera de pantalla. Se crea una
  // actividad en un solo día a las 08:30: la única franja libre de la semilla
  // que queda a la vista sin hacer scroll (07:00–08:30 es Rutina+Desayuno,
  // 09:00–13:00 es Trabajo).
  const NOMBRE = 'Tira de prueba';
  await crearActividad(page, NOMBRE, '08:30', '09:00', [1]); // solo Martes

  const asa = await asaDerechaConEspacio(page, NOMBRE, 2);
  expect(asa.dia, 'la actividad debía vivir solo en el Martes').toBe(1);

  await page.mouse.move(asa.x, asa.y);
  await page.mouse.down();
  // 2,4 columnas hacia AFUERA (derecha): el asa está en el BORDE de la
  // columna, así que el dedo cruzó 2 columnas enteras y quedó dentro de la
  // tercera → se ganan las dos cruzadas MÁS la del dedo (el día bajo el dedo
  // entra al ganar; al retirar se salvaba — asimetría ya asumida).
  await page.mouse.move(asa.x + asa.colW * 2.4, asa.y, { steps: 10 });
  await page.waitForTimeout(250);

  const esperados = [asa.dia + 1, asa.dia + 2, asa.dia + 3];

  // Una banda por día ganado (la banda es la franja horaria del bloque).
  const bandas = page.locator('.hres-ganar-banda');
  await expect(bandas.first(), 'no apareció la banda del barrido').toBeVisible({ timeout: 30_000 });
  expect(
    await bandas.count(),
    'el barrido solo pintó el vecino inmediato: no se extendió con el dedo'
  ).toBe(esperados.length);

  // Y una cabecera marcada por día ganado (la marca del día, 44px, no la columna).
  expect(
    await page.locator('.day-column.col-hres-ganar').count(),
    'solo se marcó una cabecera de día: la vista no cree en la tira'
  ).toBe(esperados.length);

  // La pista tiene que nombrar los tres días, no solo el primero.
  const pista = page.locator('.hres-float');
  await expect(pista).toBeVisible({ timeout: 30_000 });
  const texto = (await pista.textContent()) ?? '';
  const ganados = esperados;
  const nombres = await page.evaluate((ds) => {
    const headers = [...document.querySelectorAll('.day-header')];
    return ds.map(d => headers[d]?.getAttribute('title') ?? '');
  }, ganados);
  for (const nombre of nombres) {
    expect(nombre, 'no se encontró el nombre del día para comparar').toBeTruthy();
    expect(texto, `la pista "${texto}" no incluye ${nombre}`).toContain(nombre);
  }

  // ¿Cabe la tira? Si no, el gesto se rechaza entero (nada se escribe).
  const cabe = await bandas.first().evaluate(el => !el.classList.contains('no-cabe'));
  await page.mouse.up();
  await page.waitForTimeout(700);

  const dias = await page.evaluate((re) => {
    const t = new RegExp(re.source, 'i');
    return [...document.querySelectorAll('.day-column')].filter(c =>
      [...c.querySelectorAll('.activity-item')]
        .some(b => t.test((b as HTMLElement).getAttribute('title') ?? ''))
    ).length;
  }, { source: NOMBRE });

  if (cabe) {
    // La actividad pasó de 1 día (Martes) a los 4 de la tira.
    expect(dias, `tras el barrido la actividad quedó en ${dias} días: no ganó la tira`).toBe(4);
  } else {
    expect(dias, 'un barrido que no cabe no puede cambiar los días').toBe(1);
  }
});

test('Barrido del asa: el día del asa también se retira', async ({ page }) => {
  const asa = await asaDerecha(page);

  // El asa está en el borde DERECHO de su bloque: arrastrar hacia adentro
  // significa hacia la IZQUIERDA.
  await page.mouse.move(asa.x, asa.y);
  await page.mouse.down();
  // 3,4 columnas → floor(3.4) = 3 columnas completas cruzadas.
  await page.mouse.move(asa.x - asa.colW * 3.4, asa.y, { steps: 8 });

  // La pista dice qué se va a retirar. Tiene que INCLUIR el día del asa: el
  // gesto es recortar la corrida desde ahí. Antes solo listaba los cruzados y
  // dejaba la actividad huérfana en el día del asa.
  const pista = page.locator('.hres-float');
  await expect(pista).toBeVisible({ timeout: 30_000 });
  const dias = await pista.evaluate((el) => {
    // El texto del rótulo es: señal + lista de días + nombre de la actividad.
    // Aislamos la lista tomando los hijos que no son .hf-senial ni .hf-act.
    return [...el.childNodes]
      .filter(n => !(n instanceof HTMLElement && (n.classList.contains('hf-senial') || n.classList.contains('hf-act'))))
      .map(n => n.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(', ');
  });
  const nombres = await pista.locator('.hf-act').textContent();
  expect(dias, 'la pista no liste días').toBeTruthy();
  expect(nombres, 'la pista no nombra la actividad').toBeTruthy();

  const columnas = Math.floor(3.4);
  const esperados: string[] = [];
  for (let k = 0; k <= columnas; k++) {
    const d = asa.dia - k;
    if (d < 0) break;
    esperados.push(d);
  }
  const textoDias = await page.evaluate((ds) => {
    // title = nombre del día pelado; textContent incluye el badge "Hoy".
    const headers = [...document.querySelectorAll('.day-header')];
    return ds.map(d => headers[d]?.getAttribute('title') ?? '');
  }, esperados);

  for (const nombre of textoDias) {
    expect(dias, `la pista "${dias}" no incluye ${nombre} (el día del asa debe caer)`).toContain(nombre);
  }

  // La lista y el nombre no van pegados: "Jueves Rutina" se leía como una sola
  // frase y no se sabía dónde terminaba la lista.
  const separador = await pista.locator('.hf-act').evaluate(
    el => getComputedStyle(el, '::before').content
  );
  expect(separador, 'falta el separador entre la lista de días y la actividad').toContain('·');

  await page.mouse.up();
});

test('Barrido del asa: un día menos solo y el clásico siguen igual', async ({ page }) => {
  const asa = await asaDerecha(page);

  // Cruzar UNA columna completa: se van el asa y el día vecino, nada más.
  await page.mouse.move(asa.x, asa.y);
  await page.mouse.down();
  await page.mouse.move(asa.x - asa.colW * 1.2, asa.y, { steps: 6 });

  const pista = page.locator('.hres-float');
  await expect(pista).toBeVisible({ timeout: 30_000 });
  const texto = (await pista.textContent()) ?? '';
  const esperados: string[] = [];
  for (let k = 0; k <= 1; k++) {
    const d = asa.dia - k;
    if (d >= 0) esperados.push(d);
  }
  const nombres = await page.evaluate((ds) => {
    const headers = [...document.querySelectorAll('.day-header')];
    return ds.map(d => headers[d]?.getAttribute('title') ?? '');
  }, esperados);
  expect(nombres.length, 'el asa está en el primer día de la semana').toBeGreaterThan(1);
  for (const nombre of nombres) {
    expect(texto, `la pista "${texto}" no incluye ${nombre}`).toContain(nombre);
  }

  await page.mouse.up();
});
import { test, expect } from '@playwright/test';

/**
 * Imagenes: compresion en cliente y el viaje por el respaldo.
 *
 * Estos guards necesitan un navegador de verdad y no un mock, porque lo que se
 * verifica son tres cosas que un test de DOM no ve:
 *
 *  1. Que una foto de celular (12 MP, varios MB) SE COMPRIMA. Antes el modal
 *     rechazaba el original de mas de 2 MB —el numero del endpoint, que aplica
 *     a los bytes YA comprimidos— asi que en el movil la subida de la foto de
 *     una rutina fallaba casi siempre y el compresor ni llegaba a ejecutarse.
 *  2. Que comprimir NO CONGELE la pagina. `canvas.toDataURL` es sincronico:
 *     con el codigo viejo la codificacionava en un unico turno, el hilo
 *     principal quedaba clavado, y el spinner de "Subiendo imagen" vive en ese
 *     mismo hilo, asi que se quedaba CONGELADO justo cuando tenia que
 *     comunicar que algo estaba pasando.
 *  3. Que el respaldo entregue los MISMOS bytes: si vuelve a recomprimir, un
 *     exportar → importar degrada las imagenes de forma irreversible.
 *
 * La imagen de prueba se arma en la pagina con ruido (createImageData), que es
 * el peor caso para un compresor: un degradado liso pasaria sin ejercitar nada.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => indexedDB.deleteDatabase('ScheduleDB'));
  await page.reload();
  await expect(page.locator('h1')).toContainText(/Nature Planner/i, { timeout: 30_000 });
});

test('Compresion: una foto de celular grande se procesa sin colgarse', async ({ page }) => {
  const resultado = await page.evaluate(async () => {
    const { comprimirImagen, DIM_LOCAL, MAX_BYTES_ENTRADA } = await import('/src/lib/routineImages.ts');

    // ── Armar la foto de 12 MP ──
    const c = document.createElement('canvas');
    c.width = 4000;
    c.height = 3000;
    const ctx = c.getContext('2d')!;
    const w = 4000, h = 3000;
    let s = 12345;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      img.data[i] = s & 0xff;
      img.data[i + 1] = (s >> 8) & 0xff;
      img.data[i + 2] = (s >> 16) & 0xff;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const grande: Blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95)!);

    // ── Medidor del mayor hueco entre cuadros de animacion ──
    // Un hueco grande = el hilo principal estuvo ocupado y el navegador no
    // pudo pintar. Eso es exactamente lo que congela un spinner.
    const medir = async (fn: () => Promise<unknown>) => {
      let ultimo = performance.now();
      let maxGap = 0;
      let vivo = true;
      const tick = () => {
        if (!vivo) return;
        const ahora = performance.now();
        if (ahora - ultimo > maxGap) maxGap = ahora - ultimo;
        ultimo = ahora;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await fn();
      vivo = false;
      return maxGap;
    };

    // CONTROL: decodificar y dibujar, SIN codificar. Decodificar 12 MP es un
    // costo inevitable, asi que es la linea de base justa. Medir en absoluto
    // seria fragil (una maquina lenta rompe el mismo guard que hoy pasa);
    // comparar contra el control se lleva el factor maquina consigo.
    const gapControl = await medir(async () => {
      const b = await createImageBitmap(grande, { imageOrientation: 'from-image' });
      const cv = document.createElement('canvas');
      cv.width = 512;
      cv.height = 384;
      cv.getContext('2d')!.drawImage(b, 0, 0, 512, 384);
      b.close?.();
    });

    // PIPELINE: lo que hace la app de verdad.
    let salida = '';
    const gapPipeline = await medir(async () => {
      salida = await comprimirImagen(grande, DIM_LOCAL);
    });

    const bmp = await createImageBitmap(await (await fetch(salida)).blob());
    const medidas = { w: bmp.width, h: bmp.height };
    bmp.close?.();

    return {
      gapControl,
      gapPipeline,
      bytesEntrada: grande.size,
      bytesSalida: Math.floor((salida.length * 3) / 4),
      esDataWebp: salida.startsWith('data:image/webp'),
      ...medidas,
      topeEntrada: MAX_BYTES_ENTRADA,
    };
  });

  // 1) La foto grande NO se rechaza. El tope de entrada es holgado a propósito:
  //    el límite real es el del endpoint, sobre los bytes ya comprimidos.
  expect(
    resultado.bytesEntrada,
    'la foto de prueba no supera el tope viejo de 2 MB: el guard no probaría nada'
  ).toBeGreaterThan(2 * 1024 * 1024);
  expect(resultado.bytesEntrada, 'el tope de entrada sigue rechazando una foto normal')
    .toBeLessThan(resultado.topeEntrada);

  // 2) Salida válida: WebP, dentro del tope de lado mayor, proporcion intacta.
  expect(resultado.esDataWebp, 'la salida no es WebP (o el navegador no lo codifica)').toBe(true);
  expect(Math.max(resultado.w, resultado.h), `quedó en ${resultado.w}x${resultado.h}`).toBe(512);
  expect(resultado.w / resultado.h, ' deformó la proporción de la imagen').toBeCloseTo(4000 / 3000, 1);

  // 3) Comprimir sirve de algo: 12 MP no pueden weigh lo mismo que la salida.
  expect(
    resultado.bytesSalida,
    `la salida pesó ${resultado.bytesSalida} de ${resultado.bytesEntrada}: no comprimió`
  ).toBeLessThan(resultado.bytesEntrada / 4);

  // 4) NO congela el hilo principal. Con el `toDataURL` de antes la
  //    codificacionava en un unico turno sincronico y el hueco crecia muy por
  //    encima de lo que cuesta solo decodificar (medido en esta maquina: 64ms
  //    contra 25ms de control). Con `toBlob` la codificacion se delega y el
  //    hueco se parece al del control.
  expect(
    resultado.gapControl,
    'el control no midio nada (0ms): el guard no probaría nada'
  ).toBeGreaterThan(1);
  const tope = resultado.gapControl * 1.8 + 8;
  expect(
    resultado.gapPipeline,
    `codificar bloquearon el hilo ${Math.round(resultado.gapPipeline)}ms contra un tope de ${Math.round(tope)}ms (solo decodificar: ${Math.round(resultado.gapControl)}ms). El spinner de subida se congelaria.`
  ).toBeLessThanOrEqual(tope);
});

test('Compresion: una imagen chica no se agranda', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { comprimirImagen } = await import('/src/lib/routineImages.ts');
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 90;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#2d5a27';
    ctx.fillRect(0, 0, 120, 90);
    const blob: Blob = await new Promise(res => c.toBlob(res, 'image/png')!);
    const salida = await comprimirImagen(blob, 512);
    const bmp = await createImageBitmap(await (await fetch(salida)).blob());
    const m = { w: bmp.width, h: bmp.height };
    bmp.close?.();
    return m;
  });
  // Agrandar un icono a 512 lo convertiríaa en un bloque borroso que ocupa más
  // sin aportar un detalle nuevo.
  expect(r.w, `la imagen quedó agrandada a ${r.w}x${r.h}`).toBe(120);
  expect(r.h).toBe(90);
});

/**
 * El respaldo tiene que ser una COPIA. El codigo anterior re-codificaba cada
 * imagen a 256px al exportar, asi que exportar → importar dejaba las imagenes
 * en la mitad de su resolucion, para siempre.
 *
 * El guard ejercita el camino REAL (exportarRespaldoBinario → descarga →
 * unzip) en vez de reimitarlo: si manana el pipeline cambia, el guard mide lo
 * que hace la app y no lo que el test cree que hace.
 */
test('Respaldo: las imagenes viajan al ZIP con sus bytes originales', async ({ page }) => {
  // Sembrar una actividad con una imagen data-URL real (la que deja la app al
  // guardar sin sesion) y exportar.
  const original = await page.evaluate(async () => {
    const { comprimirImagen } = await import('/src/lib/routineImages.ts');
    const db = await import('/src/lib/db.ts');

    // 512x384 de ruido: la medida de DIM_LOCAL, para que el caso sea el que se
    // daba en la practica y no uno inventado.
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 384;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(512, 384);
    let s = 999;
    for (let i = 0; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      img.data[i] = s & 0xff;
      img.data[i + 1] = (s >> 8) & 0xff;
      img.data[i + 2] = (s >> 16) & 0xff;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const grande: Blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95)!);
    const dataUrl = await comprimirImagen(grande, 512);

    await db.db.activities.put({
      id: 'test-imagen-respaldo',
      categoryId: 'rutina',
      name: 'Con foto',
      startTime: '08:00',
      endTime: '09:00',
      daysOfWeek: [0],
      image: dataUrl,
      updatedAt: Date.now(),
    });
    return dataUrl;
  });

  // Descargar el .npz por el camino real.
  const descarga = page.waitForEvent('download');
  await page.evaluate(async () => {
    const { exportarRespaldoBinario } = await import('/src/lib/db.ts');
    await exportarRespaldoBinario('compact');
  });
  const archivo = await descarga;
  const ruta = await archivo.path();
  expect(ruta, 'no se descargó el respaldo').toBeTruthy();

  // Descomprimir AFUERA (aca fflate si resuelve: es una dependencia de node).
  const { unzipSync, strFromU8 } = await import('fflate');
  const { readFile } = await import('node:fs/promises');
  const entradas = unzipSync(new Uint8Array(await readFile(ruta!)));

  const claves = Object.keys(entradas);
  const binarios = claves.filter(k => k.endsWith('.bin'));
  expect(binarios.length, `el ZIP no llevo las imagenes a binario (claves: ${claves.join(', ')})`).toBe(1);

  // Comparar byte a byte contra la data-URL que estaba guardada.
  const esperado = Buffer.from(original.split(',')[1], 'base64');
  const fuera = entradas[binarios[0]];
  expect(
    fuera.length,
    `el ZIP lleva ${fuera.length} bytes y la imagen guardada pesaba ${esperado.length}: el respaldo volvio a recomprimir`
  ).toBe(esperado.length);
  expect(Buffer.from(fuera).equals(esperado), 'los bytes del ZIP no son los de la imagen guardada').toBe(true);

  // Y el JSON de referencia, con el placeholder estructural (no la data-URL).
  const json = strFromU8(entradas.d!);
  const payload = JSON.parse(json);
  // No se busca por indice: la fila 0 es una actividad semilla sin imagen. Se
  // recorre el payload buscando el placeholder estructural, que es como el
  // import (backupFile.ts) reconoce que la imagen vive en el ZIP.
  const filas = [...(payload.acts ?? []), ...(payload.activities ?? [])];
  const refs = filas
    .map((a: any) => (Array.isArray(a) ? a[7] : a?.image))
    .filter((x: any) => x && typeof x === 'object');
  expect(refs.length, 'el payload no llevo ninguna imagen como entrada binaria').toBe(1);
  expect(refs[0].i, 'el placeholder no apunta a la entrada 0 del ZIP').toBe(0);
  expect(refs[0].f, 'el placeholder no conservo el mime de la imagen').toMatch(/^image\//);
  // Y que la data-URL NO este en el JSON: si lo estuviera, el ahorro se perdio.
  expect(json, 'la data-URL sigue metida en el JSON del respaldo').not.toContain('data:image/');
});
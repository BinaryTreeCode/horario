import { describe, test, expect } from 'bun:test';
import { escalaPara, esDataUrlImagen, bytesDeDataUrl, DIM_LOCAL, DIM_BLOB, MAX_BYTES_ENTRADA } from './routineImages';

/**
 * El compresor de imágenes era una caja negra: la decisión de "no agrandar" y
 * la de "el binario le gana al base64" viven acá adentro y ninguna se veía
 * desde un test de UI, porque en la pantalla el resultado siempre era una
 * imagen (se vería más chica o más grande, y el ojo no es un oráculo).
 *
 * Estas dos funciones son puras justamente por eso: se pueden verificar sin
 * navegador, y son las dos reglas que, si alguien las rompe, hacen que la app
 * guarde archivos más grandes de lo necesario o que el respaldo pierda
 * fidelidad sin que nada falle visiblemente.
 */

describe('escalaPara', () => {
  test('nunca agranda: una imagen mas chica que el tope queda como esta', () => {
    // El caso que importa: subir un icono de 200px no debe produzir un bloque
    // borroso de 512px que ocupa mas y no aporta un solo detalle nuevo.
    const r = escalaPara(512, 200, 150);
    expect(r.escala).toBe(1);
    expect(r.w).toBe(200);
    expect(r.h).toBe(150);
  });

  test('reduce por el lado mayor y conserva la proporcion', () => {
    // Foto de celular 4000x3000 con tope 512: escala 0.128, no deforma.
    const r = escalaPara(512, 4000, 3000);
    expect(r.w).toBe(512);
    expect(r.h).toBe(384);
    expect(r.escala).toBeCloseTo(0.128, 6);

    // Vertical: manda el alto, que es el lado largo.
    const v = escalaPara(512, 3000, 4000);
    expect(v.h).toBe(512);
    expect(v.w).toBe(384);
  });

  test('el lado mayor queda exactamente en el tope', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1000, 1000], [513, 513]] as const) {
      const r = escalaPara(512, w, h);
      expect(Math.max(r.w, r.h), `${w}x${h} no llego al tope`).toBe(512);
    }
  });

  test('jamás devuelve 0px: un canvas de 0 lanza en drawImage', () => {
    // Una imagen 1x1 con tope 0 es absurda, pero un valor mal calculado acá
    // rompe el compresor ENTERO con una excepción opaca.
    for (const [w, h] of [[1, 1], [3, 1], [1, 900]] as const) {
      const r = escalaPara(0, w, h);
      expect(r.w).toBeGreaterThanOrEqual(1);
      expect(r.h).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('esDataUrlImagen', () => {
  test('reconoce solo las data-URL de imagen', () => {
    expect(esDataUrlImagen('data:image/webp;base64,AAA')).toBe(true);
    expect(esDataUrlImagen('data:image/jpeg;base64,AAA')).toBe(true);
    // Las que ya viven en la nube son otro camino y no se tocan.
    expect(esDataUrlImagen('https://x.store/abc.webp')).toBe(false);
    expect(esDataUrlImagen('blob:http://localhost/123')).toBe(false);
    // Basura de una fila editada a mano: no revienta, dice que no.
    expect(esDataUrlImagen(undefined)).toBe(false);
    expect(esDataUrlImagen(null)).toBe(false);
    expect(esDataUrlImagen('')).toBe(false);
    expect(esDataUrlImagen(42)).toBe(false);
    // Data-URL que NO es imagen (un PDF embebido, por ejemplo).
    expect(esDataUrlImagen('data:application/pdf;base64,AAA')).toBe(false);
  });
});

describe('bytesDeDataUrl', () => {
  test('desarma base64 a bytes y saca el mime de la cabecera', () => {
    // "hello" en base64 = aGVsbG8=
    const r = bytesDeDataUrl('data:image/webp;base64,aGVsbG8=');
    expect(r.mime).toBe('image/webp');
    expect(Array.from(r.bytes)).toEqual([104, 101, 108, 108, 111]);
    expect(r.bytes).toBeInstanceOf(Uint8Array);
  });

  test('el mime sobrevive al viaje del respaldo (no siempre es webp)', () => {
    expect(bytesDeDataUrl('data:image/jpeg;base64,aGVsbG8=').mime).toBe('image/jpeg');
    expect(bytesDeDataUrl('data:image/png;base64,aGVsbG8=').mime).toBe('image/png');
  });

  // Este es el round-trip que hace el .npz: data-URL -> bytes -> ZIP, y al
  // importar, bytes -> data-URL. Si el codificador no es simetrico, el
  // respaldo deja de ser una copia.
  test('data-URL -> bytes -> base64 vuelve a ser la misma imagen', () => {
    const original = 'data:image/webp;base64,aGVsbG8tdG9kby1taXMtaW1hZ2Vu';
    const { bytes } = bytesDeDataUrl(original);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(`data:image/webp;base64,${btoa(bin)}`).toBe(original);
  });

  test('sin cabecera ni coma no tira: devuelve vacio y un mime por defecto', () => {
    // Una fila corrupta no puede romper la exportacion entera.
    const r = bytesDeDataUrl('');
    expect(r.bytes.length).toBe(0);
    expect(r.mime).toBe('image/webp');
  });
});

describe('limites de imagen', () => {
  // La regresion que motivo el cambio: el modal rechazaba el ORIGINAL de mas de
  // 2 MB, que es el numero del ENDPOINT (que aplica a los bytes ya comprimidos).
  // Una foto de celular de 12 MP pesa 3-6 MB, asi que en la plataforma para la
  // que la app es mobile-first subir la foto de una rutina fallaba casi siempre.
  test('el tope de entrada deja pasar una foto de celular tipica', () => {
    const MEGA = 1024 * 1024;
    // iPhone moderno: 4032x3024 HEIC/JPEG ≈ 4 MB.
    expect(4 * MEGA).toBeLessThan(MAX_BYTES_ENTRADA);
    // Camara de gama alta: 8 MB.
    expect(8 * MEGA).toBeLessThan(MAX_BYTES_ENTRADA);
    // Lo que antes rechazaba la app, ahora pasa.
    expect(2 * MEGA).toBeLessThan(MAX_BYTES_ENTRADA);
  });

  test('el tope de entrada sigue frenando lo que no es una imagen', () => {
    const MEGA = 1024 * 1024;
    // Un video de 2 GB no puede cargarse entero en memoria para descubrir
    // despues que no era una imagen.
    expect(2000 * MEGA).toBeGreaterThan(MAX_BYTES_ENTRADA);
  });

  test('los topes de lado mayor siguen siendo los que estan documentados', () => {
    // DIM_LOCAL va DENTRO de la actividad (lo que llena el respaldo automatico);
    // DIM_BLOB va a Vercel Blob, donde solo se guarda la URL.
    expect(DIM_LOCAL).toBe(512);
    expect(DIM_BLOB).toBe(1600);
    expect(DIM_BLOB).toBeGreaterThan(DIM_LOCAL);
  });
});
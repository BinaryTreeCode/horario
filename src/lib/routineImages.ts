/**
 * Imágenes de rutina: compresión en cliente + subida a Vercel Blob.
 *
 * Problema que resuelve: una imagen guardada como data-URL base64 pesa hasta
 * 2 MB DENTRO de la actividad. Con varias, el respaldo automático a localStorage
 * explota (quota ~5 MB → "Respaldo automático pausado") y el push de sync
 * supera el límite de cuerpo de Vercel (HTTP 413).
 *
 * Estrategia:
 * 1. Comprimir SIEMPRE en cliente: máx DIM_LOCAL (512px) sin sesión,
 *    DIM_BLOB (1600px) con sesión. El archivo ORIGINAL puede medir lo que
 *    quiera: el tope de 2 MB es del endpoint, no de la entrada.
 * 2. Con sesión activa: subir el blob a Vercel Blob vía /api/images y guardar
 *    SOLO la URL corta en activity.image (pesa ~100 bytes).
 * 3. Sin sesión: queda la data-URL comprimida (funciona offline/local puro).
 *
 * El push además migra data-URLs viejas a Blob antes de armar el payload
 * (ver sync.ts), así los respaldos ya guardados dejan de romper nada.
 *
 * Y el respaldo exportado (.npz) lleva los bytes TAL CUAL: ver
 * `bytesDeDataUrl`. No se recomprime, y el motivo está anotado ahí.
 */

const QUALITY = 0.82;
/** Límite de cuerpo del endpoint /api/images: aplica a los bytes YA comprimidos. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Lado mayor de la data-URL que vive DENTRO de la actividad. 512px es el
 *  punto en el que el respaldo automático y el push siguen respirando: por
 *  encima, una sola foto puede valer MB de texto base64. */
export const DIM_LOCAL = 512;
/** Lado mayor cuando la imagen va a Vercel Blob. Allí solo se guarda la URL
 *  (~100 bytes), así que el peso de la imagen no lo paga la base de datos y
 *  el tope artificial solo servía para dejar el lightbox blando: 512px sobre
 *  un escenario de móvil a 3x son ~1170 píxeles de dispositivo y se ve borroso.
 *  1600px cubre ese escenario y queda muy por debajo del tope de 2 MB del
 *  endpoint /api/images. */
export const DIM_BLOB = 1600;

/** Techo del archivo QUE ELIGE LA PERSONA.
 *
 *  Antes el modal rechazaba cualquier original de más de 2 MB, que es el
 *  mismo número que el límite del endpoint — pero ese límite es de los bytes
 *  YA comprimidos (~100–400 KB), no del archivo que elige la gente. Una foto
 *  de celular de 12 MP pesa 3–6 MB, así que en la plataforma para la que la app
 *  es mobile-first, subir la foto de una rutina fallaba casi siempre y el
 *  compresor ni llegaba a ejecutarse.
 *
 *  Ahora la entrada no tiene tope de tamaño: lo que manda es el peso después de
 *  comprimir. Este techo alto queda solo como red de seguridad para que un
 *  video de 2 GB elegido por error no se cargue entero en memoria para
 *  descubrir recien que no era una imagen. Muy por encima de cualquier foto. */
export const MAX_BYTES_ENTRADA = 25 * 1024 * 1024;

/**
 * Escala a `maxDim` SIN agrandar nunca. Pura a propósito: la decisión de
 * "no agrandar" es la que hace que subir una imagen de 200px no la convierta en
 * un bloque borroso de 512px que ocupa más sin aportar un solo detalle, y es
 * justo el tipo de regla que un test de UI no ve.
 *
 * `Math.min(1, ...)` del lado de la escala es lo que garantiza el no-agrandar;
 * el resto mantiene la proporción y garantiza al menos 1px (un canvas de 0
 * lanza en `drawImage`).
 */
export function escalaPara(maxDim: number, ancho: number, alto: number): { escala: number; w: number; h: number } {
  const escala = Math.min(1, maxDim / Math.max(ancho, alto));
  return {
    escala,
    w: Math.max(1, Math.round(ancho * escala)),
    h: Math.max(1, Math.round(alto * escala)),
  };
}

/** ¿Es una data-URL de imagen (a migrar), no una URL http(s)/blob ya liviana? */
export function esDataUrlImagen(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:image/');
}

/** Convierte una data-URL a bytes y mime SIN pasar por fetch().
 *  Decodifica el base64 a mano: `fetch` de un data: URL funciona, pero es un
 *  rodeo con una CSP puesta y sin gain. Los bytes son los MISMOS que van al ZIP. */
export function bytesDeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const coma = dataUrl.indexOf(',');
  const cabecera = dataUrl.slice(5, coma < 0 ? dataUrl.length : coma); // sin "data:"
  const mime = (cabecera.split(';')[0] || 'image/webp').trim();
  const base64 = coma < 0 ? '' : dataUrl.slice(coma + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

/** data-URL → Blob, sin `fetch`. */
export function blobDeDataUrl(dataUrl: string): Blob {
  const { bytes, mime } = bytesDeDataUrl(dataUrl);
  return new Blob([bytes], { type: mime });
}

/**
 * Dibuja el bitmap escalado en un canvas y devuelve el Blob codificado.
 *
 * Dos detalles que no son cosméticos:
 *
 * 1. `toBlob` en vez de `toDataURL`: el segundo es SINCRÓNICO y bloquea el
 *    hilo principal mientras codifica y concatena el base64. A DIM_BLOB son
 *    cientos de ms en los que la página no responde — y el spinner de
 *    "Subiendo imagen" vive en ese mismo hilo, así que se quedaba CONGELADO
 *    justo cuando tenía que comunicar que algo estaba pasando. `toBlob` delega
 *    la codificación y resuelve por promesa.
 * 2. `imageSmoothingQuality: 'high'`: reducir 4000px a 1600px con el
 *    suavizado por defecto produce bordes escalonados y detalle perdido. Con
 *    'high' el reescalado usa un filtro correcto.
 */
async function dibujarYcodificar(
  bitmap: ImageBitmap,
  w: number,
  h: number
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas no disponible');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);

  const webp = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/webp', QUALITY));
  if (webp && webp.size > 0) return webp;
  // Safari viejo no codifica WebP: cae a JPEG con la misma calidad.
  const jpeg = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', QUALITY));
  if (jpeg && jpeg.size > 0) return jpeg;
  throw new Error('No se pudo codificar la imagen');
}

/** Blob → data-URL. */
function blobADataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('No se pudo leer la imagen'));
    fr.readAsDataURL(blob);
  });
}

/**
 * Comprime un File/Blob a data-URL (máx `maxDim` px el lado mayor).
 *
 * `maxDim` decide si la imagen acaba en la base de datos (DIM_LOCAL, el valor
 * por defecto) o en Blob (DIM_BLOB). El archivo de entrada puede pesar lo que
 * pese: acá solo se decide el tamaño final.
 *
 * `imageOrientation: 'from-image'` va explícito aunque sea el default del spec:
 * es lo que hace que una foto sacada en vertical con EXIF rotado salga vertical
 * y no acostada. Un default implícito que cambie en el futuro voltearía todas
 * las fotos del usuario sin que nada falle visiblemente.
 */
export async function comprimirImagen(file: Blob, maxDim: number = DIM_LOCAL): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { w, h } = escalaPara(maxDim, bitmap.width, bitmap.height);
    return blobADataUrl(await dibujarYcodificar(bitmap, w, h));
  } finally {
    // En finally y no después del drawImage: si getContext devolviera null se
    // lanzaba con el bitmap todavía abierto, y cada bitmap sin cerrar retiene
    // la memoria de la imagen original (varios MB) hasta que el GC se apiada.
    bitmap.close?.();
  }
}

/** Sube una data-URL (o blob) a Vercel Blob vía /api/images y devuelve la URL.
 *  Requiere sesión activa (cookie). Lanza si falla: el llamador decide fallback. */
export async function subirABlob(dataUrl: string): Promise<string> {
  const blob = blobDeDataUrl(dataUrl);
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error('La imagen excede 2 MB');
  }
  const put = await fetch('/api/images', {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'image/webp' },
    body: blob,
    credentials: 'same-origin'
  });
  if (!put.ok) {
    const msg = await put.json().catch(() => ({ error: `HTTP ${put.status}` }));
    throw new Error(msg?.error ?? `HTTP ${put.status}`);
  }
  const data = await put.json();
  if (!data?.url) throw new Error('Respuesta sin URL');
  return data.url as string;
}

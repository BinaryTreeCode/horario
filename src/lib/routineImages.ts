/**
 * Imágenes de rutina: compresión en cliente + subida a Vercel Blob.
 *
 * Problema que resuelve: una imagen guardada como data-URL base64 pesa hasta
 * 2 MB DENTRO de la actividad. Con varias, el respaldo automático a localStorage
 * explota (quota ~5 MB → "Respaldo automático pausado") y el push de sync
 * supera el límite de cuerpo de Vercel (HTTP 413).
 *
 * Estrategia:
 * 1. Comprimir SIEMPRE en el cliente: máx 512px, WebP calidad 0.82 → ~100 KB.
 * 2. Con sesión activa: subir el blob a Vercel Blob vía /api/images y guardar
 *    SOLO la URL corta en activity.image (pesa ~100 bytes).
 * 3. Sin sesión: queda la data-URL comprimida (funciona offline/local puro).
 *
 * El push además migra data-URLs viejas a Blob antes de armar el payload
 * (ver sync.ts), así los respaldos ya guardados dejan de romper nada.
 */

const MAX_DIM = 512; // px, lado mayor
const QUALITY = 0.82;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // límite del endpoint /api/images

/** Lado mayor de la data-URL que vive DENTRO de la actividad. 512px es el
 *  punto en el que el respaldo automático y el push siguen respirando: por
 *  encima, una sola foto puede valer MB de texto base64. */
export const DIM_LOCAL = MAX_DIM;
/** Lado mayor cuando la imagen va a Vercel Blob. Allí solo se guarda la URL
 *  (~100 bytes), así que el peso de la imagen no lo paga la base de datos y
 *  el tope artificial solo servía para dejar el lightbox blando: 512px sobre
 *  un escenario de móvil a 3x son ~1170 píxeles de dispositivo y se ve borroso.
 *  1600px cubre ese escenario y queda muy por debajo del tope de 2 MB del
 *  endpoint /api/images. */
export const DIM_BLOB = 1600;

/** Comprime un File/Blob a data-URL WebP (máx `maxDim` px el lado mayor).
 *  Si el navegador no soporta canvas WebP cae a JPEG con la misma calidad.
 *  `maxDim` decide si la imagen acaba en la base de datos (DIM_LOCAL, el
 *  valor por defecto) o en Blob (DIM_BLOB). */
export async function comprimirImagen(file: Blob, maxDim: number = MAX_DIM): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas no disponible');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  // WebP primero (mucho más chico); Safari viejo no lo codifica → JPEG.
  let out = canvas.toDataURL('image/webp', QUALITY);
  if (!out.startsWith('data:image/webp')) {
    out = canvas.toDataURL('image/jpeg', QUALITY);
  }
  return out;
}

/** ¿Es una data-URL de imagen (a migrar), no una URL http(s)/blob ya liviana? */
export function esDataUrlImagen(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:image/');
}

/** Sube una data-URL (o blob) a Vercel Blob vía /api/images y devuelve la URL.
 *  Requiere sesión activa (cookie). Lanza si falla: el llamador decide fallback. */
export async function subirABlob(dataUrl: string): Promise<string> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
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

// ── Recompresión para respaldos exportados ──────────────────────────────────

/** Meta (bytes) que deja de pesarse como texto: se exporta como binario ZIP. */
const UMBRAL_BINARIO = 40 * 1024;

/**
 * Recomprime una data-URL de imagen al tamaño mínimo razonable para un
 * respaldo (máx 256px, WebP 0.7 ≈ 15–30 KB). Reutiliza el mismo pipeline
 * canvas que `comprimirImagen`, pero partiendo de la data-URL ya guardada.
 *
 * Devuelve { url, bytes } donde `bytes` es el tamaño binario REAL (data-URL →
 * blob, que decodifica el base64; evita sobrestimar ~33% como length/4*3).
 * Devuelve null si algo falla (imagen corrupta, canvas caído): la imagen
 * original viaja intacta en el JSON — jamás se pierde un respaldo por comprimir.
 */
export async function recomprimirParaRespaldo(
  dataUrl: string
): Promise<{ url: string; bytes: number } | null> {
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    // Mismo orden que comprimirImagen: WebP si el navegador codifica; el
    // fallback JPEG es indistinguible a 256px con calidad 0.72.
    let out = canvas.toDataURL('image/webp', 0.7);
    if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', 0.72);
    const blob = await (await fetch(out)).blob();
    return { url: out, bytes: blob.size };
  } catch {
    return null;
  }
}



export { UMBRAL_BINARIO };

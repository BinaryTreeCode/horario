import type { APIRoute } from 'astro';
import { put, list } from '@vercel/blob';
import { getSessionUser } from '../../server/auth';
import { consumirPresupuestoSync } from '../../server/rateLimit';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function tieneBytes(bytes: Uint8Array, offset: number, esperado: readonly number[]): boolean {
  if (bytes.length < offset + esperado.length) return false;
  for (let i = 0; i < esperado.length; i++) {
    if (bytes[offset + i] !== esperado[i]) return false;
  }
  return true;
}

function tieneAscii(bytes: Uint8Array, offset: number, texto: string): boolean {
  if (bytes.length < offset + texto.length) return false;
  for (let i = 0; i < texto.length; i++) {
    if (bytes[offset + i] !== texto.charCodeAt(i)) return false;
  }
  return true;
}

/** Verifica los magic bytes reales del binario contra el Content-Type declarado. */
export function validarMagicBytesImagen(bytes: Uint8Array, contentType: string): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return tieneBytes(bytes, 0, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return tieneBytes(bytes, 0, PNG_SIG);
    case 'image/gif':
      return tieneAscii(bytes, 0, 'GIF87a') || tieneAscii(bytes, 0, 'GIF89a');
    case 'image/webp':
      return tieneAscii(bytes, 0, 'RIFF') && tieneAscii(bytes, 8, 'WEBP');
    default:
      return false;
  }
}

/**
 * PUT /api/images  body binario = imagen
 * Requiere sesión. Guarda en Vercel Blob bajo el namespace del usuario.
 * Devuelve { url } para guardarla en activity.image.
 */
export const PUT: APIRoute = async ({ cookies, request }) => {
  const user = await getSessionUser(cookies);
  if (!user) return json({ error: 'No autenticado' }, 401);

  const lim = await consumirPresupuestoSync(user.id);
  if (lim.bloqueado) {
    const res = json({ error: 'Demasiadas solicitudes seguidas. Espera un momento.' }, 429);
    res.headers.set('Retry-After', String(lim.reintentarEnSeg));
    return res;
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: 'Almacenamiento de imágenes no configurado (BLOB_READ_WRITE_TOKEN)' }, 503);
  }

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
  const TIPOS_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!TIPOS_PERMITIDOS.has(contentType)) {
    return json({ error: 'Formato de imagen no soportado (se admite JPEG, PNG, WebP o GIF)' }, 400);
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_SIZE) {
    return json({ error: 'La imagen excede 2 MB' }, 413);
  }
  if (buffer.byteLength === 0) {
    return json({ error: 'Imagen vacía' }, 400);
  }
  if (!validarMagicBytesImagen(new Uint8Array(buffer), contentType)) {
    return json({ error: 'El contenido del archivo no corresponde a una imagen válida' }, 400);
  }

  try {
    const ext = contentType.split('/')[1] || 'png';
    const pathname = `users/${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const blob = await put(pathname, buffer, {
      contentType,
      access: 'public',
      addRandomSuffix: false,
    });
    return json({ url: blob.url, pathname: blob.pathname });
  } catch (err: any) {
    console.error('[images/put]', err);
    return json({ error: 'Error al subir la imagen' }, 500);
  }
};

/** GET /api/images — lista las imágenes del usuario (para futuras gestiones). */
export const GET: APIRoute = async ({ cookies }) => {
  const user = await getSessionUser(cookies);
  if (!user) return json({ error: 'No autenticado' }, 401);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ images: [] });
  }

  try {
    const result = await list({ prefix: `users/${user.id}/` });
    return json({ images: result.blobs.map(b => ({ url: b.url, pathname: b.pathname, uploadedAt: b.uploadedAt })) });
  } catch (err: any) {
    console.error('[images/list]', err);
    return json({ error: 'Error al listar imágenes' }, 500);
  }
};

import type { APIRoute } from 'astro';
import { put, list } from '@vercel/blob';
import { getSessionUser } from '../../server/auth';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

/**
 * PUT /api/images  body binario = imagen
 * Requiere sesión. Guarda en Vercel Blob bajo el namespace del usuario.
 * Devuelve { url } para guardarla en activity.image.
 */
export const PUT: APIRoute = async ({ cookies, request }) => {
  const user = await getSessionUser(cookies);
  if (!user) return json({ error: 'No autenticado' }, 401);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ error: 'Almacenamiento de imágenes no configurado (BLOB_READ_WRITE_TOKEN)' }, 503);
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    return json({ error: 'El contenido debe ser una imagen' }, 400);
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_SIZE) {
    return json({ error: 'La imagen excede 2 MB' }, 413);
  }
  if (buffer.byteLength === 0) {
    return json({ error: 'Imagen vacía' }, 400);
  }

  try {
    const ext = (contentType.split('/')[1] ?? 'png').split(';')[0].replace(/[^a-z0-9]/gi, '') || 'png';
    const pathname = `users/${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const blob = await put(pathname, buffer, {
      contentType,
      access: 'public',
      addRandomSuffix: false,
    });
    return json({ url: blob.url, pathname: blob.pathname });
  } catch (err: any) {
    console.error('[images/put]', err);
    return json({ error: 'Error al subir la imagen: ' + (err?.message ?? '') }, 500);
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

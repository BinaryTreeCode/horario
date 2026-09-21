import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db, isDbConfigured } from '../../server/db';
import { users } from '../../server/schema';
import { hashPassword, verifyPassword, createSession, destroySession, getSessionUser, sessionCookieOptions, SESSION_COOKIE } from '../../server/auth';

export const prerender = false;

/**
 * POST /api/auth?op=register  body: { email, password, name? }
 * POST /api/auth?op=login     body: { email, password }
 * POST /api/auth?op=logout    (sin body)
 * GET  /api/auth?op=me
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readJson(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export const POST: APIRoute = async ({ url, cookies, request }) => {
  if (!isDbConfigured) {
    return json({ error: 'La base de datos en la nube no está configurada. La aplicación funciona en modo local.' }, 503);
  }
  const op = url.searchParams.get('op');

  try {
    // ── Registro ──
    if (op === 'register') {
      const body = await readJson(request);
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      const name = body.name ? String(body.name).trim().slice(0, 150) : null;

      if (!EMAIL_RE.test(email)) return json({ error: 'Email inválido' }, 400);
      if (password.length < 8) return json({ error: 'La contraseña debe tener al menos 8 caracteres' }, 400);

      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) {
        return json({ error: 'Ya existe una cuenta con ese email' }, 409);
      }

      const passwordHash = await hashPassword(password);
      const inserted = await db
        .insert(users)
        .values({ email, name, passwordHash })
        .returning({ id: users.id, email: users.email, name: users.name });

      const user = inserted[0];
      const { token, expiresAt } = await createSession(user.id);
      const res = json({ user });
      res.headers.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttrs(expiresAt)}`);
      return res;
    }

    // ── Login ──
    if (op === 'login') {
      const body = await readJson(request);
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');

      const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
      const user = rows[0];
      // Mensaje genérico para no filtrar si el email existe
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return json({ error: 'Email o contraseña incorrectos' }, 401);
      }

      const { token, expiresAt } = await createSession(user.id);
      const res = json({ user: { id: user.id, email: user.email, name: user.name } });
      res.headers.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttrs(expiresAt)}`);
      return res;
    }

    // ── Logout ──
    if (op === 'logout') {
      await destroySession(cookies);
      const res = json({ ok: true });
      res.headers.append(
        'Set-Cookie',
        `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
      );
      return res;
    }

    return json({ error: 'Operación no soportada' }, 400);
  } catch (err: any) {
    console.error('[auth]', err);
    return json({ error: 'Error interno del servidor' }, 500);
  }
};

export const GET: APIRoute = async ({ cookies, url }) => {
  const op = url.searchParams.get('op');
  if (op !== 'me') return json({ error: 'Operación no soportada' }, 400);

  try {
    const user = await getSessionUser(cookies);
    return json({ user }); // user: null si no hay sesión
  } catch (err) {
    console.error('[auth/me]', err);
    return json({ error: 'Error interno del servidor' }, 500);
  }
};

function cookieAttrs(expiresAt: Date): string {
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

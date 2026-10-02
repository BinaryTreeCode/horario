import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db, isDbConfigured } from '../../server/db';
import { users } from '../../server/schema';
import { hashPassword, verifyPassword, createSession, destroySession, getSessionUser, sessionCookieOptions, SESSION_COOKIE } from '../../server/auth';
import { consultarLimite, registrarFallo, limpiarFallos, claveLogin, claveRegistro, ipDeRequest } from '../../server/rateLimit';

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

/** 429 con Retry-After: el cliente sabe cuándo volver sin adivinar. */
function demasiadosIntentos(error: string, reintentarEnSeg: number) {
  const res = json({ error }, 429);
  res.headers.set('Retry-After', String(reintentarEnSeg));
  return res;
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

      // Rate limiting por IP: frena el alta masiva de cuentas (miles de
      // registros con correos distintos desde la misma dirección).
      const keyRegistro = claveRegistro(ipDeRequest(request));
      const limite = await consultarLimite(keyRegistro);
      if (limite.bloqueado) {
        return demasiadosIntentos(
          'Demasiados registros desde esta conexión. Espera unos minutos antes de reintentar.',
          limite.reintentarEnSeg,
        );
      }

      const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

      // Anti-enumeración: el registro responde SIEMPRE 200 con el mismo
      // cuerpo, exista o no el correo. Un 409 con "ya existe una cuenta"
      // confirmaba qué correos están registrados y es justo lo que permite
      // enumerar cuentas (y luego atacarlas por el login).
      // La respuesta no lleva datos de usuario en ninguno de los dos casos:
      // devolverlos solo en el camino feliz volvería a filtrar la existencia.
      if (existing.length > 0) {
        return json({ ok: true });
      }

      const passwordHash = await hashPassword(password);
      const inserted = await db
        .insert(users)
        .values({ email, name, passwordHash })
        .returning({ id: users.id });

      const user = inserted[0];
      // Cada alta consume cuota: aquí el abuso es el volumen de cuentas
      // creadas, no los fallos, así que se cuenta el registro exitoso.
      await registrarFallo(keyRegistro);
      const { token, expiresAt } = await createSession(user.id);
      const res = json({ ok: true });
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

      // Rate limiting por cuenta: frena el credential stuffing. Va ANTES de
      // verificar la contraseña para que un atacante no pueda usar intentos
      // gratis como oráculo de fuerza bruta.
      const keyLogin = claveLogin(email);
      const limite = await consultarLimite(keyLogin);
      if (limite.bloqueado) {
        return demasiadosIntentos(
          'Demasiados intentos. Espera unos minutos antes de reintentar.',
          limite.reintentarEnSeg,
        );
      }

      const ok = user ? await verifyPassword(password, user.passwordHash) : false;
      if (!user || !ok) {
        // Un único camino para "no existe" y "contraseña mala": ni el mensaje
        // ni el status permiten distinguir un email registrado de uno que no.
        await registrarFallo(keyLogin);
        return json({ error: 'Email o contraseña incorrectos' }, 401);
      }

      await limpiarFallos(keyLogin);
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

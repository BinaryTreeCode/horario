import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { eq, and, lt } from 'drizzle-orm';
import { db, isDbConfigured } from './db';
import { users, sessions } from './schema';

const scryptAsync = promisify(scrypt) as (p: string, s: Buffer, l: number) => Promise<Buffer>;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
export const SESSION_COOKIE = 'np_session';

// ── Contraseñas ──────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

// ── Sesiones ─────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Crea una sesión en BD y devuelve el token plano para la cookie. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  // Limpieza oportunista de sesiones vencidas
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return { token, expiresAt };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

/** Resuelve el usuario de la cookie de sesión; null si no hay sesión válida. */
export async function getSessionUser(cookies: {
  get(name: string): { value: string } | undefined;
}): Promise<SessionUser | null> {
  if (!isDbConfigured) return null;
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const rows = await db
      .select({ userId: sessions.userId, expiresAt: sessions.expiresAt, email: users.email, name: users.name })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
      return null;
    }
    return { id: row.userId, email: row.email, name: row.name };
  } catch {
    return null;
  }
}

/** Elimina la sesión actual (logout). */
export async function destroySession(cookies: {
  get(name: string): { value: string } | undefined;
}): Promise<void> {
  if (!isDbConfigured) return;
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (!token) return;
  try {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  } catch {}
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    expires: expiresAt,
  };
}

import type { APIRoute } from 'astro';
import { and, eq, gt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '../../server/db';
import { categories, activities, userSettings, dayOverrides } from '../../server/schema';
import { getSessionUser } from '../../server/auth';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Validación ligera del lado servidor ──────────────────────────────────────

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function isTime(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v);
}

function normNumber(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Sanea una actividad entrante; null si es irrecuperable. */
function normActivity(a: any): {
  id: string; categoryId: string; name: string; description: string | null; image: string | null;
  startTime: string; endTime: string; daysOfWeek: number[]; steps: unknown[] | null;
  updatedAt: number; deletedAt: number | null;
} | null {
  if (typeof a?.id !== 'string' || !a.id || a.id.length > 64) return null;
  const updatedAt = normNumber(a.updatedAt, Date.now());
  // Tombstones (deleted) pueden venir mínimos; los vivos requieren campos completos
  if (a.deletedAt) {
    return {
      id: a.id.slice(0, 64), categoryId: String(a.categoryId ?? 'rutina').slice(0, 64),
      name: String(a.name ?? '').slice(0, 255), description: null, image: typeof a.image === 'string' ? a.image.slice(0, 3_000_000) : null,
      startTime: '00:00', endTime: '00:00', daysOfWeek: [], steps: null,
      updatedAt, deletedAt: normNumber(a.deletedAt, updatedAt),
    };
  }
  if (typeof a.name !== 'string' || !a.name.trim()) return null;
  if (!isTime(a.startTime) || !isTime(a.endTime)) return null;
  const [sh, sm] = a.startTime.split(':').map(Number);
  const [eh, em] = a.endTime.split(':').map(Number);
  if (eh * 60 + em <= sh * 60 + sm) return null;
  const days = Array.isArray(a.daysOfWeek)
    ? [...new Set(a.daysOfWeek.filter((d: unknown) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((x: number, y: number) => x - y)
    : [];
  if (days.length === 0) return null;

  return {
    id: a.id.slice(0, 64),
    categoryId: String(a.categoryId ?? 'rutina').slice(0, 64),
    name: a.name.trim().slice(0, 255),
    description: typeof a.description === 'string' ? a.description.slice(0, 2000) : null,
    image: typeof a.image === 'string' ? a.image.slice(0, 3_000_000) : null,
    startTime: a.startTime,
    endTime: a.endTime,
    daysOfWeek: days,
    steps: Array.isArray(a.steps) ? a.steps.filter((s: any) => typeof s?.title === 'string') : null,
    updatedAt,
    deletedAt: null,
  };
}

function normCategory(c: any) {
  if (typeof c?.id !== 'string' || !c.id || typeof c?.label !== 'string' || !c.label.trim()) return null;
  return {
    id: c.id.slice(0, 64),
    label: c.label.trim().slice(0, 100),
    color: typeof c.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : '#999999',
    order: Number.isFinite(c.order) ? Math.trunc(c.order) : 0,
    updatedAt: normNumber(c.updatedAt, Date.now()),
    deletedAt: c.deletedAt ? normNumber(c.deletedAt, Date.now()) : null,
  };
}

function normSetting(s: any) {
  if (typeof s?.key !== 'string' || !s.key) return null;
  return {
    id: typeof s.id === 'string' ? s.id.slice(0, 64) : s.key.slice(0, 64),
    key: s.key.slice(0, 64),
    value: s.value ?? null,
    updatedAt: normNumber(s.updatedAt, Date.now()),
    deletedAt: s.deletedAt ? normNumber(s.deletedAt, Date.now()) : null,
  };
}

function normOverride(o: any) {
  if (!Number.isInteger(o?.day) || o.day < 0 || o.day > 6) return null;
  const acts = Array.isArray(o.activities) ? o.activities.filter((a: any) => typeof a?.id === 'number' || typeof a?.id === 'string') : [];
  return {
    day: o.day,
    activities: acts,
    updatedAt: normNumber(o.updatedAt, Date.now()),
    deletedAt: o.deletedAt ? normNumber(o.deletedAt, Date.now()) : null,
  };
}

// ── POST /api/sync — push (merge LWW) ────────────────────────────────────────

export const POST: APIRoute = async ({ cookies, request }) => {
  const user = await getSessionUser(cookies);
  if (!user) return json({ error: 'No autenticado' }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }

  const now = Date.now();
  let pushed = 0;

  try {
    // Categorías
    for (const raw of body.categories ?? []) {
      const c = normCategory(raw);
      if (!c) continue;
      await db
        .insert(categories)
        .values({ userId: user.id, ...c })
        .onConflictDoUpdate({
          target: [categories.userId, categories.id],
          set: {
            label: c.label, color: c.color, order: c.order,
            updatedAt: c.updatedAt, deletedAt: c.deletedAt,
          },
          // LWW: actualiza solo si el incoming (excluded) es más nuevo que el existente
          where: sql`${categories.updatedAt} < ${c.updatedAt}`
        });
      pushed++;
    }

    // Actividades
    for (const raw of body.activities ?? []) {
      const a = normActivity(raw);
      if (!a) continue;
      await db
        .insert(activities)
        .values({ userId: user.id, ...a })
        .onConflictDoUpdate({
          target: [activities.userId, activities.id],
          set: {
            categoryId: a.categoryId, name: a.name, description: a.description, image: a.image,
            startTime: a.startTime, endTime: a.endTime, daysOfWeek: a.daysOfWeek, steps: a.steps,
            updatedAt: a.updatedAt, deletedAt: a.deletedAt,
          },
          where: sql`${activities.updatedAt} < ${a.updatedAt}`
        });
      pushed++;
    }

    // Settings
    for (const raw of body.settings ?? []) {
      const s = normSetting(raw);
      if (!s) continue;
      await db
        .insert(userSettings)
        .values({ userId: user.id, ...s })
        .onConflictDoUpdate({
          target: [userSettings.userId, userSettings.id],
          set: { key: s.key, value: s.value, updatedAt: s.updatedAt, deletedAt: s.deletedAt },
          where: sql`${userSettings.updatedAt} < ${s.updatedAt}`
        });
      pushed++;
    }

    // DayOverrides
    for (const raw of body.dayOverrides ?? []) {
      const o = normOverride(raw);
      if (!o) continue;
      await db
        .insert(dayOverrides)
        .values({ userId: user.id, ...o })
        .onConflictDoUpdate({
          target: [dayOverrides.userId, dayOverrides.day],
          set: { activities: o.activities, updatedAt: o.updatedAt, deletedAt: o.deletedAt },
          where: sql`${dayOverrides.updatedAt} < ${o.updatedAt}`
        });
      pushed++;
    }

    return json({ ok: true, pushed, serverTime: now });
  } catch (err: any) {
    console.error('[sync/push]', err);
    return json({ error: 'Error en el push: ' + (err?.message ?? 'desconocido') }, 500);
  }
};

// ── GET /api/sync?since=<ms> — pull incremental ──────────────────────────────

export const GET: APIRoute = async ({ cookies, url }) => {
  const user = await getSessionUser(cookies);
  if (!user) return json({ error: 'No autenticado' }, 401);

  const since = Math.max(0, Number(url.searchParams.get('since') ?? '0') || 0);

  try {
    const [cats, acts, setts, ovrs] = await Promise.all([
      db.select().from(categories).where(and(eq(categories.userId, user.id), gt(categories.updatedAt, since))),
      db.select().from(activities).where(and(eq(activities.userId, user.id), gt(activities.updatedAt, since))),
      db.select().from(userSettings).where(and(eq(userSettings.userId, user.id), gt(userSettings.updatedAt, since))),
      db.select().from(dayOverrides).where(and(eq(dayOverrides.userId, user.id), gt(dayOverrides.updatedAt, since))),
    ]);

    const serverTime = Date.now();

    return json({
      categories: cats,
      activities: acts,
      settings: setts,
      dayOverrides: ovrs,
      serverTime,
      hasMore: false, // paginación futura si un usuario supera miles de filas
    });
  } catch (err: any) {
    console.error('[sync/pull]', err);
    return json({ error: 'Error en el pull: ' + (err?.message ?? 'desconocido') }, 500);
  }
};

import type { APIRoute } from 'astro';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '../../server/db';
import { categories, activities, userSettings, dayOverrides } from '../../server/schema';
import { getSessionUser } from '../../server/auth';
import { consumirPresupuestoSync } from '../../server/rateLimit';

export const prerender = false;

/**
 * Una fila que el guard LWW del servidor NO escribió. Se devuelve al cliente
 * con la fecha que tiene el servidor: sin ella el push no tendría salida (la
 * misma fila, con la misma fecha, se volvería a rechazar para siempre) y el
 * cliente no podría ni distinguir un rechazo de un envío bueno.
 *
 * 'a' activities · 'c' categories · 's' settings · 'o' dayOverrides.
 * 'k' es la clave (id, o el día del override) y 'u' el updatedAt del servidor.
 */
interface Rechazo { t: 'a' | 'c' | 's' | 'o'; k: string; u: number }

function demasiados(sync: { reintentarEnSeg: number }) {
  const res = json({ error: 'Demasiadas sincronizaciones seguidas. Espera un momento.' }, 429);
  res.headers.set('Retry-After', String(sync.reintentarEnSeg));
  return res;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Validación ligera del lado servidor ──────────────────────────────────────

const TIME_RE = /^(?:([01]?\d|2[0-3]):([0-5]\d)|24:00)$/;

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
    // description/image: texto plano O blob E2E "np1:..." (el servidor no lo lee:
    // solo acota longitud). El blob de description puede exceder los 2000 del
    // plano por el overhead base64+IV — tope mayor para el cifrado.
    description: typeof a.description === 'string' ? a.description.slice(0, a.description.startsWith('np1:') ? 6000 : 2000) : null,
    image: typeof a.image === 'string' ? a.image.slice(0, 3_000_000) : null,
    startTime: a.startTime,
    endTime: a.endTime,
    daysOfWeek: days,
    // steps: array plano legacy O string cifrado np1 (blob ilegible)
    steps: Array.isArray(a.steps)
      ? a.steps.filter((s: any) => typeof s?.title === 'string')
      : (typeof a.steps === 'string' && a.steps.startsWith('np1:') ? a.steps : null),
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

// ── Topes de payload ─────────────────────────────────────────────────────────
//
// Sin estos, un usuario autenticado (o un cookie robado) puede empujar arrays
// sin límite y llenar la base: el merge LWW acepta cualquier cosa que venga
// con un updatedAt más nuevo. Los tops de imagen en normActivity acotan la
// cadena, no el número de filas ni el tamaño del conjunto.

/** Máximo de filas por colección y por push. El planificador real usa menos. */
const MAX_FILAS = {
  categories: 200,
  activities: 2000,
  settings: 200,
  overrides: 7, // uno por día de la semana
};

/** Tope del body completo. Por encima, 413 sin tocar la BD. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Máximo de actividades embebidas en un override del día. */
const MAX_ACTOS_POR_OVERRIDE = 100;

/**
 * Devuelve como máximo `max` elementos de una colección del body. Lo que
 * exceda se descarta (el merge es por LWW, así que lo que viene después es
 * descartado de todos modos): es preferible perder filas viejas a escribir
 * miles de insert una sola vez.
 */
function listar(coleccion: unknown, max: number): unknown[] {
  if (!Array.isArray(coleccion)) return [];
  return coleccion.slice(0, max);
}

/**
 * Filas que `listar` deja fuera del lote. El cliente las contaba como
 * "subidas": su cursor avanzaba por encima y, como el filtro de "qué
 * va en el siguiente push" es un `>` estricto, esas filas no volvían
 * a intentarlo nunca. `truncado` es el contrato que lo evita.
 */
function descartadas(coleccion: unknown, max: number): number {
  return Array.isArray(coleccion) ? Math.max(0, coleccion.length - max) : 0;
}

/**
 * Un override guarda el día entero en un jsonb. Antes solo se filtraba por el
 * tipo de `id`, así que una fila podía traer actividades completas con su
 * imagen de hasta 3 MB cada una: un único registro de varios megabytes. Aquí
 * se acota el número de actividades y, sobre todo, el tamaño del jsonb.
 */
function acotarActsOverride(acts: any[]): any[] {
  const porDefecto = JSON.stringify({ day: 0, activities: [] }).length;
  let usado = porDefecto;
  const salida: any[] = [];
  for (const a of acts.slice(0, MAX_ACTOS_POR_OVERRIDE)) {
    const s = JSON.stringify(a);
    if (s === undefined) continue;
    // presupuesto generoso para el horario de un día, con margen para el
    // cifrado (base64 + IV) sin dejar pasar blobs de imagen completos.
    const tope = 512 * 1024;
    if (usado + s.length > tope) break;
    usado += s.length;
    salida.push(a);
  }
  return salida;
}

/**
 * Cuántas filas se escribieron DE VERDAD y cuáles devolvió el guard LWW.
 *
 * Los upserts de este endpoint son engañosos: `onConflictDoUpdate` con un
 * `where` que no se cumple NO da error, simplemente no escribe. Por eso un
 * `pushed++` al final del bucle contaba la INTENCIÓN, y el cliente subía su
 * cursor por encima de filas que la nube nunca tuvo: como el filtro de "qué va
 * en el siguiente push" es un `>` estricto, esa fila quedaba justo en el
 * cursor y no volvía a subir nunca. La edición desaparecía sin error y sin aviso.
 *
 * No se mide con `returning` sino comparando con lo que hay guardado tras el
 * bucle: la fila está escrita si y solo si su updatedAt es el que traía el lote
 * (el guard del servidor es `<`, así que cualquier otra cosa significa que no
 * se escribió). Si otro dispositivo escribió mientras tanto, el valor guardado
 * es el suyo: también se reporta como rechazo y el cliente se re-sella por
 * encima, que es exactamente lo que toca.
 */
async function repartoDeEscrituras<T>(
  tabla: any,
  userId: string,
  lote: T[],
  claveDe: (fila: T) => string | number,
  actualizado: (fila: T) => number,
  tipo: Rechazo['t'],
  rechazos: Rechazo[],
): Promise<number> {
  const claves = lote.map(claveDe);
  if (claves.length === 0) return 0;
  const guardadas = await db
    .select({ id: tabla.id, updatedAt: tabla.updatedAt })
    .from(tabla)
    .where(and(eq(tabla.userId, userId), inArray(tabla.id, claves)));
  const porClave = new Map<string, number>(guardadas.map(f => [String(f.id), f.updatedAt]));

  let escritas = 0;
  for (const fila of lote) {
    const clave = claveDe(fila);
    const enNube = porClave.get(String(clave));
    if (enNube !== undefined && enNube >= actualizado(fila)) {
      rechazos.push({ t: tipo, k: String(clave), u: enNube });
    } else {
      escritas++;
    }
  }
  return escritas;
}

// ── POST /api/sync — push (merge LWW) ────────────────────────────────────────

export const POST: APIRoute = async ({ cookies, request }) => {
  const user = await getSessionUser(cookies);
  if (!user) return json({ error: 'No autenticado' }, 401);

  // Presupuesto de sincronización POR USUARIO, antes de parsear el body: frena
  // el abuso de una sesión válida (o de una cookie robada) sin tocar el límite
  // de login, que cuenta fallos de contraseña y tumbaría el uso normal (el
  // cliente empuja y tira en cada ciclo, 2 requests por ciclo).
  const sync = await consumirPresupuestoSync(user.id);
  if (sync.bloqueado) return demasiados(sync);

  // Tope de body antes de parsear: un cuerpo enorme se rechaza sin gastar
  // CPU en el JSON.parse ni en las escrituras posteriores.
  const declared = Number(request.headers.get('content-length') ?? '0') || 0;
  if (declared > MAX_BODY_BYTES) {
    return json({ error: 'El cuerpo del push supera el límite permitido' }, 413);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  if (body === null || typeof body !== 'object') {
    return json({ error: 'JSON inválido' }, 400);
  }

  const now = Date.now();
  let pushed = 0;
  let truncado = 0;
  const rechazos: Rechazo[] = [];

  try {
    // Categorías
    truncado += descartadas(body.categories, MAX_FILAS.categories);
    const cats = listar(body.categories, MAX_FILAS.categories)
      .flatMap(raw => { const c = normCategory(raw); return c ? [c] : []; });
    for (const c of cats) {
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
    }
    pushed += await repartoDeEscrituras(categories, user.id, cats, c => c.id, c => c.updatedAt, 'c', rechazos);

    // Actividades
    truncado += descartadas(body.activities, MAX_FILAS.activities);
    const acts = listar(body.activities, MAX_FILAS.activities)
      .flatMap(raw => { const a = normActivity(raw); return a ? [a] : []; });
    for (const a of acts) {
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
    }
    pushed += await repartoDeEscrituras(activities, user.id, acts, a => a.id, a => a.updatedAt, 'a', rechazos);

    // Settings
    truncado += descartadas(body.settings, MAX_FILAS.settings);
    const sets = listar(body.settings, MAX_FILAS.settings)
      .flatMap(raw => { const x = normSetting(raw); return x ? [x] : []; });
    for (const x of sets) {
      await db
        .insert(userSettings)
        .values({ userId: user.id, ...x })
        .onConflictDoUpdate({
          target: [userSettings.userId, userSettings.id],
          set: { key: x.key, value: x.value, updatedAt: x.updatedAt, deletedAt: x.deletedAt },
          where: sql`${userSettings.updatedAt} < ${x.updatedAt}`
        });
    }
    pushed += await repartoDeEscrituras(userSettings, user.id, sets, x => x.id, x => x.updatedAt, 's', rechazos);

    // DayOverrides
    truncado += descartadas(body.dayOverrides, MAX_FILAS.overrides);
    const ovrs = listar(body.dayOverrides, MAX_FILAS.overrides)
      .flatMap(raw => { const o = normOverride(raw); return o ? [o] : []; });
    for (const o of ovrs) {
      const acotadas = acotarActsOverride(o.activities);
      // Se cuenta lo que el horario del día PERDIÓ (actividades), no
      // el override: son los cambios del usuario los que no llegan.
      truncado += o.activities.length - acotadas.length;
      await db
        .insert(dayOverrides)
        .values({ userId: user.id, ...o, activities: acotadas })
        .onConflictDoUpdate({
          target: [dayOverrides.userId, dayOverrides.day],
          set: { activities: acotadas, updatedAt: o.updatedAt, deletedAt: o.deletedAt },
          where: sql`${dayOverrides.updatedAt} < ${o.updatedAt}`
        });
    }
    pushed += await repartoDeEscrituras(dayOverrides, user.id, ovrs, o => o.day, o => o.updatedAt, 'o', rechazos);

    // 'pushed' son filas ESCRITAS y 'rechazados' las que el guard LWW no dejó
    // pasar. El cliente necesita las dos: solo con 'pushed' avanzaba su cursor
    // por encima de filas que la nube nunca vio y las perdía sin avisar.
    return json({ ok: true, pushed, rechazos, serverTime: now, truncado });
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

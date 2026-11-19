import type { APIRoute } from 'astro';
import { and, asc, eq, gt, inArray, or } from 'drizzle-orm';
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

const MAX_FUTURO_MS = 5 * 60 * 1000; // 5 minutos de tolerancia para desfase de reloj

function normTimestamp(n: unknown, fallback: number): number {
  const num = typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
  return Math.min(num, Date.now() + MAX_FUTURO_MS);
}

/** Sanea una actividad entrante; null si es irrecuperable. */
function normActivity(a: any): {
  id: string; categoryId: string; name: string; description: string | null; image: string | null;
  startTime: string; endTime: string; daysOfWeek: number[]; steps: unknown[] | null;
  updatedAt: number; deletedAt: number | null;
} | null {
  if (typeof a?.id !== 'string' || !a.id || a.id.length > 64) return null;
  const updatedAt = normTimestamp(a.updatedAt, Date.now());
  // Tombstones (deleted) pueden venir mínimos; los vivos requieren campos completos
  if (a.deletedAt) {
    return {
      id: a.id.slice(0, 64), categoryId: String(a.categoryId ?? 'rutina').slice(0, 64),
      name: String(a.name ?? '').slice(0, 255), description: null, image: null,
      startTime: '00:00', endTime: '00:00', daysOfWeek: [], steps: null,
      updatedAt, deletedAt: normTimestamp(a.deletedAt, updatedAt),
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
      ? a.steps.filter((s: any) => typeof s?.title === 'string').slice(0, 100)
      : (typeof a.steps === 'string' && a.steps.startsWith('np1:') ? a.steps.slice(0, 32_000) : null),
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
    order: Number.isSafeInteger(c.order) ? Math.max(-2147483648, Math.min(2147483647, c.order)) : 0,
    updatedAt: normTimestamp(c.updatedAt, Date.now()),
    deletedAt: c.deletedAt ? normTimestamp(c.deletedAt, Date.now()) : null,
  };
}

function normSetting(s: any) {
  if (typeof s?.key !== 'string' || !s.key) return null;
  const val = s.value !== undefined ? s.value : {};
  // Acotar tamaño de settings para evitar jsonb desmedido (máx 64 KB serializado)
  const valStr = JSON.stringify(val);
  if (valStr && valStr.length > 64 * 1024) return null;
  return {
    id: typeof s.id === 'string' ? s.id.slice(0, 64) : s.key.slice(0, 64),
    key: s.key.slice(0, 64),
    value: val,
    updatedAt: normTimestamp(s.updatedAt, Date.now()),
    deletedAt: s.deletedAt ? normTimestamp(s.deletedAt, Date.now()) : null,
  };
}

function normOverride(o: any) {
  if (!Number.isInteger(o?.day) || o.day < 0 || o.day > 6) return null;
  const acts = Array.isArray(o.activities) ? o.activities.filter((a: any) => typeof a?.id === 'number' || typeof a?.id === 'string') : [];
  return {
    day: o.day,
    activities: acts,
    updatedAt: normTimestamp(o.updatedAt, Date.now()),
    deletedAt: o.deletedAt ? normTimestamp(o.deletedAt, Date.now()) : null,
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

/** Tope del body completo (4 MB, acotado al límite de Vercel de 4.5 MB). */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

/** Una fila que `norm*` rechazó. `k` es la clave del CLIENTE (id, o el día). */
interface Ignorado { t: Rechazo['t']; k: string }

/**
 * Normaliza una colección contando lo que la normalización descartó.
 *
 * Estas filas no son rechazos del guard LWW ni truncados por límite: nunca
 * llegaron a existir en la nube. Sin devolverlas, el cliente ve `pushed +
 * rechazados == enviado` y avanza su cursor por encima de ellas — con el
 * filtro `>` estricto de "qué va en el siguiente push", fila muerta para
 * siempre y sin aviso. Es el mismo agujero que ya se cerró para el truncado
 * (`truncado` + cursorPushTrasLote), abierto un paso más abajo.
 */
function normalizar<T>(
  coleccion: unknown,
  max: number,
  tipo: Ignorado['t'],
  nom: (raw: any) => T | null,
  claveDe: (raw: any) => string,
  ignorados: Ignorado[],
): T[] {
  return listar(coleccion, max).flatMap(raw => {
    const fila = nom(raw);
    if (fila) return [fila];
    ignorados.push({ t: tipo, k: claveDe(raw) });
    return [];
  });
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
 * Tamaño de lote por sentencia SQL `INSERT ... ON CONFLICT DO UPDATE`.
 * Reduce N round-trips a Neon a ceil(N / SQL_BATCH_SIZE) manteniéndose muy por
 * debajo del límite de parámetros de PostgreSQL (65 535).
 */
const SQL_BATCH_SIZE = 100;

/**
 * Lee y parsea un body JSON acotando el número REAL de bytes leídos.
 *
 * Comprobar solo la cabecera `Content-Length` no basta: una petición con
 * `Transfer-Encoding: chunked` (o sin cabecera) se saltaría `MAX_BODY_BYTES`.
 * Leer el stream chunk a chunk permite abortar en cuanto se supera el límite
 * sin cargar cuerpos enormes en memoria ni gastar CPU en `JSON.parse`.
 */
export async function leerJsonAcotado(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: Record<string, any> } | { ok: false; status: 400 | 413; error: string }> {
  const declared = Number(request.headers.get('content-length') ?? '0') || 0;
  if (declared > maxBytes) {
    return { ok: false, status: 413, error: 'El cuerpo del push supera el límite permitido' };
  }

  let bytes: Uint8Array;
  if (request.body && typeof request.body.getReader === 'function') {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, status: 413, error: 'El cuerpo del push supera el límite permitido' };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, status: 400, error: 'JSON inválido' };
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    try {
      bytes = new Uint8Array(await request.arrayBuffer());
    } catch {
      return { ok: false, status: 400, error: 'JSON inválido' };
    }
    if (bytes.byteLength > maxBytes) {
      return { ok: false, status: 413, error: 'El cuerpo del push supera el límite permitido' };
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, status: 400, error: 'JSON inválido' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'JSON inválido' };
  }
  return { ok: true, body: body as Record<string, any> };
}

/**
 * Deduplica filas repetidas dentro del mismo lote por clave, conservando la de
 * mayor `updatedAt` (y en empate, la última). Postgres rechaza un `INSERT ...
 * ON CONFLICT DO UPDATE` que intenta afectar la misma clave dos veces en la
 * misma sentencia (código 21000).
 */
export function deduplicarLote<T>(
  lote: T[],
  claveDe: (fila: T) => string | number,
  actualizado: (fila: T) => number,
): T[] {
  const porClave = new Map<string, T>();
  for (const fila of lote) {
    const k = String(claveDe(fila));
    const prev = porClave.get(k);
    if (!prev || actualizado(fila) >= actualizado(prev)) {
      porClave.set(k, fila);
    }
  }
  return Array.from(porClave.values());
}

/**
 * Clasifica el resultado LWW de una fila tras el upsert con `.returning()`.
 *
 * - Si Postgres devolvió la fila en `.returning()` (`fueEscrita === true`), se
 *   insertó o actualizó de verdad (`updated_at < excluded.updated_at`) → `'escrita'`.
 * - Si Postgres NO la devolvió y `enNube > incomingUpdatedAt` → `'rechazada'`
 *   (la nube tiene una versión más nueva; el cliente debe re-sellar si corresponde).
 * - Si Postgres NO la devolvió y `enNube === incomingUpdatedAt` → `'sin_cambio'`
 *   (empate exacto: la nube ya tenía ese sello; NO se escribió, así que no infla
 *   `pushed`, ni se rechaza para no causar re-sellados infinitos en full push).
 */
export function clasificarEscritura(
  fueEscrita: boolean,
  enNube: number | undefined,
  incomingUpdatedAt: number,
): 'escrita' | 'sin_cambio' | 'rechazada' {
  if (fueEscrita) return 'escrita';
  if (enNube !== undefined && enNube > incomingUpdatedAt) {
    return 'rechazada';
  }
  return 'sin_cambio';
}

async function verificarNoEscritas<T>(
  tabla: any,
  /** Columna clave del lote (id, o `day` en overrides — dayOverrides NO tiene columna id). */
  columnaClave: any,
  userId: string,
  noEscritas: T[],
  claveDe: (fila: T) => string | number,
  actualizado: (fila: T) => number,
  tipo: Rechazo['t'],
  rechazos: Rechazo[],
): Promise<void> {
  if (noEscritas.length === 0) return;
  const porClave = new Map<string, number>();
  for (let i = 0; i < noEscritas.length; i += 500) {
    const claves = noEscritas.slice(i, i + 500).map(claveDe);
    const guardadas = await db
      .select({ id: columnaClave, updatedAt: tabla.updatedAt })
      .from(tabla)
      .where(and(eq(tabla.userId, userId), inArray(columnaClave, claves)));
    for (const f of guardadas) {
      porClave.set(String(f.id), f.updatedAt);
    }
  }

  for (const fila of noEscritas) {
    const clave = claveDe(fila);
    const enNube = porClave.get(String(clave));
    if (clasificarEscritura(false, enNube, actualizado(fila)) === 'rechazada') {
      rechazos.push({ t: tipo, k: String(clave), u: enNube! });
    }
  }
}

async function upsertEnLotes<T>(
  lote: T[],
  claveDe: (fila: T) => string | number,
  actualizado: (fila: T) => number,
  ejecutarChunk: (chunk: T[]) => Promise<{ id: string | number }[]>,
  tabla: any,
  columnaClave: any,
  userId: string,
  tipo: Rechazo['t'],
  rechazos: Rechazo[],
): Promise<number> {
  if (lote.length === 0) return 0;
  const escritasSet = new Set<string>();
  for (let i = 0; i < lote.length; i += SQL_BATCH_SIZE) {
    const chunk = lote.slice(i, i + SQL_BATCH_SIZE);
    const filasEscritas = await ejecutarChunk(chunk);
    for (const row of filasEscritas) {
      escritasSet.add(String(row.id));
    }
  }

  const noEscritas = lote.filter(fila => !escritasSet.has(String(claveDe(fila))));
  await verificarNoEscritas(tabla, columnaClave, userId, noEscritas, claveDe, actualizado, tipo, rechazos);
  return escritasSet.size;
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

  // Tope REAL de bytes del body antes de parsear (cubre también chunked).
  const parsed = await leerJsonAcotado(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return json({ error: parsed.error }, parsed.status);
  }
  const body = parsed.body;

  const now = Date.now();
  let pushed = 0;
  let truncado = 0;
  const rechazos: Rechazo[] = [];
  const ignorados: Ignorado[] = [];

  try {
    // Categorías
    truncado += descartadas(body.categories, MAX_FILAS.categories);
    const cats = deduplicarLote(
      normalizar(body.categories, MAX_FILAS.categories, 'c', normCategory, r => String(r?.id ?? ''), ignorados),
      c => c.id,
      c => c.updatedAt,
    );
    pushed += await upsertEnLotes(
      cats,
      c => c.id,
      c => c.updatedAt,
      chunk =>
        db
          .insert(categories)
          .values(chunk.map(c => ({ userId: user.id, ...c })))
          .onConflictDoUpdate({
            target: [categories.userId, categories.id],
            set: {
              label: sql`excluded.label`,
              color: sql`excluded.color`,
              order: sql`excluded."order"`,
              updatedAt: sql`excluded.updated_at`,
              deletedAt: sql`excluded.deleted_at`,
            },
            where: sql`${categories.updatedAt} < excluded.updated_at`,
          })
          .returning({ id: categories.id }),
      categories,
      categories.id,
      user.id,
      'c',
      rechazos,
    );

    // Actividades
    truncado += descartadas(body.activities, MAX_FILAS.activities);
    const acts = deduplicarLote(
      normalizar(body.activities, MAX_FILAS.activities, 'a', normActivity, r => String(r?.id ?? ''), ignorados),
      a => a.id,
      a => a.updatedAt,
    );
    pushed += await upsertEnLotes(
      acts,
      a => a.id,
      a => a.updatedAt,
      chunk =>
        db
          .insert(activities)
          .values(chunk.map(a => ({ userId: user.id, ...a })))
          .onConflictDoUpdate({
            target: [activities.userId, activities.id],
            set: {
              categoryId: sql`excluded.category_id`,
              name: sql`excluded.name`,
              description: sql`excluded.description`,
              image: sql`excluded.image`,
              startTime: sql`excluded.start_time`,
              endTime: sql`excluded.end_time`,
              daysOfWeek: sql`excluded.days_of_week`,
              steps: sql`excluded.steps`,
              updatedAt: sql`excluded.updated_at`,
              deletedAt: sql`excluded.deleted_at`,
            },
            where: sql`${activities.updatedAt} < excluded.updated_at`,
          })
          .returning({ id: activities.id }),
      activities,
      activities.id,
      user.id,
      'a',
      rechazos,
    );

    // Settings
    truncado += descartadas(body.settings, MAX_FILAS.settings);
    const sets = deduplicarLote(
      normalizar(body.settings, MAX_FILAS.settings, 's', normSetting, r => String(r?.id ?? r?.key ?? ''), ignorados),
      x => x.id,
      x => x.updatedAt,
    );
    pushed += await upsertEnLotes(
      sets,
      x => x.id,
      x => x.updatedAt,
      chunk =>
        db
          .insert(userSettings)
          .values(chunk.map(x => ({ userId: user.id, ...x })))
          .onConflictDoUpdate({
            target: [userSettings.userId, userSettings.id],
            set: {
              key: sql`excluded.key`,
              value: sql`excluded.value`,
              updatedAt: sql`excluded.updated_at`,
              deletedAt: sql`excluded.deleted_at`,
            },
            where: sql`${userSettings.updatedAt} < excluded.updated_at`,
          })
          .returning({ id: userSettings.id }),
      userSettings,
      userSettings.id,
      user.id,
      's',
      rechazos,
    );

    // DayOverrides
    truncado += descartadas(body.dayOverrides, MAX_FILAS.overrides);
    const ovrs = deduplicarLote(
      normalizar(body.dayOverrides, MAX_FILAS.overrides, 'o', normOverride, r => String(r?.day ?? ''), ignorados),
      o => o.day,
      o => o.updatedAt,
    ).map(o => {
      const acotadas = acotarActsOverride(o.activities);
      // Se cuenta lo que el horario del día PERDIÓ (actividades), no
      // el override: son los cambios del usuario los que no llegan.
      truncado += o.activities.length - acotadas.length;
      return { ...o, activities: acotadas };
    });
    pushed += await upsertEnLotes(
      ovrs,
      o => o.day,
      o => o.updatedAt,
      chunk =>
        db
          .insert(dayOverrides)
          .values(chunk.map(o => ({ userId: user.id, ...o })))
          .onConflictDoUpdate({
            target: [dayOverrides.userId, dayOverrides.day],
            set: {
              activities: sql`excluded.activities`,
              updatedAt: sql`excluded.updated_at`,
              deletedAt: sql`excluded.deleted_at`,
            },
            where: sql`${dayOverrides.updatedAt} < excluded.updated_at`,
          })
          .returning({ id: dayOverrides.day }),
      dayOverrides,
      dayOverrides.day,
      user.id,
      'o',
      rechazos,
    );

    // 'pushed' son filas REALMENTE ESCRITAS (insertadas o actualizadas por
    // Postgres vía RETURNING). 'rechazos'/'rechazados' son las que tenían una
    // versión más nueva en la nube. 'ignorados' son las descartadas por
    // normalización. Los empates exactos no inflan `pushed` ni generan rechazo.
    return json({
      ok: true,
      pushed,
      rechazos,
      rechazados: rechazos,
      ignorados,
      serverTime: now,
      truncado,
    });
  } catch (err: any) {
    console.error('[sync/push]', err);
    return json({ error: 'Error en el servidor al sincronizar cambios' }, 500);
  }
};

// ── GET /api/sync?since=<ms> — pull incremental ──────────────────────────────

export function parsePullCursor(
  raw: string | null,
  numericKey: boolean,
): { done: true } | { ts: number; key: string | number } | null {
  if (!raw) return null;
  if (raw === 'done') return { done: true };
  const sep = raw.indexOf('|');
  if (sep <= 0) return null;
  const ts = Number(raw.slice(0, sep));
  const keyStr = raw.slice(sep + 1);
  if (!Number.isFinite(ts) || ts < 0 || !keyStr) return null;
  if (numericKey) {
    const dayNum = Number(keyStr);
    if (!Number.isInteger(dayNum)) return null;
    return { ts, key: dayNum };
  }
  return { ts, key: keyStr };
}

async function pullPage<T extends { updatedAt: number }>(
  table: any,
  keyCol: any,
  userId: string,
  since: number,
  rawCursor: string | null,
  limit: number,
  numericKey = false,
): Promise<{ rows: T[]; nextCursor: string }> {
  const cursor = parsePullCursor(rawCursor, numericKey);
  if (cursor && 'done' in cursor) {
    return { rows: [], nextCursor: 'done' };
  }
  const filter = cursor
    ? or(
        gt(table.updatedAt, cursor.ts),
        and(eq(table.updatedAt, cursor.ts), gt(keyCol, cursor.key)),
      )
    : gt(table.updatedAt, since);

  const fetched = (await db
    .select()
    .from(table)
    .where(and(eq(table.userId, userId), filter))
    .orderBy(asc(table.updatedAt), asc(keyCol))
    .limit(limit + 1)) as T[];

  if (fetched.length <= limit) {
    return { rows: fetched, nextCursor: 'done' };
  }
  const rows = fetched.slice(0, limit);
  const last = rows[rows.length - 1] as any;
  const pkVal = numericKey ? last.day : last.id;
  return { rows, nextCursor: `${last.updatedAt}|${pkVal}` };
}

export const GET: APIRoute = async ({ cookies, url }) => {
  try {
    const user = await getSessionUser(cookies);
    if (!user) return json({ error: 'No autenticado' }, 401);

    // Mismo presupuesto de sincronización que POST para frenar bucles o abuso
    // de pulls completos (since=0) con una sesión válida.
    const sync = await consumirPresupuestoSync(user.id);
    if (sync.bloqueado) return demasiados(sync);

    const since = Math.max(0, Number(url.searchParams.get('since') ?? '0') || 0);
    const PULL_LIMIT = 2000;

    const [cPage, aPage, sPage, oPage] = await Promise.all([
      pullPage(categories, categories.id, user.id, since, url.searchParams.get('cCursor'), PULL_LIMIT),
      pullPage(activities, activities.id, user.id, since, url.searchParams.get('aCursor'), PULL_LIMIT),
      pullPage(userSettings, userSettings.id, user.id, since, url.searchParams.get('sCursor'), PULL_LIMIT),
      pullPage(dayOverrides, dayOverrides.day, user.id, since, url.searchParams.get('oCursor'), PULL_LIMIT, true),
    ]);

    const serverTime = Date.now();
    const hasMore = [cPage.nextCursor, aPage.nextCursor, sPage.nextCursor, oPage.nextCursor]
      .some(c => c !== 'done');

    return json({
      categories: cPage.rows,
      activities: aPage.rows,
      settings: sPage.rows,
      dayOverrides: oPage.rows,
      serverTime,
      hasMore,
      ...(hasMore
        ? {
            cursors: {
              c: cPage.nextCursor,
              a: aPage.nextCursor,
              s: sPage.nextCursor,
              o: oPage.nextCursor,
            },
          }
        : {}),
    });
  } catch (err: any) {
    console.error('[sync/pull]', err);
    return json({ error: 'Error en el servidor al recuperar cambios' }, 500);
  }
};

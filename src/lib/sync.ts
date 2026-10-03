import { db, now } from './db';
import type { Table } from 'dexie';
import type { Activity, Category, AppSettings, DayOverride, SyncState, SyncStatus } from './types';
import { cifrarCampo, descifrarCampo, esCifrado, tieneClave } from './crypto';
import { esDataUrlImagen, subirABlob } from './routineImages';

// ── Cifrado E2E de campos sensibles ─────────────────────────────────────
// description, steps e image se cifran en el dispositivo (AES-GCM, clave
// derivada del password con PBKDF2 — ver crypto.ts) ANTES del push. La nube
// guarda blobs "np1:..." que no puede leer. En el pull se descifran para la
// UI. Sin clave en memoria (sesión restaurada por cookie tras recargar),
// los blobs se dejan como están: la UI muestra el marcador y el próximo
// login con password los vuelve legibles.

/** Campos de una actividad que viajan cifrados. */
async function cifrarActividad(a: Activity): Promise<Activity> {
  if (!tieneClave()) return a;
  try {
    return {
      ...a,
      description: a.description ? await cifrarCampo(a.description) : a.description,
      image: a.image ? await cifrarCampo(a.image) : a.image,
      steps: a.steps ? ((await cifrarCampo(JSON.stringify(a.steps))) as unknown as typeof a.steps) : a.steps,
    };
  } catch {
    return a; // sin clave o error: envía plano (el pull legacy ya lo entiende)
  }
}

/** Descifra los campos E2E de una actividad entrante (o los deja si son legacy). */
async function descifrarActividad(a: any): Promise<Activity> {
  if (!esCifrado(a.description) && !esCifrado(a.image) && !esCifrado(a.steps)) return a as Activity;
  if (!tieneClave()) {
    // Sin clave: reemplazar blobs por marcador neutro (la UI no debe mostrar "np1:0:...")
    return {
      ...a,
      description: esCifrado(a.description) ? '🔒 Contenido cifrado — inicia sesión de nuevo' : a.description,
      image: esCifrado(a.image) ? null : a.image,
      steps: esCifrado(a.steps) ? [] : a.steps,
    } as Activity;
  }
  try {
    return {
      ...a,
      description: esCifrado(a.description) ? await descifrarCampo(a.description) : a.description,
      image: esCifrado(a.image) ? await descifrarCampo(a.image) : a.image,
      steps: esCifrado(a.steps) ? JSON.parse(await descifrarCampo(a.steps)) : a.steps,
    } as Activity;
  } catch {
    return a as Activity; // blob corrupto/otra clave: no romper el pull
  }
}

/** Cifra los steps de las actividades dentro de un dayOverride. */
async function cifrarOverride(o: DayOverride): Promise<DayOverride> {
  if (!tieneClave() || !o.activities?.length) return o;
  try {
    return {
      ...o,
      activities: await Promise.all(o.activities.map(a => cifrarActividad(a))),
    };
  } catch {
    return o;
  }
}

/** Descifra los steps de las actividades de un dayOverride entrante. */
async function descifrarOverride(o: any): Promise<DayOverride> {
  if (!o?.activities?.length) return o as DayOverride;
  try {
    return { ...o, activities: await Promise.all(o.activities.map((a: any) => descifrarActividad(a))) } as DayOverride;
  } catch {
    return o as DayOverride;
  }
}

// ── Estado global de sincronización (para la UI) ─────────────────────────────

type Listener = (status: SyncStatus, detail: { pending: number; error?: string; lastSyncAt?: number }) => void;

let status: SyncStatus = 'local';
let pendingCount = 0;
let lastError: string | undefined;
let lastSyncAt: number | undefined;
const listeners = new Set<Listener>();

// ── Sesión: la cookie es la fuente de verdad, no el estado local ─────────────
// La cookie vive 30 días, así que la mayoría de las sesiones NO pasan por el
// login interactivo: si el motor no la comprueba al abrir la app se queda en
// 'local' para siempre. Con eso los hooks de Dexie descartaban cada cambio
// (`scheduleSync` retornaba temprano), los listeners de online/visibilidad no
// hacían nada y el push solo ocurría al pulsar "Sincronizar ahora" en Ajustes.
// Traducido: la nube no sincronizaba entre dispositivos entre sesiones.
let sesionActiva = false;

/** ¿Hay sesión cookie viva? La resuelve arrancarSync al abrir la app. */
export function tieneSesion(): boolean {
  return sesionActiva;
}

// El pull ESCRIBE filas y esas escrituras disparan los hooks de Dexie. Sin este
// freno, el pull programaba un push que volvía a escribir, que programaba otro
// pull… un ciclo de sincronización cada 3 s para siempre, en cada dispositivo
// con sesión. Solo se apaga durante la escritura del pull (ver pullChanges).
let escribiendoNube = false;

/** ¿Hay una escritura de red en curso (los hooks no deben Encadenar) */
function enEscrituraDeNube(): boolean {
  return escribiendoNube;
}

// ── Pausa de push tras importación ──────────────────────────────────────────
// Al importar un respaldo, el usuario reemplaza TODOS los datos locales. Subir
// eso a la nube por defecto SOBREESCRIBIRÍA el respaldo remoto con LWW (los
// registros importados salen con updatedAt fresco). Pausa solicitada: tras un
// import, el push queda bloqueado hasta que el usuario lo reactive.
let pushPaused = false;

/** ¿El push está pausado (tras importación)? */
export function isPushPaused(): boolean {
  return pushPaused;
}

/** Restaura la pausa persistida (llamar una vez al iniciar la app, tras abrir la BD). */
export async function restorePushPause(): Promise<void> {
  try {
    const state = await db.syncState.get('1');
    pushPaused = !!state?.pendingPushPaused;
  } catch { pushPaused = false; }
}

/** Pausa el push a la nube (lo llama el import) y persiste el estado. */
export async function pausePushAfterImport(): Promise<void> {
  pushPaused = true;
  await persistState();
  // persistState escribe la fila completa; marcar la pausa en el campo dedicado.
  await db.syncState.put({ ...(await db.syncState.get('1')), id: '1', pendingPushPaused: true });
  // NO se toca el estado: poner 'local' aquí apagaba los triggers de todo el
  // motor (scheduleSync los ignora) y, con cookie viva, la nube se quedaba muda
  // para siempre tras importar. El push ya está bloqueado por `pushPaused`;
  // el pull automático sigue vivo, que es lo que el usuario pidió.
}

/** Reactiva el push y lanza un sync completo (sube los datos importados). */
export async function resumePushAndSync(): Promise<void> {
  pushPaused = false;
  await db.syncState.put({ ...(await db.syncState.get('1')), id: '1', pendingPushPaused: false });
  await persistState();
  if (await isLoggedIn()) {
    await syncNow(true).catch(() => { /* estado ya en error/offline */ });
  }
}

export function onSyncChange(fn: Listener): () => void {
  listeners.add(fn);
  fn(status, { pending: pendingCount, error: lastError, lastSyncAt });
  return () => listeners.delete(fn);
}

function setStatus(next: SyncStatus, error?: string) {
  status = next;
  if (error !== undefined) lastError = error;
  if (next === 'synced' || next === 'local') lastError = error;
  persistState();
  for (const fn of listeners) fn(status, { pending: pendingCount, error: lastError, lastSyncAt });
}

async function persistState() {
  try {
    // MERGE con lo persistido: lastPushAt/lastServerPullAt son cursores del
    // dispositivo que NINGÚN setStatus puede borrar (perderlos re-traería la
    // nube entera al próximo pull y desincronizaría el push incremental).
    const prev = await db.syncState.get('1');
    const state: SyncState = {
      id: '1',
      pendingChanges: pendingCount,
      lastError,
      lastErrorAt: lastError ? Date.now() : undefined,
      lastPullAt: lastSyncAt,
      lastPushAt: prev?.lastPushAt,
      lastServerPullAt: prev?.lastServerPullAt,
      // Pausa de push persistente: sobrevive recargas y reinicios de la app.
      pendingPushPaused: prev?.pendingPushPaused ?? false,
    };
    await db.syncState.put(state);
  } catch { /* la UI no debe fallar por esto */ }
}

// ──Helpers de red ────────────────────────────────────────────────────────────

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

// ── Qué viaja y hasta dónde (puros: el motor de sync no se puede testear sin
//    IndexedDB, pero estas dos decisiones sí, y son las que rompían la nube) ──

/**
 * Un registro con updatedAt 0 (o ausente) es SEMILLA: lo puso la app al abrir
 * una base nueva (db.initializeDefaults), no el usuario — el propio código lo
 * anota como "el LWW no debe tratarlos como frescos". El filtro por cursor ya
 * la dejaba fuera; esto lo vuelve un contrato explícito (y blinda el caso de
 * una fila vieja sin updatedAt, que el where().index no garantiza).
 */
export function esSemilla(row: { updatedAt: number }): boolean {
  return !(row.updatedAt > 0);
}

/** Filas que entran en un push: posteriores al cursor y que no son semilla. */
export function seleccionables<T extends { updatedAt: number }>(rows: T[], cursor: number): T[] {
  return rows.filter(r => r.updatedAt > cursor && !esSemilla(r));
}

/**
 * Cursor del push tras un envío. NO puede ser el reloj del servidor: si va
 * adelantado a los updatedAt locales, todo lo creado entre ambos relojes queda
 * fuera del push siguiente y no vuelve a viajar nunca. Se queda con el mayor
 * updatedAt realmente enviado — reenviar un lote viejo es inofensivo (el LWW
 * del servidor solo acepta lo más nuevo), perderlo no.
 */
export function cursorPushTras(
  serverTime: number,
  enviados: { updatedAt: number }[],
  cursorPrevio: number
): number {
  if (enviados.length === 0) return cursorPrevio; // nada enviado: no avanzar
  const mayor = enviados.reduce((m, r) => Math.max(m, r.updatedAt), 0);
  return Math.min(serverTime, Math.max(mayor, cursorPrevio));
}

/**
 * Cursor del pull. El servidor fecha el lote con SU reloj y el SELECT filtra
 * `updatedAt > since`: un cambio remoto escrito justo en la frontera
 * (updatedAt <= serverTime, pero que el SELECT aún no veía) se perdía para
 * siempre. Retroceder unos segundos solapa lecturas consecutivas; reaplicar
 * filas viejas no hace daño (el LWW local solo entra si es más nuevo).
 */
export function cursorPull(serverTime: number, solapeMs = 5000): number {
  return Math.max(0, serverTime - solapeMs);
}

// ── Push: enviar cambios locales (LWW en el servidor) ────────────────────────

/**
 * Recolecta los registros con updatedAt > lastPushAt (o todos si full=true)
 * y los envía al servidor. El servidor hace upsert con guard LWW.
 */
// ── Migración de data-URLs a Vercel Blob ──────────────────────────────────
// Las imágenes de rutina antiguas viven como data-URL base64 (hasta 2 MB) DENTRO
// de la actividad: llenan localStorage ("respaldo automático pausado") y hacen
// HTTP 413 en el push. Al empujar con sesión activa, cada data-URL se sube una
// vez a Vercel Blob y la actividad pasa a guardar la URL corta. Idempotente:
// una URL http(s)/blob ya migrada no se toca.

let migracionImagenesHecha = false;

async function migrarImagenesABlob(): Promise<void> {
  if (migracionImagenesHecha) return;
  const actividades = await db.activities.toArray();
  const pendientes = actividades.filter(a => esDataUrlImagen(a.image));
  if (pendientes.length === 0) {
    migracionImagenesHecha = true;
    return;
  }
  const overrides = await db.dayOverrides.toArray();
  const mapa = new Map<string, string>(); // data-URL → URL de Blob
  for (const a of pendientes) {
    try {
      const url = await subirABlob(a.image!);
      mapa.set(a.image!, url);
    } catch {
      // Sin Blob configurado o error puntual: esa imagen queda como está y
      // se reintenta en el próximo push (migracionImagenesHecha no se marca).
    }
  }
  if (mapa.size === 0) return; // nada migrado: reintento completo la próxima vez

  const stamp = now();
  await db.transaction('rw', db.activities, db.dayOverrides, async () => {
    for (const a of actividades) {
      const nueva = a.image && mapa.get(a.image);
      if (nueva) await db.activities.put({ ...a, image: nueva, updatedAt: stamp });
    }
    for (const o of overrides) {
      let cambio = false;
      const acts = o.activities.map(act => {
        const nueva = act.image && mapa.get(act.image);
        if (nueva) { cambio = true; return { ...act, image: nueva }; }
        return act;
      });
      if (cambio) await db.dayOverrides.put({ ...o, activities: acts, updatedAt: stamp });
    }
  });
  migracionImagenesHecha = true;
}

export async function pushChanges(full = false): Promise<number> {
  const state = (await db.syncState.get('1')) ?? { id: '1' };
  const cursor = full ? 0 : (state.lastPushAt ?? 0);

  await migrarImagenesABlob();

  // Lectura por tabla + filtro por cursor y semilla (contrato explícito: lo
  // que puso la app no es del usuario y no viaja).
  const [activities, categories, settings, dayOverrides] = await Promise.all([
    db.activities.toArray(),
    db.categories.toArray(),
    db.settings.toArray(),
    db.dayOverrides.toArray(),
  ]);
  const actsSuben = seleccionables(activities, cursor);
  const catsSuben = seleccionables(categories, cursor);
  const setsSuben = seleccionables(settings, cursor);
  const ovsSuben = seleccionables(dayOverrides, cursor);

  // E2E: cifrar los campos sensibles ANTES de salir del dispositivo. Solo si
  // hay clave en memoria (login reciente). Con sesión restaurada por cookie,
  // los datos viajan planos legacy hasta el próximo login con password.
  const actsCifradas = await Promise.all(actsSuben.map(a => cifrarActividad(a)));
  const ovsCifrados = await Promise.all(ovsSuben.map(o => cifrarOverride(o)));
  const payload = {
    activities: actsCifradas,
    categories: catsSuben,
    settings: setsSuben,
    dayOverrides: ovsCifrados,
  };
  const enviados = [...actsCifradas, ...catsSuben, ...setsSuben, ...ovsCifrados];
  const total = enviados.length;
  if (total === 0) return 0;

  pendingCount += total;
  setStatus('syncing');

  try {
    const res = await api<{ pushed: number; serverTime: number }>('/api/sync', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    pendingCount = Math.max(0, pendingCount - res.pushed);
    // MERGE: conservar los demás campos de la fila (persistState hace lo mismo
    // en la dirección contraria — los cursores nunca se pierden por un put parcial).
    const prev = await db.syncState.get('1');
    await db.syncState.put({
      ...prev,
      id: '1',
      lastPushAt: cursorPushTras(res.serverTime, enviados, cursor),
    });
    setStatus(pendingCount > 0 ? 'syncing' : 'synced');
    return res.pushed;
  } catch (err: any) {
    setStatus(navigator.onLine ? 'error' : 'offline', err?.message ?? 'Error de red');
    throw err;
  }
}

// ── Pull: traer cambios del servidor y aplicarlos con LWW local ──────────────

interface PullResponse {
  categories: any[]; activities: any[]; settings: any[]; dayOverrides: any[];
  serverTime: number; hasMore: boolean;
}

export async function pullChanges(): Promise<{ applied: number }> {
  const state = (await db.syncState.get('1')) ?? { id: '1' };
  const since = state.lastServerPullAt ?? 0;

  setStatus('syncing');
  // Freno de hooks: todo lo que se escriba abajo (incluido el syncState) es
  // una RESTITUCIÓN de lo que ya está en la nube. Sin este bloqueo, cada fila
  // aplicada programaba un push que volvía a escribir y a programar otro pull.
  escribiendoNube = true;
  try {
    const res = await api<PullResponse>(`/api/sync?since=${since}`);

    let applied = 0;

    await db.transaction('rw', db.activities, db.categories, db.settings, db.dayOverrides, db.syncState, async () => {
      for (const c of res.categories) {
        const local = await db.categories.get(c.id);
        if (!local || local.updatedAt <= c.updatedAt) {
          await db.categories.put({ ...c } as Category);
          applied++;
        }
      }
      for (const a of res.activities) {
        const local = await db.activities.get(a.id);
        if (!local || local.updatedAt <= a.updatedAt) {
          const aPlano = await descifrarActividad(a);
          await db.activities.put({ ...aPlano } as Activity);
          applied++;
        }
      }
      for (const s of res.settings) {
        const local = await db.settings.get(s.id);
        if (!local || local.updatedAt <= s.updatedAt) {
          await db.settings.put({ ...s } as AppSettings);
          applied++;
        }
      }
      for (const o of res.dayOverrides) {
        const local = await db.dayOverrides.get(o.day);
        if (!local || local.updatedAt <= o.updatedAt) {
          const oPlano = await descifrarOverride(o);
          await db.dayOverrides.put({ ...oPlano } as DayOverride);
          applied++;
        }
      }
      // El cursor va con holgura hacia atrás (cursorPull): solapar lecturas
      // permite que un cambio remoto escrito justo en la frontera llegue en el
      // siguiente pull en vez de perderse entre los relojes de los dos equipos.
      await db.syncState.put({ ...state, id: '1', lastServerPullAt: cursorPull(res.serverTime), lastPullAt: Date.now() });
    });

    lastSyncAt = Date.now();
    setStatus(pendingCount > 0 ? 'syncing' : 'synced');
    return { applied };
  } catch (err: any) {
    setStatus(navigator.onLine ? 'error' : 'offline', err?.message ?? 'Error de red');
    throw err;
  } finally {
    escribiendoNube = false;
  }
}

// ── Ciclo completo ───────────────────────────────────────────────────────────

let syncing = false;

/** Push + pull con exclusión mutua. Es la función que invocan los triggers. */
export async function syncNow(full = false): Promise<void> {
  if (syncing) return;
  // Push pausado tras import: solo pull (leer la nube no pisa lo importado,
  // el LWW local gana con updatedAt fresco); nada local viaja arriba.
  if (pushPaused && !full) {
    try {
      await pullChanges();
    } catch { /* estado ya en error/offline */ }
    return;
  }
  if (pushPaused && full) {
    return; // pausa explícita: ni push full (lo llama resumePushAndSync tras reactivar)
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    setStatus('offline');
    return;
  }
  syncing = true;
  try {
    await pushChanges(full);
    await pullChanges();
  } finally {
    syncing = false;
  }
}

// ── Arranque con sesión restaurada ────────────────────────────────────────────

/**
 * Única vía para que la nube funcione entre sesiones. Al abrir la app NO se
 * pasa por el login interactivo (la cookie dura 30 días), así que esta función
 * es la que resuelve si hay sesión y, si la hay, sincroniza de verdad.
 *
 * Orden: pull primero y push después. Al revés, el dispositivo nuevo subía su
 * horario semilla recién creado (updatedAt de ahora) y por LWW pisaba el
 * horario real que ya estaba en la nube — que es justo lo contrario de
 * "sincronizar entre dispositivos": el otro dispositivo perdía su semana.
 *
 * Los hooks están instalados antes (installSyncListeners) y, como aún no había
 * sesión, ninguno encoló nada: este es el primer y único sync del arranque.
 */
export async function arrancarSync(): Promise<void> {
  if (typeof window === 'undefined') return;
  let haySesion = false;
  try {
    haySesion = await isLoggedIn();
  } catch {
    haySesion = false; // fetch falló (sin red, servidor caído): modo local
  }
  if (!haySesion) {
    setStatus('local');
    return;
  }
  sesionActiva = true;
  if (!navigator.onLine) {
    setStatus('offline');
    return; // el pull al volver de la red lo dispara el listener 'online'
  }
  try {
    setStatus('syncing');
    await pullChanges();
    // Push incremental (no full): solo lo que el usuario tocó en este
    // dispositivo. La semilla tiene updatedAt 0 y se queda en casa.
    if (!pushPaused) await pushChanges(false);
  } catch {
    /* el estado ya quedó en error/offline; se reintenta con el listener */
  }
}

/** ¿Hay sesión activa? (la cookie httpOnly responde por nosotros) */
export async function isLoggedIn(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth?op=me', { credentials: 'same-origin' });
    const data = await res.json();
    return !!data?.user;
  } catch {
    return false;
  }
}

// ── Triggers automáticos ─────────────────────────────────────────────────────

let debounceTimer: any = null;
let listenersInstalled = false;

/** Marca que hubo cambios locales y agenda un sync (debounce 3s). */
export function scheduleSync() {
  if (typeof window === 'undefined') return;
  if (!sesionActiva) return; // sin sesión no sincroniza (la cookie aún sin verificar)
  if (pushPaused) return; // tras import: cambios locales NO viajan (petición explícita)
  if (enEscrituraDeNube()) return; // lo que sube/baja la nube no vuelve a encolar un sync
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    syncNow().catch(() => { /* el estado ya quedó en error/offline */ });
  }, 3000);
}

/** Instala listeners de red/visibilidad una única vez. */
export function installSyncListeners() {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;

  window.addEventListener('online', () => {
    if (sesionActiva) syncNow().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sesionActiva) {
      syncNow().catch(() => {});
    }
  });
  // Disparar sync cuando cambien los datos locales
  for (const table of [db.activities, db.categories, db.settings, db.dayOverrides]) {
    table.hook('creating', scheduleSync);
    table.hook('updating', scheduleSync);
    table.hook('deleting', scheduleSync);
  }
}

/**
 * Se llama tras login: sincronización inicial completa.
 * Pull primero por el mismo motivo que arrancarSync —al revés, el push del
 * dispositivo recién autenticado pisaría con su semilla el horario real que
 * ya está en la nube— y después push completo para subir también lo que el
 * usuario hubiera hecho antes de iniciar sesión.
 */
export async function initialSyncAfterLogin(): Promise<void> {
  sesionActiva = true;
  setStatus('syncing');
  await pullChanges();
  if (!pushPaused) await pushChanges(true);
}

/** Se llama tras logout: la app vuelve a modo solo-local. La pausa de push
 *  persiste: si el usuario importó sin subir, al volver a entrar tampoco debe
 *  subir (la decisión fue sobre esos datos, no sobre la sesión). */
export function resetSyncAfterLogout(): void {
  sesionActiva = false;
  status = 'local';
  pendingCount = 0;
  lastError = undefined;
  persistState();
  for (const fn of listeners) fn(status, { pending: 0 });
}

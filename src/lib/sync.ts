import { db, now } from './db';
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
  setStatus('local');
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

export function getSyncStatus(): SyncStatus {
  return status;
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

  const [activities, categories, settings, dayOverrides] = await Promise.all([
    db.activities.where('updatedAt').above(cursor).toArray(),
    db.categories.where('updatedAt').above(cursor).toArray(),
    db.settings.where('updatedAt').above(cursor).toArray(),
    db.dayOverrides.where('updatedAt').above(cursor).toArray(),
  ]);

  // E2E: cifrar los campos sensibles ANTES de salir del dispositivo. Solo si
  // hay clave en memoria (login reciente). Con sesión restaurada por cookie,
  // los datos viajan planos legacy hasta el próximo login con password.
  const actsCifradas = await Promise.all(activities.map(a => cifrarActividad(a)));
  const ovsCifrados = await Promise.all(dayOverrides.map(o => cifrarOverride(o)));
  const payload = { activities: actsCifradas, categories, settings, dayOverrides: ovsCifrados };
  const total = activities.length + categories.length + settings.length + dayOverrides.length;
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
    await db.syncState.put({ ...prev, id: '1', lastPushAt: res.serverTime });
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
      await db.syncState.put({ ...state, id: '1', lastServerPullAt: res.serverTime, lastPullAt: Date.now() });
    });

    lastSyncAt = Date.now();
    setStatus(pendingCount > 0 ? 'syncing' : 'synced');
    return { applied };
  } catch (err: any) {
    setStatus(navigator.onLine ? 'error' : 'offline', err?.message ?? 'Error de red');
    throw err;
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
  if (status === 'local') return; // sin sesión no sincroniza
  if (pushPaused) return; // tras import: cambios locales NO viajan (petición explícita)
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
    if (status !== 'local') syncNow().catch(() => {});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && status !== 'local') {
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
 * El primer pull trae todo del servidor (since=0) y el push envía todo lo local:
 * el merge LWW resuelve duplicados por id y gana la versión más nueva.
 */
export async function initialSyncAfterLogin(): Promise<void> {
  setStatus('syncing');
  await syncNow(true);
}

/** Se llama tras logout: la app vuelve a modo solo-local. La pausa de push
 *  persiste: si el usuario importó sin subir, al volver a entrar tampoco debe
 *  subir (la decisión fue sobre esos datos, no sobre la sesión). */
export function resetSyncAfterLogout(): void {
  status = 'local';
  pendingCount = 0;
  lastError = undefined;
  persistState();
  for (const fn of listeners) fn(status, { pending: 0 });
}

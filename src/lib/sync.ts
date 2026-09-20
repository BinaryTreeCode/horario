import { db, now } from './db';
import type { Activity, Category, AppSettings, DayOverride, SyncState, SyncStatus } from './types';

// ── Estado global de sincronización (para la UI) ─────────────────────────────

type Listener = (status: SyncStatus, detail: { pending: number; error?: string; lastSyncAt?: number }) => void;

let status: SyncStatus = 'local';
let pendingCount = 0;
let lastError: string | undefined;
let lastSyncAt: number | undefined;
const listeners = new Set<Listener>();

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
    const state: SyncState = {
      id: '1',
      pendingChanges: pendingCount,
      lastError,
      lastErrorAt: lastError ? Date.now() : undefined,
      lastPullAt: lastSyncAt,
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
export async function pushChanges(full = false): Promise<number> {
  const state = (await db.syncState.get('1')) ?? { id: '1' };
  const cursor = full ? 0 : (state.lastPushAt ?? 0);

  const [activities, categories, settings, dayOverrides] = await Promise.all([
    db.activities.where('updatedAt').above(cursor).toArray(),
    db.categories.where('updatedAt').above(cursor).toArray(),
    db.settings.where('updatedAt').above(cursor).toArray(),
    db.dayOverrides.where('updatedAt').above(cursor).toArray(),
  ]);

  const payload = { activities, categories, settings, dayOverrides };
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
    await db.syncState.put({ id: '1', lastPushAt: res.serverTime });
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
          await db.activities.put({ ...a } as Activity);
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
          await db.dayOverrides.put({ ...o } as DayOverride);
          applied++;
        }
      }
      await db.syncState.put({ id: '1', lastServerPullAt: res.serverTime, lastPullAt: Date.now() });
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

/** Se llama tras logout: la app vuelve a modo solo-local. */
export function resetSyncAfterLogout(): void {
  status = 'local';
  pendingCount = 0;
  lastError = undefined;
  persistState();
  for (const fn of listeners) fn(status, { pending: 0 });
}

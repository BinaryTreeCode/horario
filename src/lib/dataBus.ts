/**
 * Bus de notificaciones de mutación de datos.
 *
 * Reemplaza la reactividad automática de liveQuery de Dexie, que en 4.3/4.4
 * no notifica updates de filas pre-existentes (dexie/Dexie.js#2309) y dejaba
 * la UI congelada tras un drag & drop. Las stores (stores.ts) se registran
 * aquí y re-leen la BD ante cada notificación; db.ts emite las notificaciones
 * desde un middleware dbcore cuando una mutación se confirma.
 *
 * Las notificaciones se encolan y se enjuagan en un setTimeout: una
 * db.transaction() explícita confirma al completar su función async, así que
 * el enjuague corre POST-commit con el estado final (nunca lee estados
 * intermedios de una transacción).
 */

type Flush = (affected: Set<string>) => void;

const flushers = new Set<Flush>();
const dirty = new Set<string>();
let flushScheduled = false;

const channel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('nature-planner-data')
    : null;

/** Suscribe un enjuague; devuelve la función de des-suscripción. */
export function onDataChanged(flush: Flush): () => void {
  flushers.add(flush);
  return () => flushers.delete(flush);
}

/** Notifica mutaciones confirmadas en las tablas dadas (esta pestaña). */
export function notifyDataChange(tables: string | string[]) {
  const list = Array.isArray(tables) ? tables : [tables];
  for (const t of list) dirty.add(t);
  // Difunde a otras pestañas del mismo origen (la recepción NO re-difunde).
  try {
    channel?.postMessage({ tables: list });
  } catch {
    /* canal cerrado: ignorar */
  }
  scheduleFlush();
}

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  // setTimeout y no microtask: ver comentario del encabezado.
  setTimeout(() => {
    flushScheduled = false;
    if (dirty.size === 0) return;
    const affected = new Set(dirty);
    dirty.clear();
    for (const flush of flushers) {
      try {
        flush(affected);
      } catch (err) {
        console.error('[dataBus] listener falló:', err);
      }
    }
  }, 0);
}

// Recepción de otras pestañas: encola sin re-difundir (evita ping-pong).
if (channel) {
  channel.onmessage = (e: MessageEvent) => {
    const tables = (e.data as { tables?: unknown } | null)?.tables;
    if (Array.isArray(tables)) {
      for (const t of tables) if (typeof t === 'string') dirty.add(t);
      scheduleFlush();
    }
  };
}

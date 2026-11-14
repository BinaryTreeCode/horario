import { db, now, INITIAL_CATEGORIES } from './db';
import { clearUndo } from './undo';
import { notifyDataChange } from './dataBus';
import type { Table } from 'dexie';
import type { Activity, Category, AppSettings, DayOverride, SyncState, SyncStatus } from './types';
import { cifrarCampo, descifrarCampo, esCifrado, tieneClave, restaurarClave, olvidarClave } from './crypto';
import { esDataUrlImagen, subirABlob } from './routineImages';

// ── Cifrado E2E de campos sensibles ─────────────────────────────────────
// description, steps e image se cifran en el dispositivo (AES-GCM, clave
// derivada del password con PBKDF2 — ver crypto.ts) ANTES del push. La nube
// guarda blobs "np1:..." que no puede leer. En el pull se descifran para la
// UI. Si la clave no estuviera cargada en memoria, se intenta restaurar desde
// el almacenamiento seguro local (localStorage/sessionStorage); y si aún no
// hay clave, los datos existentes no se destruyen: se conserva lo que ya
// estaba legible o el blob intacto para descifrar tras el próximo login.

/** Marcador persistido cuando no hay clave E2E en memoria al bajar contenido cifrado. */
export const CONTENIDO_BLOQUEADO = '🔒 Contenido cifrado — inicia sesión de nuevo';

/** Campos de una actividad que viajan cifrados. */
async function cifrarActividad(a: Activity): Promise<Activity> {
  if (!tieneClave()) await restaurarClave();
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
export async function descifrarActividad(a: any, localExistente?: Activity): Promise<Activity> {
  if (!esCifrado(a.description) && !esCifrado(a.image) && !esCifrado(a.steps)) {
    let steps = a.steps;
    if (typeof steps === 'string' && steps.startsWith('[')) {
      try { steps = JSON.parse(steps); } catch { steps = []; }
    } else if (!Array.isArray(steps)) {
      steps = [];
    }
    return { ...a, steps } as Activity;
  }

  if (!tieneClave()) {
    await restaurarClave();
  }

  if (!tieneClave()) {
    // Sin clave: no destruir datos existentes.
    // Si tenemos una versión local con texto descifrado, CONSERVARLA.
    // Para la imagen, conservar el ciphertext para no perderlo.
    // Para steps, si la versión local tiene steps válidos, conservarlos.
    const stepsPreservados = Array.isArray(localExistente?.steps) && localExistente.steps.length > 0
      ? localExistente.steps
      : (Array.isArray(a.steps) ? a.steps : []);
    const descPreservada = localExistente?.description && !esCifrado(localExistente.description)
      ? localExistente.description
      : (esCifrado(a.description) ? CONTENIDO_BLOQUEADO : a.description);

    return {
      ...a,
      description: descPreservada,
      image: a.image ?? null,
      steps: stepsPreservados,
    } as Activity;
  }

  try {
    let steps = a.steps;
    if (esCifrado(a.steps)) {
      const planoSteps = await descifrarCampo(a.steps);
      try { steps = JSON.parse(planoSteps); } catch { steps = []; }
    } else if (typeof steps === 'string' && steps.startsWith('[')) {
      try { steps = JSON.parse(steps); } catch { steps = []; }
    } else if (!Array.isArray(steps)) {
      steps = [];
    }

    return {
      ...a,
      description: esCifrado(a.description) ? await descifrarCampo(a.description) : a.description,
      image: esCifrado(a.image) ? await descifrarCampo(a.image) : a.image,
      steps,
    } as Activity;
  } catch {
    return {
      ...a,
      description: localExistente?.description ?? a.description,
      image: a.image ?? null,
      steps: Array.isArray(localExistente?.steps) ? localExistente.steps : [],
    } as Activity;
  }
}

/** Cifra los steps de las actividades dentro de un dayOverride. */
async function cifrarOverride(o: DayOverride): Promise<DayOverride> {
  if (!tieneClave()) await restaurarClave();
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
async function descifrarOverride(o: any, localExistente?: DayOverride): Promise<DayOverride> {
  if (!o?.activities?.length) return o as DayOverride;
  try {
    const mapaLocales = new Map((localExistente?.activities ?? []).map(a => [a.id, a]));
    return {
      ...o,
      activities: await Promise.all(o.activities.map((a: any) => descifrarActividad(a, mapaLocales.get(a.id)))),
    } as DayOverride;
  } catch {
    return o as DayOverride;
  }
}

// ── Estado global de sincronización (para la UI) ─────────────────────────────

type Listener = (
  status: SyncStatus,
  detail: { pending: number; error?: string; lastSyncAt?: number; sesion: boolean; truncado: number }
) => void;

let status: SyncStatus = 'local';
let pendingCount = 0;
let lastError: string | undefined;
let lastSyncAt: number | undefined;
/** Cambios que el servidor DESCARTÓ en el último push (0 = todo cabía). */
let ultimoTruncado = 0;
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
// con sesión. Es un contador de profundidad para tolerar operaciones anidadas.
let escrituraNubeProfundidad = 0;

/** ¿Hay una escritura de red en curso (los hooks no deben Encadenar) */
function enEscrituraDeNube(): boolean {
  return escrituraNubeProfundidad > 0;
}

// Cola FIFO que serializa push/pull/arranque para evitar carreras entre hooks
// de Dexie, `syncState` y lecturas/descifrado fuera de transacción.
let colaSync: Promise<void> = Promise.resolve();
let syncActivo = 0;
let syncPendiente = false;
let fullPendiente = false;

function conLockSync<T>(fn: () => Promise<T>): Promise<T> {
  const prev = colaSync;
  let liberar!: () => void;
  colaSync = new Promise<void>(r => { liberar = r; });
  return prev.then(async () => {
    syncActivo++;
    try {
      return await fn();
    } finally {
      syncActivo--;
      liberar();
      if (syncActivo === 0 && syncPendiente && sesionActiva) {
        queueMicrotask(() => {
          if (syncPendiente && syncActivo === 0 && sesionActiva) {
            void syncNow(fullPendiente).catch(() => {});
          }
        });
      }
    }
  });
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
  fn(status, { pending: pendingCount, error: lastError, lastSyncAt, sesion: sesionActiva, truncado: ultimoTruncado });
  return () => listeners.delete(fn);
}

function setStatus(next: SyncStatus, error?: string) {
  status = next;
  if (error !== undefined) lastError = error;
  if (next === 'synced' || next === 'local') lastError = error;
  persistState();
  for (const fn of listeners) fn(status, { pending: pendingCount, error: lastError, lastSyncAt, sesion: sesionActiva, truncado: ultimoTruncado });
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
      // Desfase con el reloj del servidor: es lo que permite comparar fechas de
      // dos relojes distintos (ver sellarParaServidor). También es un cursor que
      // ningún setStatus puede tirar.
      sesgoServidor: prev?.sesgoServidor,
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
  if (res.status === 401) {
    // La cookie caducó o el servidor dejó de aceptarla. Con la sesión todavía
    // marcada como viva, el 401 caía en el error genérico: los triggers de Dexie
    // lo reintentaban cada 3 s PARA SIEMPRE y la UI nunca ofrecía volver a
    // entrar, porque el aviso era un estado de red. Apagarla devuelve la app al
    // modo local honesto: el motor se calla y el menú vuelve a enseñar "entrar".
    sesionActiva = false;
    throw Object.assign(new Error(SIN_SESION), { sinSesion: true });
  }
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
 * Cursor del push tras un envío. NO puede ser el reloj del servidor ni el mayor
 * updatedAt enviado sin más: las filas locales se sellan con el reloj del
 * DISPOSITIVO, así que cualquier cursor por delante de ese reloj empuja al
 * futuro todo lo que el usuario cree en los próximos segundos y eso no vuelve
 * a subirse nunca (sin error, sin aviso).
 *
 * El caso que lo destapó: al arrancar, el pull trae filas selladas por el reloj
 * del servidor y el push de arranque las reenvía. Si el servidor va un minuto
 * adelantado, "el mayor enviado" era ya un minuto futuro y el cursor congelaba
 * los cambios locales durante esa ventana entera.
 *
 * Regla: cursor = min(ahora del dispositivo, max(mayor enviado, cursor previo)).
 * Reenviar un lote viejo es inofensivo (el LWW del servidor solo acepta lo más
 * nuevo), perderse uno no.
 */
export function cursorPushTras(
  enviados: { updatedAt: number }[],
  cursorPrevio: number,
  ahora: number
): number {
  if (enviados.length === 0) return cursorPrevio; // nada enviado: no avanzar
  const mayor = enviados.reduce((m, r) => Math.max(m, r.updatedAt), 0);
  return Math.min(ahora, Math.max(mayor, cursorPrevio));
}

/**
 * Cursor tras un push que el servidor TRUNCÓ. Sus tope de lote
 * (`listar`: 2000 actividades, 7 overrides…) y de jsonb por override
 * (512 KB) descartan el excedente SIN rechazarlo: no llegó, así que
 * no está en `rechazos` y el cliente no sabría qué filas quedaron fuera.
 * Como el filtro de `seleccionables` es `>` estricto, un cursor que
 * avanzara por encima condenaría esas filas a no volver a subir jamás:
 * edición perdida, sin error y sin aviso. Con `truncado > 0` el cursor
 * se queda donde estaba y el próximo push reenvía el lote entero.
 */
export function cursorPushTrasLote(
  enviados: { updatedAt: number }[],
  cursorPrevio: number,
  ahora: number,
  truncado: number,
  /** Filas que la normalización del servidor descartó (norm* → null). */
  ignoradas = 0
): number {
  // Lo mismo que con el truncado: nada de lo que NO llegó puede darse por
  // subido, así que el cursor no avanza mientras quede algo fuera.
  if (truncado > 0 || ignoradas > 0) return cursorPrevio;
  return cursorPushTras(enviados, cursorPrevio, ahora);
}

/**
 * Aviso de descarte del servidor. El toast solo en la primera vez (o
 * si empeora): un push truncado se reintentará en cada ciclo y un
 * toast por ciclo sería spam. El detalle `truncado` deja el aviso
 * visible mientras persista (menú Datos y Ajustes).
 */
function avisoDeDescarte(truncado: number): void {
  const empeoro = truncado > ultimoTruncado;
  ultimoTruncado = truncado;
  if (!empeoro) return;
  // Import diferido: sync es lib pura y toast↔db ya son circulares.
  import('./toast').then(async ({ toastErr }) => {
    const { tNow } = await import('./i18n');
    toastErr(tNow('sync.truncado', { n: truncado }));
  });
}

/** Cambios que el servidor NO pudo validar (no son límite: son filas inválidas). */
let ultimosIgnorados = 0;

/**
 * Aviso de lo que la normalización del servidor descartó. Mismo criterio que
 * avisoDeDescarte (solo al empeorar): sin esto el usuario vería su cambio
 * "subido" y sin rastro, que es exactamente el fallo que había que cerrar.
 */
function avisoDeIgnorados(ignorados: number): void {
  const empeoro = ignorados > ultimosIgnorados;
  ultimosIgnorados = ignorados;
  if (!empeoro) return;
  import('./toast').then(async ({ toastErr }) => {
    const { tNow } = await import('./i18n');
    toastErr(tNow('sync.ignorados', { n: ignorados }));
  });
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

/**
 * Desfase entre el reloj del servidor y el del dispositivo, en milisegundos.
 *
 * El LWW compara fechas y solo funciona si las dos partes comparan con el MISMO
 * reloj. Las filas se sellan en el dispositivo con `Date.now()` y el servidor
 * sella con el suyo, así que un móvil con la hora sin ajustar (o un portátil
 * varios minutos atrás) nacía con cada cambio ya rechazado por el guard `<`:
 * un push que se agotaba en silencio. Se aprende de cada respuesta (que trae
 * `serverTime`) y se persiste.
 */
export function sesgoDe(serverTime: number, ahora: number): number {
  return serverTime - ahora;
}

/**
 * Sello de una fila tal como viaja por la nube: su fecha local traducida al
 * reloj del servidor. Es el mismo desfase que usa reestampar, aplicado al revés.
 */
export function sellarParaServidor<T extends { updatedAt: number }>(fila: T, sesgo: number): T {
  return { ...fila, updatedAt: fila.updatedAt + sesgo };
}

/**
 * Sello local de una fila que viene de la nube.
 *
 * El servidor manda su `updatedAt` y ese reloj no es el nuestro. Guardarlo tal
 * cual era un agujero con dos caras:
 *
 *  1) Si el servidor va adelantado, la fila queda localmente EN EL FUTURO y
 *     envenena el cursor del push siguiente (lo tapa el recorte a "ahora" de
 *     aquí, que existía justo para eso).
 *  2) Aunque no lo esté, la copia local queda con EXACTAMENTE la fecha que ya
 *     tiene en la nube, así que el push siguiente la reenvía y el guard estricto
 *     del servidor la vuelve a rechazar: un empate perpetuo en cada arranque.
 *
 * Regla: la copia local se sella un milisegundo POR ENCIMA de lo que hay en la
 * nube —traducido a nuestro reloj con el desfase aprendido— y nunca por delante
 * de "ahora". Así el push la acepta a la primera y cualquier cambio real que la
 * persona haga después la supera siempre.
 */
export function acotarFechaRemota<T extends { updatedAt: number }>(
  fila: T,
  ahora: number,
  sesgo = 0,
): T {
  const local = Math.min(fila.updatedAt - sesgo + 1, ahora);
  return local === fila.updatedAt ? fila : { ...fila, updatedAt: local };
}

/**
 * Sello local para una fila que el servidor rechazó. Un milisegundo por encima
 * de lo que hay allí, en NUESTRO reloj: sin esto la fila se reenvía con la
 * misma fecha y el guard la vuelve a rechazar, una y otra vez.
 */
export function reestampar(local: number, remoto: number, sesgo = 0): number {
  return Math.max(local, remoto - sesgo + 1);
}

/**
 * ¿La fila remota gana sobre la local? La pregunta del pull, hecha en UN solo reloj.
 *
 * `local.updatedAt` vive en el reloj del DISPOSITIVO (lo selló acotarFechaRemota
 * o lo escribió el usuario con Date.now()); `remota.updatedAt` llega en el reloj
 * del SERVIDOR. Compararlas crudas es comparar dos relojes distintos: con el
 * reloj local adelantado por más que el solape del pull (5 s), todo cambio
 * remoto parecía VIEJO, se descartaba en el único pull que lo traía, y como el
 * cursor de pull solo solapa 5 s ya no volvía a pedirlo nunca — un cambio
 * perdido para ese dispositivo, sin error y sin aviso.
 *
 * El resto del archivo ya traducía fechas por todas partes (sellarParaServidor
 * al salir, acotarFechaRemota al entrar); lo que faltaba era traducir ESTA
 * comparación. Un sesgo no numérico (respuesta vieja sin serverTime) se trata
 * como cero: mejor volver al comportamiento de antes que dejar el pull muerto
 * para siempre por un NaN.
 */
export function remotaGana<T extends { updatedAt: number }>(
  local: T | undefined,
  remota: { updatedAt: number },
  sesgo: number,
): boolean {
  if (!local) return true;
  const s = Number.isFinite(sesgo) ? sesgo : 0;
  return local.updatedAt <= remota.updatedAt - s;
}

/** ¿La fila conserva campos cifrados o el marcador bloqueado por falta de clave E2E? */
export function tieneContenidoBloqueado(fila: unknown): boolean {
  if (!fila || typeof fila !== 'object') return false;
  const r = fila as Record<string, unknown>;
  if (esCifrado(r.image) || esCifrado(r.description) || esCifrado(r.steps)) return true;
  if (r.description === CONTENIDO_BLOQUEADO) return true;
  if (Array.isArray(r.activities)) {
    return r.activities.some(sub => tieneContenidoBloqueado(sub));
  }
  return false;
}

function fuePulledaSinEdicionPosterior(
  local: { updatedAt: number },
  remota: { updatedAt: number },
  sesgo: number,
): boolean {
  const s = Number.isFinite(sesgo) ? sesgo : 0;
  return local.updatedAt <= remota.updatedAt - s + 1;
}

/**
 * ¿Debe aplicarse la fila remota durante el pull?
 * Además del LWW normal (`remotaGana`), permite recuperar filas que quedaron
 * guardadas con ciphertext / contenido bloqueado al bajarse sin clave E2E, sin
 * pisar ediciones locales hechas después.
 */
export function debeAplicarEnPull<T extends { updatedAt: number }>(
  local: T | undefined,
  remota: { updatedAt: number; steps?: unknown; activities?: unknown },
  sesgo: number,
  conClave: boolean,
): boolean {
  if (remotaGana(local, remota, sesgo)) return true;
  if (!conClave || !local) return false;
  if (tieneContenidoBloqueado(local)) return true;

  // Caso límite: solo `steps` estaba cifrado y al bajar sin clave quedó `steps: []`.
  if (!fuePulledaSinEdicionPosterior(local, remota, sesgo)) return false;
  const localRecord = local as unknown as Record<string, unknown>;
  if (esCifrado(remota.steps) && (!Array.isArray(localRecord.steps) || localRecord.steps.length === 0)) {
    return true;
  }
  if (Array.isArray(remota.activities) && Array.isArray(localRecord.activities)) {
    const mapaLocal = new Map<string, Record<string, unknown>>();
    for (const sub of localRecord.activities) {
      if (sub && typeof sub === 'object' && typeof (sub as any).id === 'string') {
        mapaLocal.set((sub as any).id, sub as Record<string, unknown>);
      }
    }
    return remota.activities.some((subRem: any) => {
      if (!subRem || typeof subRem !== 'object' || !esCifrado(subRem.steps)) return false;
      const subLoc = mapaLocal.get(subRem.id);
      return !subLoc || !Array.isArray(subLoc.steps) || subLoc.steps.length === 0;
    });
  }
  return false;
}

/**
 * Rellena únicamente los campos E2E que quedaron bloqueados en una copia local
 * sin sobrescribir cambios no cifrados locales ni alterar `local.updatedAt`.
 */
export function desbloquearCamposActividad(
  local: Activity,
  remotaDescifrada: Activity,
  remotaStepsCifrados = false,
  pulledaSinEdicionLocal = true,
): { fila: Activity; cambio: boolean } {
  let next = local;
  let cambio = false;

  const descBloqueada = local.description === CONTENIDO_BLOQUEADO || esCifrado(local.description);
  const descLista =
    remotaDescifrada.description !== CONTENIDO_BLOQUEADO && !esCifrado(remotaDescifrada.description);
  if (descBloqueada && descLista && local.description !== remotaDescifrada.description) {
    next = { ...next, description: remotaDescifrada.description };
    cambio = true;
  }

  const imgBloqueada = esCifrado(local.image);
  if (imgBloqueada && !esCifrado(remotaDescifrada.image) && local.image !== remotaDescifrada.image) {
    next = { ...next, image: remotaDescifrada.image };
    cambio = true;
  }

  const stepsVaciosPorBloqueo =
    (!Array.isArray(local.steps) || local.steps.length === 0) &&
    (descBloqueada || imgBloqueada || (remotaStepsCifrados && pulledaSinEdicionLocal));
  const stepsBloqueados = esCifrado(local.steps) || stepsVaciosPorBloqueo;
  if (
    stepsBloqueados &&
    Array.isArray(remotaDescifrada.steps) &&
    remotaDescifrada.steps.length > 0
  ) {
    next = { ...next, steps: remotaDescifrada.steps };
    cambio = true;
  }

  return { fila: next, cambio };
}

/** Equivalente a `desbloquearCamposActividad` para actividades dentro de `DayOverride`. */
export function desbloquearCamposOverride(
  local: DayOverride,
  remotaDescifrada: DayOverride,
  remotaRaw?: { updatedAt: number; activities?: any[] },
  sesgo = 0,
): { fila: DayOverride; cambio: boolean } {
  if (!Array.isArray(local.activities) || !Array.isArray(remotaDescifrada.activities)) {
    return { fila: local, cambio: false };
  }
  const mapaRem = new Map(remotaDescifrada.activities.map(a => [a.id, a]));
  const mapaRaw = new Map((remotaRaw?.activities ?? []).map((a: any) => [a.id, a]));
  const sinEdicionLocal = remotaRaw ? fuePulledaSinEdicionPosterior(local, remotaRaw, sesgo) : true;
  let cambio = false;
  const nuevas = local.activities.map(sub => {
    const rem = mapaRem.get(sub.id);
    if (!rem) return sub;
    const raw = mapaRaw.get(sub.id);
    const res = desbloquearCamposActividad(sub, rem, esCifrado(raw?.steps), sinEdicionLocal);
    if (res.cambio) cambio = true;
    return res.fila;
  });
  return cambio ? { fila: { ...local, activities: nuevas }, cambio: true } : { fila: local, cambio: false };
}

/**
 * Calcula `lastPushAt` tras aplicar un pull: cubre las filas recién escritas
 * (incluyendo el `+1` de `acotarFechaRemota`) para no re-subirlas sin motivo,
 * pero nunca salta por encima de ediciones locales previas aún pendientes.
 */
export function cursorPushTrasPull(
  cursorActual: number,
  fechasAplicadas: number[],
  fechasLocalesPendientes: number[],
  topeRelojLocal: number,
): number {
  if (fechasAplicadas.length === 0) return cursorActual;
  const maxAplicada = Math.min(topeRelojLocal, Math.max(...fechasAplicadas));
  const techoPendientes =
    fechasLocalesPendientes.length > 0
      ? Math.min(...fechasLocalesPendientes) - 1
      : maxAplicada;
  return Math.max(cursorActual, Math.min(maxAplicada, techoPendientes));
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

/** Respuesta del push: lo ESCRITO, lo RECHAZADO y lo DESCARTADO. */
interface RespuestaPush {
  /** Filas que el servidor guardó de verdad (antes contaba la intención). */
  pushed: number;
  /** Filas que el guard LWW no dejó pasar, con la fecha que tienen allí. */
  rechazados?: Rechazo[];
  /** Filas que el servidor descartó por sus tope (no llegó: no es rechazo). */
  truncado?: number;
  /** Filas que llegaron pero la normalización rechazó (nunca se escribieron). */
  ignorados?: { t: Rechazo['t']; k: string }[];
  serverTime: number;
}

/** Una fila que el servidor no aceptó: colección, clave y su fecha en la nube. */
interface Rechazo { t: 'a' | 'c' | 's' | 'o'; k: string; u: number }

export function pushChanges(full = false): Promise<number> {
  return conLockSync(() => ejecutarPush(full));
}

async function ejecutarPush(full = false): Promise<number> {
  const state = (await db.syncState.get('1')) ?? { id: '1' };
  const cursor = full ? 0 : (state.lastPushAt ?? 0);
  // Desfase aprendido de las respuestas anteriores (0 hasta la primera).
  const sesgo = state.sesgoServidor ?? 0;

  await migrarImagenesABlob();
  if (!tieneClave()) await restaurarClave();
  const claveActiva = tieneClave();
  const puedeSubirSinClave = <T,>(fila: T) => claveActiva || !tieneContenidoBloqueado(fila);

  // Lectura por tabla + filtro por cursor y semilla (contrato explícito: lo
  // que puso la app no es del usuario y no viaja).
  const [activities, categories, settings, dayOverrides] = await Promise.all([
    db.activities.toArray(),
    db.categories.toArray(),
    db.settings.toArray(),
    db.dayOverrides.toArray(),
  ]);
  const actsSuben = seleccionables(activities, cursor).filter(puedeSubirSinClave);
  const catsSuben = seleccionables(categories, cursor);
  const setsSuben = seleccionables(settings, cursor);
  const ovsSuben = seleccionables(dayOverrides, cursor).filter(puedeSubirSinClave);

  // E2E: cifrar los campos sensibles ANTES de salir del dispositivo. Solo si
  // hay clave en memoria (login reciente). Con sesión restaurada por cookie,
  // los datos viajan planos legacy hasta el próximo login con password.
  const actsCifradas = await Promise.all(actsSuben.map(a => cifrarActividad(a)));
  const ovsCifrados = await Promise.all(ovsSuben.map(o => cifrarOverride(o)));
  // El LWW se decide con el reloj del SERVIDOR y las filas se sellan con el del
  // dispositivo. Traducir el sello al reloj del servidor es lo que hace que un
  // reloj torcido deje de importar: sin esto, cada cambio nace con una fecha que
  // el guard estricto del servidor va a rechazar y el push se agota en silencio.
  const alServidor = <T extends { updatedAt: number }>(f: T): T => sellarParaServidor(f, sesgo);
  const payload = {
    activities: actsCifradas.map(alServidor),
    categories: catsSuben.map(alServidor),
    settings: setsSuben.map(alServidor),
    dayOverrides: ovsCifrados.map(alServidor),
  };
  const total = actsSuben.length + catsSuben.length + setsSuben.length + ovsSuben.length;
  if (total === 0) return 0;

  pendingCount += total;
  setStatus('syncing');

  try {
    const res = await api<RespuestaPush>('/api/sync', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    // Cada respuesta del servidor enseña cuánto va de adelantado su reloj.
    const sesgoNuevo = sesgoDe(res.serverTime, Date.now());
    const rechazados = res.rechazados ?? [];
    if (rechazados.length > 0) await resellarRechazados(rechazados, sesgoNuevo);
    // Filas que el servidor DESCARTÓ por sus tope: nunca llegaron, así
    // que no están en `rechazos` y el cursor no puede avanzar por
    // encima so pena de no reintentarlas jamás (ver cursorPushTrasLote).
    const truncado = res.truncado ?? 0;

    // El cursor avanza SOLO por lo que el servidor confirmó. Con todo lo
    // enviado, una fila rechazada quedaba justo en el cursor y el filtro
    // estricto de seleccionables la convertía en una fila muerta: la siguiente
    // push ya no la elegía y el pull la sobrescribía con la versión vieja.
    // Las ignoradas por el servidor tampoco están escritas ni rechazadas por
    // LWW: sin esto entrarían en `aceptadas` y el cursor avanzaría por encima
    // de filas que la nube jamás vio, convirtiéndolas en filas muertas.
    const ignoradas = res.ignorados ?? [];
    const rechazadas = new Set([
      ...rechazados.map(r => `${r.t}:${r.k}`),
      ...ignoradas.map(r => `${r.t}:${r.k}`),
    ]);
    const aceptadas = [
      ...actsSuben.filter(a => !rechazadas.has(`a:${a.id}`)),
      ...catsSuben.filter(c => !rechazadas.has(`c:${c.id}`)),
      ...setsSuben.filter(s => !rechazadas.has(`s:${s.id}`)),
      ...ovsSuben.filter(o => !rechazadas.has(`o:${o.day}`)),
    ];
    pendingCount = Math.max(0, pendingCount - res.pushed - rechazados.length);
    // Las filas descartadas NO se restan: no fueron escritas ni
    // rechazadas, así que siguen pendientes de verdad.

    // MERGE: conservar los demás campos de la fila (persistState hace lo mismo
    // en la dirección contraria — los cursores nunca se pierden por un put parcial).
    const prev = await db.syncState.get('1');
    await db.syncState.put({
      ...prev,
      id: '1',
      lastPushAt: cursorPushTrasLote(aceptadas, cursor, Date.now(), truncado, ignoradas.length),
      sesgoServidor: sesgoNuevo,
    });
    // Antes del setStatus: el detalle que avisa a los listeners ya
    // lleva el descarte.
    avisoDeDescarte(truncado);
    avisoDeIgnorados(ignoradas.length);
    setStatus(pendingCount > 0 ? 'syncing' : 'synced');
    return res.pushed;
  } catch (err: any) {
    // Sin sesión no hay nada que reintentar: es la app volviendo al modo local,
    // no una avería (y api() ya apagó la sesión, así que los triggers paran).
    if (err?.sinSesion) {
      setStatus('local');
      throw err;
    }
    setStatus(navigator.onLine ? 'error' : 'offline', err?.message ?? 'Error de red');
    throw err;
  }
}

/**
 * Re-sella en local las filas que el guard LWW del servidor rechazó.
 *
 * El servidor devuelve, con cada rechazo, la fecha que él tiene. Si el cliente
 * no hace nada, esa fila conserva una fecha que ya fue rechazada y vuelve a
 * ser rechazada en cada intento: el push se agota en silencio, sin error. Con el
 * re-sello, la copia local queda un milisegundo por encima de lo que hay en la
 * nube (traducido al reloj del dispositivo), así que el siguiente push la acepta
 * a la primera. La escritura pasa por Dexie, de modo que sus propios hooks
 * encolan ese reintento sin que nadie lo pida.
 */
async function resellarRechazados(rechazados: Rechazo[], sesgo: number): Promise<void> {
  const tablas: Record<string, Table<any>> = {
    a: db.activities, c: db.categories, s: db.settings, o: db.dayOverrides,
  };
  for (const r of rechazados) {
    const tabla = tablas[r.t];
    if (!tabla) continue;
    const clave = r.t === 'o' ? Number(r.k) : r.k;
    try {
      const fila = await tabla.get(clave);
      // La fila puede haber desaparecido o cambiado entre el push y este
      // momento: si ya no existe, no hay nada que re-sellar.
      if (!fila) continue;
      await tabla.update(clave, { updatedAt: reestampar(fila.updatedAt, r.u, sesgo) });
    } catch { /* una fila que falla al re-sellarse se reintentará en el próximo push */ }
  }
}

// ── Pull: traer cambios del servidor y aplicarlos con LWW local ──────────────

interface PullCursors {
  c?: string;
  a?: string;
  s?: string;
  o?: string;
}

interface PullResponse {
  categories: any[]; activities: any[]; settings: any[]; dayOverrides: any[];
  serverTime: number; hasMore: boolean;
  cursors?: PullCursors;
}

const MAX_PULL_PAGES = 100;

interface Preparada<T> {
  remota: { updatedAt: number };
  filaDescifrada: T;
}

async function aplicarTablaSimple<T extends { id: string; updatedAt: number }>(
  tabla: Table<T, string>,
  prefijo: string,
  filas: any[],
  ahora: number,
  sesgo: number,
  fechasAplicadas: number[],
  clavesAplicadas: Set<string>,
): Promise<number> {
  let count = 0;
  for (const fila of filas) {
    const local = await tabla.get(fila.id);
    if (remotaGana(local, fila, sesgo)) {
      const lista = acotarFechaRemota({ ...fila } as T, ahora, sesgo);
      await tabla.put(lista);
      fechasAplicadas.push(lista.updatedAt);
      clavesAplicadas.add(`${prefijo}:${fila.id}`);
      count++;
    }
  }
  return count;
}

async function aplicarTablaDescifrada<
  K extends string | number,
  T extends { updatedAt: number },
>(
  tabla: Table<T, K>,
  prefijo: string,
  filas: any[],
  claveDe: (fila: any) => K,
  preparadas: Map<K, Preparada<T>>,
  desbloquear: (local: T, dec: T, raw: any, sesgo: number) => { fila: T; cambio: boolean },
  ahora: number,
  sesgo: number,
  conClave: boolean,
  fechasAplicadas: number[],
  clavesAplicadas: Set<string>,
): Promise<number> {
  let count = 0;
  for (const raw of filas) {
    const clave = claveDe(raw);
    const prep = preparadas.get(clave);
    if (!prep) continue;
    const local = await tabla.get(clave);
    if (remotaGana(local, raw, sesgo)) {
      const lista = acotarFechaRemota({ ...prep.filaDescifrada }, ahora, sesgo);
      await tabla.put(lista);
      fechasAplicadas.push(lista.updatedAt);
      clavesAplicadas.add(`${prefijo}:${clave}`);
      count++;
    } else if (conClave && local && debeAplicarEnPull(local, raw, sesgo, conClave)) {
      const { fila, cambio } = desbloquear(local, prep.filaDescifrada, raw, sesgo);
      if (cambio) {
        await tabla.put(fila);
        clavesAplicadas.add(`${prefijo}:${clave}`);
        count++;
      }
    }
  }
  return count;
}

export function pullChanges(full = false): Promise<{ applied: number }> {
  return conLockSync(() => ejecutarPull(full));
}

async function ejecutarPull(full = false): Promise<{ applied: number }> {
  const initialState = (await db.syncState.get('1')) ?? { id: '1' };
  const since = full ? 0 : (initialState.lastServerPullAt ?? 0);

  setStatus('syncing');
  // Freno de hooks: todo lo que se escriba abajo (incluido el syncState) es
  // una RESTITUCIÓN de lo que ya está en la nube. Sin este bloqueo, cada fila
  // aplicada programaba un push que volvía a escribir y a programar otro pull.
  escrituraNubeProfundidad++;
  try {
    let applied = 0;
    let cursors: PullCursors | undefined;
    let primerServerTime: number | undefined;
    let ultimoServerTime = Date.now();
    let ultimaFirma = '';
    let vioActividadesRemotas = false;
    const idsActividadesRemotas = new Set<string>();
    const clavesAplicadas = new Set<string>();

    if (!tieneClave()) await restaurarClave();
    const conClave = tieneClave();

    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const params = new URLSearchParams({ since: String(since) });
      if (cursors?.c) params.set('cCursor', cursors.c);
      if (cursors?.a) params.set('aCursor', cursors.a);
      if (cursors?.s) params.set('sCursor', cursors.s);
      if (cursors?.o) params.set('oCursor', cursors.o);

      const res = await api<PullResponse>(`/api/sync?${params.toString()}`);
      if (primerServerTime === undefined && Number.isFinite(res.serverTime)) {
        primerServerTime = res.serverTime;
      }
      ultimoServerTime = res.serverTime;

      // Dos relojes y una sola traducción: el desfase que el servidor acaba de
      // decirnos. Lo que se GUARDA se acota al reloj local (acotarFechaRemota) y
      // lo que se COMPARA se traduce con el mismo sesgo (remotaGana).
      const sesgo = sesgoDe(res.serverTime, Date.now());
      const ahora = Date.now();

      for (const a of res.activities) idsActividadesRemotas.add(a.id);
      if (res.activities.length > 0) vioActividadesRemotas = true;

      // Lectura + descifrado E2E FUERA de la transacción de IndexedDB para no
      // suspender una IDBTransaction con WebCrypto y disparar TransactionInactiveError.
      const [localesActs, localesOvrs] = await Promise.all([
        res.activities.length > 0 ? db.activities.toArray() : Promise.resolve([] as Activity[]),
        res.dayOverrides.length > 0 ? db.dayOverrides.toArray() : Promise.resolve([] as DayOverride[]),
      ]);
      const mapaLocalActs = new Map(localesActs.map(a => [a.id, a]));
      const mapaLocalOvrs = new Map(localesOvrs.map(o => [o.day, o]));

      const actsPorDescifrar = res.activities.filter(a =>
        debeAplicarEnPull(mapaLocalActs.get(a.id), a, sesgo, conClave),
      );
      const ovrsPorDescifrar = res.dayOverrides.filter(o =>
        debeAplicarEnPull(mapaLocalOvrs.get(o.day), o, sesgo, conClave),
      );

      const [actsListas, ovrsListas] = await Promise.all([
        Promise.all(
          actsPorDescifrar.map(async a => ({
            remota: a,
            filaDescifrada: await descifrarActividad(a, mapaLocalActs.get(a.id)),
          })),
        ),
        Promise.all(
          ovrsPorDescifrar.map(async o => ({
            remota: o,
            filaDescifrada: await descifrarOverride(o, mapaLocalOvrs.get(o.day)),
          })),
        ),
      ]);
      const mapaActsListas = new Map<string, Preparada<Activity>>(
        actsListas.map(p => [p.filaDescifrada.id, p]),
      );
      const mapaOvrsListas = new Map<number, Preparada<DayOverride>>(
        ovrsListas.map(p => [p.filaDescifrada.day, p]),
      );

      const hayMas = Boolean(res.hasMore && res.cursors);
      const nuevaFirma = hayMas ? JSON.stringify(res.cursors) : '';
      const esUltimaPagina =
        !hayMas || (nuevaFirma !== '' && nuevaFirma === ultimaFirma) || page === MAX_PULL_PAGES - 1;

      await db.transaction(
        'rw',
        db.activities,
        db.categories,
        db.settings,
        db.dayOverrides,
        db.syncState,
        async () => {
          const fechasAplicadas: number[] = [];

          applied += await aplicarTablaSimple(
            db.categories, 'c', res.categories, ahora, sesgo, fechasAplicadas, clavesAplicadas,
          );
          applied += await aplicarTablaSimple(
            db.settings, 's', res.settings, ahora, sesgo, fechasAplicadas, clavesAplicadas,
          );
          applied += await aplicarTablaDescifrada<string, Activity>(
            db.activities,
            'a',
            res.activities,
            a => a.id,
            mapaActsListas,
            (local, dec, raw, s) =>
              desbloquearCamposActividad(
                local,
                dec,
                esCifrado(raw?.steps),
                fuePulledaSinEdicionPosterior(local, raw, s),
              ),
            ahora,
            sesgo,
            conClave,
            fechasAplicadas,
            clavesAplicadas,
          );
          applied += await aplicarTablaDescifrada<number, DayOverride>(
            db.dayOverrides,
            'o',
            res.dayOverrides,
            o => o.day,
            mapaOvrsListas,
            (local, dec, raw, s) => desbloquearCamposOverride(local, dec, raw, s),
            ahora,
            sesgo,
            conClave,
            fechasAplicadas,
            clavesAplicadas,
          );

          // Preservar ediciones locales aún no subidas: no dejar que `lastPushAt`
          // salte por encima de filas locales previas al pull que sigan pendientes.
          const curState = (await db.syncState.get('1')) ?? { id: '1' };
          const prevPushAt = curState.lastPushAt ?? 0;
          const [todasCats, todasActs, todasSetts, todosOvrs] = await Promise.all([
            db.categories.toArray(),
            db.activities.toArray(),
            db.settings.toArray(),
            db.dayOverrides.toArray(),
          ]);
          const pendientes: number[] = [];
          const registrarPendientes = <T extends { updatedAt: number }>(
            lista: T[],
            prefijo: string,
            claveDe: (item: T) => string | number,
          ) => {
            for (const item of lista) {
              if (!esSemilla(item) && item.updatedAt > prevPushAt && !clavesAplicadas.has(`${prefijo}:${claveDe(item)}`)) {
                pendientes.push(item.updatedAt);
              }
            }
          };
          registrarPendientes(todasCats, 'c', c => c.id);
          registrarPendientes(todasActs, 'a', a => a.id);
          registrarPendientes(todasSetts, 's', s => s.id);
          registrarPendientes(todosOvrs, 'o', o => o.day);

          const nuevoPushAt = cursorPushTrasPull(prevPushAt, fechasAplicadas, pendientes, ahora);

          // El cursor va con holgura hacia atrás (cursorPull): solapar lecturas
          // permite que un cambio remoto escrito justo en la frontera llegue en el
          // siguiente pull en vez de perderse entre los relojes de los dos equipos.
          // Solo se avanza en la última página usando el primer `serverTime`.
          await db.syncState.put({
            ...curState,
            id: '1',
            lastServerPullAt: esUltimaPagina
              ? cursorPull(primerServerTime ?? ultimoServerTime)
              : curState.lastServerPullAt,
            lastPullAt: Date.now(),
            lastPushAt: nuevoPushAt,
            sesgoServidor: sesgo,
          });
        },
      );

      if (esUltimaPagina) break;
      ultimaFirma = nuevaFirma;
      cursors = res.cursors;
    }

    // Si la nube nos devuelve actividades reales, limpiamos las actividades semilla
    // por defecto (updatedAt === 0) que el usuario nunca tocó, tras leer todas las páginas.
    if (vioActividadesRemotas) {
      await db.transaction('rw', db.activities, async () => {
        const locales = await db.activities.toArray();
        for (const loc of locales) {
          if (esSemilla(loc) && !idsActividadesRemotas.has(loc.id)) {
            await db.activities.delete(loc.id);
          }
        }
      });
    }

    lastSyncAt = Date.now();
    setStatus(pendingCount > 0 ? 'syncing' : 'synced');
    return { applied };
  } catch (err: any) {
    // Sin sesión no hay nada que reintentar: es la app volviendo al modo local,
    // no una avería (y api() ya apagó la sesión, así que los triggers paran).
    if (err?.sinSesion) {
      setStatus('local');
      throw err;
    }
    setStatus(navigator.onLine ? 'error' : 'offline', err?.message ?? 'Error de red');
    throw err;
  } finally {
    escrituraNubeProfundidad = Math.max(0, escrituraNubeProfundidad - 1);
  }
}

// ── Ciclo completo ───────────────────────────────────────────────────────────

/** Push + pull con exclusión mutua. Es la función que invocan los triggers. */
export async function syncNow(full = false): Promise<void> {
  if (syncActivo > 0) {
    syncPendiente = true;
    if (full) fullPendiente = true;
    return;
  }
  return conLockSync(async () => {
    syncPendiente = false;
    const usarFull = full || fullPendiente;
    fullPendiente = false;
    // Push pausado tras import: solo pull (leer la nube no pisa lo importado,
    // el LWW local gana con updatedAt fresco); nada local viaja arriba.
    if (pushPaused && !usarFull) {
      try {
        await ejecutarPull();
      } catch { /* estado ya en error/offline */ }
      return;
    }
    if (pushPaused && usarFull) {
      return; // pausa explícita: ni push full (lo llama resumePushAndSync tras reactivar)
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setStatus('offline');
      return;
    }
    await ejecutarPush(usarFull);
    if (!sesionActiva) return; // la cookie caducó: no encadenar otro 401
    await ejecutarPull();
  });
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
  await restaurarClave();
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
  return conLockSync(async () => {
    try {
      setStatus('syncing');
      // Pull completo al arrancar (`since = 0`) para recuperar cambios escritos
      // offline en otros dispositivos cuya marca `updatedAt` sea anterior al
      // último `lastServerPullAt` de este equipo.
      await ejecutarPull(true);
      // Push incremental (no full): solo lo que el usuario tocó en este
      // dispositivo. La semilla tiene updatedAt 0 y se queda en casa.
      if (!pushPaused) await ejecutarPush(false);
    } catch {
      /* el estado ya quedó en error/offline; se reintenta con el listener */
    }
  });
}

/** ¿Hay sesión activa? (la cookie httpOnly responde por nosotros) */
// ── Órdenes manuales: "subir" y "bajar" como botones, no como efecto colateral ─
// El automático (hooks, arranque, visibility) es invisible y por eso mismo no
// sirve para un "¿ya llegó lo del otro?" ni para un "no quiero esperar". Estas
// dos son la orden explícita del usuario y dicen el resultado con números.

/** Texto de error cuando no hay cookie: la UI lo muestra tal cual en el toast. */
export const SIN_SESION = 'No hay sesión iniciada';

export interface ResultadoSubida {
  /** Filas que el servidor aceptó. 0 = no había nada nuevo. */
  enviados: number;
}

export interface ResultadoBajada {
  /** Filas de la nube que no teníamos (o eran más viejas). */
  aplicados: number;
}

/**
 * ¿Se puede operar contra la nube? Reusa la sesión ya resuelta en el arranque
 * para no pagar un fetch en cada clic; solo pregunta si el motor todavía no
 * habló con el servidor.
 */
async function haySesionOperativa(): Promise<boolean> {
  if (sesionActiva) return true;
  const ok = await isLoggedIn();
  if (ok) sesionActiva = true;
  return ok;
}

/**
 * Sube este dispositivo a la nube ahora. Es un push COMPLETO, no incremental:
 * el botón significa "que la nube tenga TODO lo mío", no "lo que se movió
 * desde el último push". Reenviar filas viejas es inofensivo porque el LWW del
 * servidor solo acepta lo más nuevo.
 *
 * Si el push seguía pausado tras una importación, esta orden lo reactiva: es
 * la misma decisión que el botón de Ajustes, desde otro sitio.
 */
export async function subirAhora(): Promise<ResultadoSubida> {
  if (!(await haySesionOperativa())) throw new Error(SIN_SESION);
  return conLockSync(async () => {
    if (pushPaused) {
      pushPaused = false;
      const prev = await db.syncState.get('1');
      await db.syncState.put({ ...prev, id: '1', pendingPushPaused: false });
    }
    const enviados = await ejecutarPush(true);
    await ejecutarPull().catch(() => { /* el push ya salió; el pull reintenta solo */ });
    return { enviados };
  });
}

/**
 * Trae a este dispositivo lo que hay en la nube. Merge por LWW: nunca borra
 * lo local (cada fila se aplica solo si la remota es más nueva) y reaplicar
 * filas viejas no tiene efecto. NO es un "restaurar desde la nube": para que
 * la nube mande sobre lo local por completo está el botón de borrar todo.
 */
export async function bajarAhora(
  modo: 'auto' | 'combinar' | 'reemplazar' = 'auto',
): Promise<ResultadoBajada> {
  if (!(await haySesionOperativa())) throw new Error(SIN_SESION);
  await restaurarClave();
  if (modo === 'reemplazar') {
    const snap = await descargarSnapshotNube();
    return aplicarSnapshotReemplazando(snap);
  }
  return conLockSync(async () => {
    // pullChanges cuenta 'applied' y este contrato pide 'aplicados': sin el mapa,
    // la UI recibía undefined y el toast decía SIEMPRE "ya tenías todo", que era
    // una mentira incluso bajando de verdad.
    const { applied } = await ejecutarPull(true);
    return { aplicados: applied };
  });
}

// ── Snapshot e Inspección de bajada (Reemplazo vs Combinar) ──────────────────

export interface SnapshotNube {
  categories: Category[];
  activities: Activity[];
  settings: AppSettings[];
  dayOverrides: DayOverride[];
  serverTime: number;
  primerServerTime: number;
  tieneBloqueados: boolean;
}

export interface DivergenciaPull {
  soloLocalesActs: number;
  soloLocalesCats: number;
  soloLocalesOvrs: number;
  totalSoloLocales: number;
  remotasActs: number;
  remotasCats: number;
  remotasOvrs: number;
  bloqueadoSinClave: boolean;
}

/**
 * Función pura que calcula diferencias entre datos locales y remotos para
 * advertir al usuario si pulsar "Bajar" provocaría solapamiento de actividades.
 */
export function detectarDivergenciaPull(
  locales: {
    activities: Activity[];
    categories: Category[];
    dayOverrides: DayOverride[];
  },
  remotos: {
    activities: { id: string; deletedAt?: number | null }[];
    categories: { id: string; deletedAt?: number | null }[];
    dayOverrides: { day: number; deletedAt?: number | null }[];
    tieneBloqueados?: boolean;
  },
): DivergenciaPull {
  const idsRemotosActs = new Set(
    remotos.activities.filter(a => !a.deletedAt).map(a => a.id)
  );
  const idsRemotosCats = new Set(
    remotos.categories.filter(c => !c.deletedAt).map(c => c.id)
  );
  const daysRemotosOvrs = new Set(
    remotos.dayOverrides.filter(o => !o.deletedAt).map(o => o.day)
  );

  const soloLocalesActs = locales.activities.filter(
    a => !a.deletedAt && !esSemilla(a) && !idsRemotosActs.has(a.id)
  ).length;

  const soloLocalesCats = locales.categories.filter(
    c => !c.deletedAt && !idsRemotosCats.has(c.id)
  ).length;

  const soloLocalesOvrs = locales.dayOverrides.filter(
    o => !o.deletedAt && !daysRemotosOvrs.has(o.day)
  ).length;

  const remotasActs = idsRemotosActs.size;
  const remotasCats = idsRemotosCats.size;
  const remotasOvrs = daysRemotosOvrs.size;

  return {
    soloLocalesActs,
    soloLocalesCats,
    soloLocalesOvrs,
    totalSoloLocales: soloLocalesActs + soloLocalesCats + soloLocalesOvrs,
    remotasActs,
    remotasCats,
    remotasOvrs,
    bloqueadoSinClave: !!remotos.tieneBloqueados,
  };
}

/**
 * Descarga todo el contenido de la nube (since = 0) y descifra los campos en memoria
 * sin tocar IndexedDB.
 */
export async function descargarSnapshotNube(): Promise<SnapshotNube> {
  let cursors: PullCursors | undefined;
  let primerServerTime: number | undefined;
  let ultimoServerTime = Date.now();
  let ultimaFirma = '';

  const mapCats = new Map<string, Category>();
  const mapActs = new Map<string, any>();
  const mapSets = new Map<string, AppSettings>();
  const mapOvrs = new Map<number, any>();

  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const params = new URLSearchParams({ since: '0' });
    if (cursors?.c) params.set('cCursor', cursors.c);
    if (cursors?.a) params.set('aCursor', cursors.a);
    if (cursors?.s) params.set('sCursor', cursors.s);
    if (cursors?.o) params.set('oCursor', cursors.o);

    const res = await api<PullResponse>(`/api/sync?${params.toString()}`);
    if (primerServerTime === undefined && Number.isFinite(res.serverTime)) {
      primerServerTime = res.serverTime;
    }
    ultimoServerTime = res.serverTime;

    for (const c of res.categories) mapCats.set(c.id, c);
    for (const a of res.activities) mapActs.set(a.id, a);
    for (const s of res.settings) mapSets.set(s.id, s);
    for (const o of res.dayOverrides) mapOvrs.set(o.day, o);

    const hayMas = Boolean(res.hasMore && res.cursors);
    const nuevaFirma = hayMas ? JSON.stringify(res.cursors) : '';
    const esUltimaPagina =
      !hayMas || (nuevaFirma !== '' && nuevaFirma === ultimaFirma) || page === MAX_PULL_PAGES - 1;

    if (esUltimaPagina) break;
    ultimaFirma = nuevaFirma;
    cursors = res.cursors;
  }

  if (!tieneClave()) await restaurarClave();

  const rawActs = Array.from(mapActs.values());
  const rawOvrs = Array.from(mapOvrs.values());

  const descActs = await Promise.all(rawActs.map(a => descifrarActividad(a)));
  const descOvrs = await Promise.all(rawOvrs.map(o => descifrarOverride(o)));

  let tieneBloqueados = false;
  for (const a of descActs) {
    if (tieneContenidoBloqueado(a)) {
      tieneBloqueados = true;
      break;
    }
  }
  if (!tieneBloqueados) {
    for (const o of descOvrs) {
      if (tieneContenidoBloqueado(o)) {
        tieneBloqueados = true;
        break;
      }
    }
  }

  return {
    categories: Array.from(mapCats.values()),
    activities: descActs,
    settings: Array.from(mapSets.values()),
    dayOverrides: descOvrs,
    serverTime: ultimoServerTime,
    primerServerTime: primerServerTime ?? ultimoServerTime,
    tieneBloqueados,
  };
}

/**
 * Inspecciona lo que hay en la nube y lo compara con lo local para determinar
 * si el usuario tiene actividades locales que se solaparían.
 */
export async function inspeccionarBajada(): Promise<{
  snapshot: SnapshotNube;
  divergencia: DivergenciaPull;
}> {
  if (!(await haySesionOperativa())) throw new Error(SIN_SESION);
  await restaurarClave();
  const [snapshot, localesActs, localesCats, localesOvrs] = await Promise.all([
    descargarSnapshotNube(),
    db.activities.toArray(),
    db.categories.toArray(),
    db.dayOverrides.toArray(),
  ]);

  const divergencia = detectarDivergenciaPull(
    {
      activities: localesActs,
      categories: localesCats,
      dayOverrides: localesOvrs,
    },
    {
      activities: snapshot.activities,
      categories: snapshot.categories,
      dayOverrides: snapshot.dayOverrides,
      tieneBloqueados: snapshot.tieneBloqueados,
    },
  );

  return { snapshot, divergencia };
}

/**
 * Reemplaza los datos locales con el snapshot de la nube limpiando las tablas
 * en una transacción atómica (sin emitir tombstones a la nube).
 */
export async function aplicarSnapshotReemplazando(snapshotInput: SnapshotNube): Promise<{ aplicados: number }> {
  const snapshot: SnapshotNube = JSON.parse(JSON.stringify(snapshotInput));
  if (snapshot.tieneBloqueados && !tieneClave()) {
    throw new Error('🔒 Contenido cifrado — inicia sesión con contraseña antes de reemplazar tus datos locales');
  }

  return conLockSync(async () => {
    setStatus('syncing');
    escrituraNubeProfundidad++;
    try {
      const ahora = Date.now();
      const sesgo = sesgoDe(snapshot.serverTime, ahora);

      const actsVivas = snapshot.activities.filter(a => !a.deletedAt);
      const catsVivas = snapshot.categories.filter(c => !c.deletedAt);
      const setsVivos = snapshot.settings.filter(s => !s.deletedAt);
      const ovrsVivos = snapshot.dayOverrides.filter(o => !o.deletedAt);

      await db.transaction(
        'rw',
        db.activities,
        db.categories,
        db.settings,
        db.dayOverrides,
        db.syncState,
        async () => {
          // Limpieza directa sin deletedAt (no borra en la nube)
          await db.activities.clear();
          await db.categories.clear();
          await db.settings.clear();
          await db.dayOverrides.clear();

          if (catsVivas.length > 0) {
            await db.categories.bulkPut(catsVivas.map(c => acotarFechaRemota(c, ahora, sesgo)));
          } else {
            await db.categories.bulkPut(INITIAL_CATEGORIES);
          }

          if (actsVivas.length > 0) {
            await db.activities.bulkPut(actsVivas.map(a => acotarFechaRemota(a, ahora, sesgo)));
          }

          if (setsVivos.length > 0) {
            await db.settings.bulkPut(setsVivos.map(s => acotarFechaRemota(s, ahora, sesgo)));
          }
          const hasStart = setsVivos.some(s => s.id === 'startHour');
          const hasEnd = setsVivos.some(s => s.id === 'endHour');
          if (!hasStart) await db.settings.put({ id: 'startHour', key: 'startHour', value: 7, updatedAt: ahora });
          if (!hasEnd) await db.settings.put({ id: 'endHour', key: 'endHour', value: 23, updatedAt: ahora });

          if (ovrsVivos.length > 0) {
            await db.dayOverrides.bulkPut(ovrsVivos.map(o => acotarFechaRemota(o, ahora, sesgo)));
          }

          await db.syncState.put({
            id: '1',
            lastServerPullAt: cursorPull(snapshot.primerServerTime),
            lastPullAt: ahora,
            lastPushAt: ahora,
            sesgoServidor: sesgo,
            pendingPushPaused: false,
          });
        },
      );

      pushPaused = false;
      clearUndo();
      notifyDataChange(['activities', 'categories', 'settings', 'dayOverrides']);

      lastSyncAt = ahora;
      pendingCount = 0;
      setStatus('synced');
      return { aplicados: actsVivas.length };
    } finally {
      escrituraNubeProfundidad = Math.max(0, escrituraNubeProfundidad - 1);
    }
  });
}

// ── Detección y limpieza de actividades duplicadas (Fase 3) ──────────────────

function parsearMinutos(hora: string): number {
  if (!hora || typeof hora !== 'string') return 0;
  const [h, m] = hora.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function normalizarTexto(txt: string): string {
  return (txt || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.\-_,;:\u2026]+/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface GrupoDuplicados {
  conservar: Activity;
  borrar: Activity[];
}

function puntuarCompletitud(a: Activity): number {
  let score = 0;
  if (a.image && !esCifrado(a.image) && a.image.length > 0) score += 1000;
  if (Array.isArray(a.steps) && a.steps.length > 0) score += 200 + a.steps.length * 10;
  if (a.description && !esCifrado(a.description) && a.description !== CONTENIDO_BLOQUEADO) {
    score += 100 + Math.min(50, a.description.length);
  }
  score += (a.daysOfWeek?.length ?? 0) * 5;
  if (!esSemilla(a)) score += 50;
  score += Math.min(20, (a.updatedAt || 0) / 1e11);
  return score;
}

/**
 * Detecta pares o grupos de actividades vivas que duplican una misma franja horaria
 * en los mismos días (ej. copia importada + copia de la nube, o copia con foto vs sin foto).
 */
export function detectarDuplicadosActividades(activities: Activity[]): {
  grupos: GrupoDuplicados[];
  idsABorrar: string[];
} {
  const vivas = activities.filter(a => !a.deletedAt);
  const visitadas = new Set<string>();
  const grupos: GrupoDuplicados[] = [];
  const idsABorrar: string[] = [];

  for (let i = 0; i < vivas.length; i++) {
    const a = vivas[i];
    if (visitadas.has(a.id)) continue;
    const dupes: Activity[] = [a];

    const startA = parsearMinutos(a.startTime);
    const endA = parsearMinutos(a.endTime);
    const nomA = normalizarTexto(a.name);

    for (let j = i + 1; j < vivas.length; j++) {
      const b = vivas[j];
      if (visitadas.has(b.id)) continue;

      const diasComunes = (a.daysOfWeek || []).filter(d => (b.daysOfWeek || []).includes(d));
      if (diasComunes.length === 0) continue;

      const startB = parsearMinutos(b.startTime);
      const endB = parsearMinutos(b.endTime);
      const nomB = normalizarTexto(b.name);

      const solapadas = Math.max(startA, startB) < Math.min(endA, endB);
      const mismoHorario = startA === startB && endA === endB;
      const mismoNombre = nomA === nomB || (nomA.length >= 2 && nomB.length >= 2 && (nomA.startsWith(nomB) || nomB.startsWith(nomA)));

      if ((mismoHorario && solapadas) || (mismoNombre && solapadas)) {
        dupes.push(b);
        visitadas.add(b.id);
      }
    }

    if (dupes.length > 1) {
      visitadas.add(a.id);
      dupes.sort((x, y) => puntuarCompletitud(y) - puntuarCompletitud(x));
      const conservar = dupes[0];
      const borrar = dupes.slice(1);
      grupos.push({ conservar, borrar });
      for (const b of borrar) idsABorrar.push(b.id);
    }
  }

  return { grupos, idsABorrar };
}

/**
 * Borra en IndexedDB las actividades duplicadas marcando deletedAt (tombstone)
 * y sincroniza la eliminación inmediatamente con la nube para que también se borren en Postgres.
 */
export async function limpiarDuplicadosNube(idsABorrar: string[]): Promise<number> {
  if (idsABorrar.length === 0) return 0;
  const stamp = Date.now();
  await db.transaction('rw', db.activities, async () => {
    for (const id of idsABorrar) {
      const act = await db.activities.get(id);
      if (act && !act.deletedAt) {
        await db.activities.put({ ...act, deletedAt: stamp, updatedAt: stamp });
      }
    }
  });
  notifyDataChange(['activities']);
  if (sesionActiva && !pushPaused) {
    void pushChanges(false).catch(() => {});
  }
  return idsABorrar.length;
}


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
  return conLockSync(async () => {
    await restaurarClave();
    setStatus('syncing');
    await ejecutarPull(true);
    if (!pushPaused) await ejecutarPush(true);
  });
}

/** Se llama tras logout: la app vuelve a modo solo-local. La pausa de push
 *  persiste: si el usuario importó sin subir, al volver a entrar tampoco debe
 *  subir (la decisión fue sobre esos datos, no sobre la sesión). */
export function resetSyncAfterLogout(): void {
  sesionActiva = false;
  olvidarClave();
  status = 'local';
  pendingCount = 0;
  lastError = undefined;
  persistState();
  db.syncState.put({ id: '1', lastPushAt: 0, lastServerPullAt: 0, pendingPushPaused: false }).catch(() => {});
  for (const fn of listeners) fn(status, { pending: 0, sesion: sesionActiva });
}

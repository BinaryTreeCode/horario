import Dexie, { type Table } from 'dexie';
import type { Activity, Category, AppSettings, DayOverride, SyncState } from './types';
import { validateImport, EXPORT_FORMAT_VERSION, compactToBackup, type ValidationResult } from './importValidation';
import { notifyDataChange } from './dataBus';

export { EXPORT_FORMAT_VERSION, validateImport };
export type { ValidationResult };

export class ScheduleDB extends Dexie {
  activities!: Table<Activity, string>;
  categories!: Table<Category, string>;
  settings!: Table<AppSettings, string>;
  dayOverrides!: Table<DayOverride, number>;
  syncState!: Table<SyncState, string>;

  constructor() {
    super('ScheduleDB');

    // v2/v3: esquema histórico (IDs numéricos auto-incrementales)
    this.version(2).stores({
      activities: '++id, categoryId, *daysOfWeek',
      categories: 'id, order',
      settings: 'id, key'
    });
    this.version(3).stores({
      dayOverrides: 'day'
    });

    // v4: UUIDs string, campos de sync y tabla de estado de sincronización.
    // La migración de datos se hace en el upgrade() de abajo.
    this.version(4).stores({
      activities: 'id, categoryId, *daysOfWeek, updatedAt, deletedAt',
      categories: 'id, order, updatedAt, deletedAt',
      settings: 'id, key, updatedAt, deletedAt',
      dayOverrides: 'day, updatedAt, deletedAt',
      syncState: 'id'
    }).upgrade(async (tx) => {
      const uuid = (): string =>
        (globalThis.crypto?.randomUUID?.() ??
          `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`);

      // ── Categories: id ya es string → solo añadir campos de sync ──
      await tx.table('categories').toCollection().modify((c: any) => {
        if (typeof c.updatedAt !== 'number') c.updatedAt = 0;
        if (c.deletedAt === undefined) c.deletedAt = undefined;
        return c;
      });

      // ── Activities: number → UUID string. Como dayOverrides referencian esos
      // IDs numéricos, se reconstruyen después con el mismo mapeo. ──
      const idMap = new Map<number, string>();
      const oldActs: any[] = await tx.table('activities').toArray();
      const newActs = oldActs.map((a) => {
        const newId = uuid();
        if (typeof a.id === 'number') idMap.set(a.id, newId);
        return {
          ...a,
          id: newId,
          updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : 0,
          deletedAt: undefined,
        };
      });
      await tx.table('activities').clear();
      if (newActs.length) await tx.table('activities').bulkAdd(newActs);

      // ── DayOverrides: remapear IDs de actividades copiadas ──
      const overrides: any[] = await tx.table('dayOverrides').toArray();
      const newOverrides = overrides.map((o) => ({
        ...o,
        activities: (o.activities ?? []).map((a: any) => ({
          ...a,
          id: typeof a.id === 'number' ? (idMap.get(a.id) ?? uuid()) : (a.id ?? uuid()),
          updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : 0,
        })),
        updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
        deletedAt: undefined,
      }));
      await tx.table('dayOverrides').clear();
      if (newOverrides.length) await tx.table('dayOverrides').bulkAdd(newOverrides);

      // ── Settings: añadir campos de sync ──
      await tx.table('settings').toCollection().modify((s: any) => {
        if (typeof s.updatedAt !== 'number') s.updatedAt = 0;
        if (s.deletedAt === undefined) s.deletedAt = undefined;
        return s;
      });

      // ── syncState inicial ──
      await tx.table('syncState').bulkPut([{ id: '1' }]);
    });

    // Si otra pestaña (o un redeploy con bump de esquema) fuerza un upgrade,
    // esta conexión queda degradada y los writes pueden perder notificaciones.
    // El patrón recomendado por Dexie: recargar la página para tomar el esquema
    // nuevo. Con las stores propias la recarga además re-sincroniza la UI.
    this.on('versionchange', () => {
      if (typeof location !== 'undefined') location.reload();
      return false;
    });

    // v41: bump “no-op” por encima de la versión física que quedaron algunas BD
    // locales de desarrollo (un experimento ad-hoc creó la BD en v40 sin que el
    // código la declarara). Declarar 41 con el MISMO esquema fuerza la ruta
    // normal de apertura/upgrade (40→41 = sin cambios) y es no-op para BD
    // limpias (producción está en v4→v41).
    this.version(41).stores({
      activities: 'id, categoryId, *daysOfWeek, updatedAt, deletedAt',
      categories: 'id, order, updatedAt, deletedAt',
      settings: 'id, key, updatedAt, deletedAt',
      dayOverrides: 'day, updatedAt, deletedAt',
      syncState: 'id'
    });
  }
}

export const db = new ScheduleDB();

// Debug: instancias reales de la app inspeccionables desde consola (solo dev)
if (import.meta.env.DEV) {
  (globalThis as any).__npDb = db;
}

// ── Bus de datos: notificación de mutaciones confirmadas ────────────────────
// Las stores reactivas (stores.ts) reemplazan a liveQuery, que en Dexie
// 4.3/4.4 no notifica updates de filas pre-existentes (dexie/Dexie.js#2309) y
// congelaba la UI tras el drag & drop. Este middleware dbcore enruta cada
// mutación de las tablas de datos hacia dataBus cuando se CONFIRMA: la store
// re-lee la tabla completa y emite el valor fresco. Cubre put/bulkPut,
// delete/bulkDelete y modify/clear (mismo objeto de mutación).
const DATA_TABLES = new Set(['activities', 'categories', 'settings', 'dayOverrides']);

(db as any).use({
  stack: 'dbcore',
  name: 'data-bus',
  level: 0,
  create: (downlevel: any) => ({
    ...downlevel,
    table: (tableName: string) => {
      const core = downlevel.table(tableName);
      if (!DATA_TABLES.has(tableName)) return core;
      return {
        ...core,
        mutate: (req: any) => {
          const resultado = core.mutate(req);
          // Notificamos cuando la mutación CONFIRMA (resuelve su promesa):
          // garantiza por construcción que la re-lectura vea el estado
          // post-commit, sin depender del timing del setTimeout del bus. Si la
          // mutación falla (transacción abortada), no notifica.
          resultado
            .then(() => notifyDataChange(tableName))
            .catch(() => {
              /* mutación fallida: sin notificación */
            });
          return resultado;
        }
      };
    }
  })
});

export const INITIAL_CATEGORIES: Category[] = [
  { id: 'rutina', label: 'Rutina', color: '#4a7c44', order: 0, updatedAt: 0 },
  { id: 'trabajar', label: 'Trabajar', color: '#1a2a44', order: 1, updatedAt: 0 },
  { id: 'comer', label: 'Comer', color: '#8b5a2b', order: 2, updatedAt: 0 },
  { id: 'orar', label: 'Orar', color: '#7fb3d5', order: 3, updatedAt: 0 },
  { id: 'aseo', label: 'Aseo', color: '#319795', order: 4, updatedAt: 0 },
  { id: 'libre', label: 'Libre', color: '#68d391', order: 5, updatedAt: 0 },
  { id: 'dormir', label: 'Dormir', color: '#4a5568', order: 6, updatedAt: 0 },
];

/** Genera un UUID para nuevas actividades (cliente). */
export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Marca de tiempo de sync para cualquier mutación. */
export function now(): number {
  return Date.now();
}

let isInitialized = false;

// Solicita persistencia de almacenamiento al navegador
export async function requestPersistentStorage() {
  if (typeof window !== 'undefined' && navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        const granted = await navigator.storage.persist();
        return granted;
      }
      return isPersisted;
    } catch (err) {
      console.error('[Persistencia] Error:', err);
    }
  }
  return false;
}

// Respaldo de seguridad en localStorage (solo si la BD no está vacía)
let backupTimeout: any = null;
let quotaWarned = false;
export function backupToLocalStorage() {
  if (typeof window === 'undefined') return;
  if (backupTimeout) clearTimeout(backupTimeout);

  backupTimeout = setTimeout(async () => {
    try {
      if (!isInitialized || !db.isOpen()) return;

      const [activities, categories, settings, dayOverrides] = await Promise.all([
        db.activities.toArray(),
        db.categories.toArray(),
        db.settings.toArray(),
        db.dayOverrides.toArray(),
      ]);

      // No respaldar una base vacía sobre un backup existente (evita borrar el respaldo por una BD en blanco)
      if (activities.length === 0 && categories.length === 0 && dayOverrides.length === 0) {
        if (typeof window !== 'undefined' && localStorage.getItem('nature_planner_backup')) {
          return; // conservar respaldo previo
        }
      }

      const serializar = (conImagenes: boolean) => JSON.stringify({
        app: 'nature-planner',
        version: EXPORT_FORMAT_VERSION,
        exportDate: new Date().toISOString(),
        activities: conImagenes ? activities : activities.map(a => ({ ...a, image: typeof a.image === 'string' && a.image.startsWith('data:') ? undefined : a.image })),
        categories,
        settings,
        dayOverrides: conImagenes ? dayOverrides : dayOverrides.map(o => ({ ...o, activities: o.activities.map(a => ({ ...a, image: typeof a.image === 'string' && a.image.startsWith('data:') ? undefined : a.image })) }))
      });
      try {
        localStorage.setItem('nature_planner_backup', serializar(true));
        quotaWarned = false;
      } catch (err2: any) {
        const isQuota =
          err2?.name === 'QuotaExceededError' ||
          err2?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
          err2?.code === 22 ||
          err2?.code === 1014;
        if (!isQuota) throw err2;
        // Quota con imágenes dentro: el respaldo SIN data-URLs de imagen
        // casi siempre entra (las imágenes viven bien en IndexedDB y, con
        // sesión, en Vercel Blob). Solo si aún así explota se avisa al usuario.
        try {
          localStorage.setItem('nature_planner_backup', serializar(false));
          quotaWarned = false;
        } catch {
          quotaWarned = true;
          // Toast de error — persistente hasta que el usuario lo cierre (regla
          // dura de AGENTS.md: nunca alert() nativo). Import diferido para evitar
          // dependencia circular toast ↔ db.
          import('./toast').then(async ({ toastErr }) => {
            const { tNow } = await import('./i18n');
            toastErr(tNow('toast.quotaPaused'));
          });
        }
      }
    } catch (err: any) {
      console.error('[Backup] Error:', err);
    }
  }, 1000);
}

// Registrar hooks para disparar el respaldo automático
function setupHooks() {
  const triggerBackup = () => {
    if (!isInitialized) return;
    backupToLocalStorage();
  };

  for (const table of [db.activities, db.categories, db.settings, db.dayOverrides]) {
    table.hook('creating', triggerBackup);
    table.hook('updating', triggerBackup);
    table.hook('deleting', triggerBackup);
  }
}

setupHooks();

async function initializeDefaults() {
  await db.categories.bulkAdd(INITIAL_CATEGORIES);
  await db.settings.bulkAdd([
    { id: 'startHour', key: 'startHour', value: 7, updatedAt: 0 },
    { id: 'endHour', key: 'endHour', value: 23, updatedAt: 0 }
  ]);
  await db.syncState.put({ id: '1' });
  // Actividades comunes por defecto: una instalación nueva nunca arranca
  // vacía — el usuario ve un día armado de ejemplo que puede editar/borrar.
  // updatedAt 0 (igual que las categorías iniciales): datos semilla, no
  // mutaciones del usuario — el LWW no debe tratarlos como frescos.
  const seed = (name: string, categoryId: string, startTime: string, endTime: string, daysOfWeek: number[]): Activity => ({
    id: newId(),
    categoryId,
    name,
    description: undefined,
    image: undefined,
    startTime,
    endTime,
    daysOfWeek,
    steps: undefined,
    updatedAt: 0,
    deletedAt: undefined
  });
  const TODOS = [0, 1, 2, 3, 4, 5, 6];
  const LUNES_A_VIERNES = [1, 2, 3, 4, 5];
  await db.activities.bulkAdd([
    seed('Rutina matutina', 'rutina', '07:00', '08:00', TODOS),
    seed('Desayuno', 'comer', '08:00', '08:30', TODOS),
    seed('Trabajo', 'trabajar', '09:00', '13:00', LUNES_A_VIERNES),
    seed('Almuerzo', 'comer', '13:00', '14:00', TODOS),
    seed('Aseo personal', 'aseo', '22:00', '22:30', TODOS),
    // Actividad de 15 minutos a propósito: es el caso corto que hace que la
    // zona interactiva de un bloque baje de 44px, y sin una semilla así el
    // guard de accesibilidad no tiene ningún caso que pueda violar la regla
    // (la más corta del resto dura 30 min y nunca baja de 44px).
    seed('Tomar sol', 'rutina', '17:30', '17:45', TODOS)
  ]);
}

export async function initDB() {
  try {
    try {
      if (!db.isOpen()) {
        await db.open();
      }
    } catch (openErr: any) {
      // ── Rescate de BD legacy (UpgradeError: changing primary key) ──
      // BDs creadas con el esquema v2/v3 (++id numérico) NO pueden migrar:
      // IndexedDB jamás permite cambiar la primary key de una store. Dexie
      // aborta el open() y sin BD todo guardado falla (parece "pedir cuenta"
      // pero es el upgrade roto — la app es y sigue siendo local-first).
      // Rescate: leer los datos crudos con IndexedDB nativo, borrar la BD
      // completa y recrearla con el esquema actual + los datos rescatados.
      console.error('[Init] Apertura falló, intentando rescate de BD legacy:', openErr);
      await rescatarBdLegacy(openErr);
    }

    const activitiesCount = await db.activities.count();
    const categoriesCount = await db.categories.count();
    const settingsCount = await db.settings.count();

    const isEmpty = activitiesCount === 0 && categoriesCount === 0 && settingsCount === 0;

    if (isEmpty) {
      const backupStr = typeof window !== 'undefined' ? localStorage.getItem('nature_planner_backup') : null;

      if (backupStr) {
        const validation = validateImport(backupStr);
        if (!validation.valid) {
          console.error('[Init] Respaldo en localStorage inválido, se ignorará:', validation.error);
          await initializeDefaults();
        } else {
          try {
            await importValidatedData(validation);
          } catch (restoreErr) {
            console.error('[Init] Error al restaurar respaldo, usando datos por defecto:', restoreErr);
            await initializeDefaults();
          }
        }
      } else {
        await initializeDefaults();
      }
    } else {
      if (categoriesCount === 0) {
        await db.categories.bulkAdd(INITIAL_CATEGORIES);
      }
      if (settingsCount === 0) {
        await db.settings.bulkAdd([
          { id: 'startHour', key: 'startHour', value: 7, updatedAt: 0 },
          { id: 'endHour', key: 'endHour', value: 23, updatedAt: 0 }
        ]);
      }
      if ((await db.syncState.count()) === 0) {
        await db.syncState.put({ id: '1' });
      }
    }

    await requestPersistentStorage();
    isInitialized = true;
    backupToLocalStorage();
  } catch (err) {
    console.error('Error durante initDB:', err);
  }
}

/**
 * Rescate de BD legacy: cuando Dexie no puede abrir por cambio de primary key
 * (v2/v3 → v4), lee las tablas crudas con IndexedDB nativo, borra la BD y la
 * recrea con el esquema declarado actual; los datos rescatados se normalizan
 * por el MISMO pipeline del import (validateImport) y se restauran.
 * Sin datos rescatables, queda una instalación fresca con contenido por defecto.
 */
async function rescatarBdLegacy(openErr: any): Promise<void> {
  const nombre = db.name; // 'ScheduleDB'
  const esErrorPrimaryKey =
    openErr?.name === 'UpgradeError' ||
    /primary key/i.test(String(openErr?.message ?? openErr ?? ''));
  if (!esErrorPrimaryKey || typeof indexedDB === 'undefined') {
    throw openErr; // no es el caso conocido: que suba y se registre el error
  }

  // 1) Leer las stores crudas ANTES de borrar (open de bajo nivel, sin Dexie)
  const leerCrudo = (store: string): Promise<any[]> =>
    new Promise((resolve) => {
      const req = indexedDB.open(nombre);
      req.onupgradeneeded = () => {
        // Abrir en la versión vieja SIN pedir upgrade: si el navegador intenta
        // crear stores nuevas abortamos; solo leemos lo que ya existe.
        req.transaction?.abort();
      };
      req.onsuccess = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(store)) {
          idb.close();
          resolve([]);
          return;
        }
        try {
          const tx = idb.transaction(store, 'readonly');
          const getAll = tx.objectStore(store).getAll();
          getAll.onsuccess = () => {
            idb.close();
            resolve(getAll.result ?? []);
          };
          getAll.onerror = () => {
            idb.close();
            resolve([]);
          };
        } catch {
          idb.close();
          resolve([]);
        }
      };
      req.onerror = () => resolve([]);
      req.onblocked = () => resolve([]);
    });

  const [acts, cats, sets, ovs] = await Promise.all(
    ['activities', 'categories', 'settings', 'dayOverrides'].map(leerCrudo)
  );

  // 2) Borrar la BD entera y dejar que Dexie la cree con el esquema actual
  await Dexie.delete(nombre);

  // 3) Normalizar lo rescatado con el pipeline del import (ids nuevos, stamps,
  // whitelist, integridad). Si no había nada, initializeDefaults() puebla todo.
  const validation = validateImport(JSON.stringify({
    app: 'nature-planner',
    version: EXPORT_FORMAT_VERSION,
    activities: acts ?? [],
    categories: cats ?? [],
    settings: sets ?? [],
    dayOverrides: ovs ?? []
  }));

  await db.open();
  if (validation.valid) {
    await importValidatedData(validation);
    // importValidatedData pausa el push (filosofía del import): en un rescate
    // NO corresponde — nunca hubo nube en juego y los stamps son frescos.
    // Nota: si el usuario NO está logueado esto es inocuo (push ya inactivo).
    const { resumePushAndSync } = await import('./sync');
    try {
      await resumePushAndSync();
    } catch { /* sin sesión: syncNow falla y queda en su estado */ }
  } else {
    console.error('[Init] Datos rescatados inválidos:', validation.error);
  }
  if ((await db.settings.count()) === 0 || (await db.categories.count()) === 0) {
    await initializeDefaults();
  }
}

// ── Export / Import ─────────────────────────────────────────────────────────

export type ExportMode = 'compact' | 'full';

export async function exportData(mode: ExportMode = 'compact'): Promise<string> {
  try {
    return await db.transaction('r', db.activities, db.categories, db.settings, db.dayOverrides, async () => {
      // Excluye tombstones (deletedAt): el export es para migrar/respaldar datos vivos,
      // no para replicar borrados que el sync ya propagó.
      const [activities, categories, settings, dayOverrides] = await Promise.all([
        db.activities.filter(a => !a.deletedAt).toArray(),
        db.categories.filter(c => !c.deletedAt).toArray(),
        db.settings.filter(s => !s.deletedAt).toArray(),
        db.dayOverrides.filter(o => !o.deletedAt).toArray()
      ]);
      if (mode === 'compact') {
        // Formato compacto posicional (~85% más chico): sin ids ni updatedAt,
        // el import los regenera. Minificado: ya no lleva espacios de más.
        return JSON.stringify(compactToBackup({ activities, categories, settings, dayOverrides }));
      }
      return JSON.stringify({
        app: 'nature-planner',
        version: EXPORT_FORMAT_VERSION,
        exportDate: new Date().toISOString(),
        activities,
        categories,
        settings,
        dayOverrides
      }, null, 2);
    });
  } catch (err) {
    console.error('Error exporting data:', err);
    throw err;
  }
}

/**
 * Exportación BINARIA (.npz): el mismo JSON compacto + las imágenes inline
 * movidas a entradas binarias del ZIP (fflate). Ahorra la inflación base64
 * (+33%), el overhead de escape JSON y comprime el JSON con DEFLATE.
 *
 * Recomprime primero cada data-URL de imagen a 256px/WebP (~15–30 KB) para
 * que el respaldo sirva de resguardo, no de archivo pesado. Las imágenes en
 * la nube (URL http) o las que fallen al recomprimir viajan como texto
 * dentro del JSON, intactas.
 *
 * El .npz se importa con el MISMO pipeline de siempre (validateImport →
 * confirmación → importValidatedData): el validador acepta el ZIP si trae
 * un payload válido en `d`.
 */
export interface StatsRespaldo {
  /** Tamaño final del archivo (bytes reales del ZIP, o del texto en .json). */
  bytes: number;
  /** Data-URLs de imagen recompresidas a binario dentro del archivo. */
  imagenesRecomprimidas: number;
  /** Imágenes que ya viajaban livianas (URL http/blob) y no se tocaron. */
  imagenesIntactas: number;
  /** Bytes del JSON SIN tratar imágenes (referencia para el % ahorrado). */
  bytesSinTratar: number;
}

/** Pipeline común de export y estimación: construye el .npz sin descargarlo.
 *  Devuelve el ZIP listo y las estadísticas del tratamiento de imágenes. */
async function buildRespaldoBinario(mode: ExportMode): Promise<{ zipped: Uint8Array; stats: StatsRespaldo }> {
  if (typeof window === 'undefined') throw new Error('Solo navegador');
  const { zipSync, strToU8 } = await import('fflate');
  const { recomprimirParaRespaldo, esDataUrlImagen, UMBRAL_BINARIO } =
    await import('./routineImages');
  const payload = await exportData(mode); // JSON con data-URLs inline
  const bytesSinTratar = payload.length;
  const parsed = JSON.parse(payload);

  // Acceso uniforme a las actividades en AMBOS formatos de export:
  // full usa activities/dayOverrides (objetos), compacto usa acts/ovs
  // (filas posicionales con la imagen en el índice 7).
  const actsDe = (d: any): any[] => d.activities ?? d.acts ?? [];
  const ovActsDe = (d: any): any[] => [
    ...(d.dayOverrides ?? []).flatMap((o: any) => o.activities ?? []),
    ...(d.ovs ?? []).flatMap((o: any) => o[1] ?? [])
  ];
  const imgDe = (a: any) => (Array.isArray(a) ? a[7] : a?.image);
  const setImg = (a: any, v: unknown) => {
    if (Array.isArray(a)) {
      while (a.length < 8) a.push(null); // ranura 7 con nulls intermedios (documentado en c1)
      a[7] = v;
    } else if (a) {
      a.image = v;
    }
  };

  // Recolectar TODAS las data-URLs únicas (actividades y overrides comparten
  // imágenes → una sola entrada por imagen distinta).
  const urls = new Set<string>();
  const colectar = (a: any) => { if (esDataUrlImagen(imgDe(a))) urls.add(imgDe(a)); };
  for (const a of actsDe(parsed)) colectar(a);
  for (const a of ovActsDe(parsed)) colectar(a);

  // Recomprimir en paralelo: { original → versión liviana } solo si compensa
  // (una data-URL en texto pesa length*1.03 bytes aprox. — pct-encoding).
  const pares = (
    await Promise.all(
      [...urls].map(async url => {
        const r = await recomprimirParaRespaldo(url);
        return r && r.bytes < url.length * 1.03 && r.bytes < UMBRAL_BINARIO
          ? ([url, r.url] as const)
          : null;
      })
    )
  ).filter(Boolean) as ReadonlyArray<readonly [string, string]>;

  // d = payload JSON (con placeholders {"i":idx,"f":mime}), imgs = binarios puros.
  const urlAIndice = new Map(pares.map(([url], i) => [url, i] as const));
  const placeholderABytes = new Map<number, Uint8Array>();
  for (let i = 0; i < pares.length; i++) {
    const blob = await (await fetch(pares[i][1])).blob();
    placeholderABytes.set(i, new Uint8Array(await blob.arrayBuffer()));
  }
  const asignar = (a: any) => {
    const idx = urlAIndice.get(imgDe(a));
    if (idx !== undefined) {
      // Placeholder estructural {"i":<índice>,"f":<mime>}: sobrevive a
      // JSON.stringify y no colisiona con URLs http reales. El import lo
      // reconstruye a data-URL (backupFile.ts).
      const url = pares[idx][1];
      const mime = url.slice(5, url.indexOf(';')) || 'image/webp';
      setImg(a, { i: idx, f: mime });
    }
  };
  for (const a of actsDe(parsed)) asignar(a);
  for (const a of ovActsDe(parsed)) asignar(a);

  const jsonFinal = JSON.stringify(parsed);
  const zip: Record<string, Uint8Array> = {
    d: strToU8(jsonFinal),
    ...Object.fromEntries([...placeholderABytes].map(([idx, bytes]) => [`${idx}.bin`, bytes]))
  };
  // Nivel 6: buen ratio sin achicharrar el hilo (el JSON domina y ya está
  // minificado; las imágenes WebP/JPEG no comprimen más).
  const zipped = zipSync(zip, { level: 6 });
  return {
    zipped,
    stats: {
      bytes: zipped.length,
      imagenesRecomprimidas: pares.length,
      imagenesIntactas: urls.size - pares.length,
      bytesSinTratar
    }
  };
}

/**
 * Estima el respaldo .npz SIN descargar nada: ejecuta el mismo pipeline
 * (export → recomprimir imágenes → zip) y devuelve tamaño + imágenes
 * tratadas. La estimación es EXACTA, no aproximada: es el archivo que se
 * descargaría. Para la UI: cachear por modo (los datos no cambian debajo).
 */
export async function estimarRespaldo(mode: ExportMode = 'compact'): Promise<StatsRespaldo> {
  const { zipped, stats } = await buildRespaldoBinario(mode);
  void zipped;
  return stats;
}

/** Exporta el .npz y devuelve las estadísticas (para el toast del menú Datos). */
export async function exportarRespaldoBinario(mode: ExportMode = 'compact'): Promise<StatsRespaldo> {
  const { zipped, stats } = await buildRespaldoBinario(mode);
  const blob = new Blob([zipped], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `planificador-datos-${new Date().toISOString().split('T')[0]}.npz`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  try { localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString()); } catch { /* indicador informativo */ }
  return stats;
}

/** Clave localStorage con la fecha ISO del último respaldo descargado
 *  (la muestra el menú Datos; se registra aquí para cubrir tanto el menú
 *  como el export de Ajustes, que pasan por esta misma función). */
export const LAST_BACKUP_KEY = 'nature_planner_lastBackup';

/** Fecha del último respaldo descargado (ISO) o null si nunca se descargó uno. */
export function leerUltimoRespaldo(): string | null {
  try {
    return typeof window !== 'undefined' ? localStorage.getItem(LAST_BACKUP_KEY) : null;
  } catch {
    return null;
  }
}

/** Descarga el respaldo (compartido por Ajustes y la barra lateral).
 *  mode 'compact' (por defecto) = formato posicional chico; 'full' = JSON completo. */
export async function descargarRespaldo(mode: ExportMode = 'compact'): Promise<void> {
  const data = await exportData(mode);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `planificador-datos-${new Date().toISOString().split('T')[0]}${mode === 'compact' ? '-compacto' : ''}.json`;
  a.click();
  // Revocar con delay: revocar inmediatamente puede cortar la descarga en algunos navegadores
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  // Registrar la fecha del último respaldo solo cuando la descarga ya partió
  // (localStorage puede lanzar en modo privado / storage bloqueado: jamás
  // debe romper el export por culpa del indicador).
  try {
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  } catch { /* indicador informativo: fallar silencioso */ }
}

export async function importValidatedData(result: ValidationResult): Promise<void> {
  if (!result.valid) {
    throw new Error('Los datos no fueron validados: llama a validateImport() primero.');
  }

  // Cada registro importado recibe updatedAt = ahora (no un TODO: ya está
  // implementado, el rótulo solo trailaba de cuando se decidió):
  // 1) Los de formatos antiguos no traían timestamp y quedarían invisibles para
  //    el push incremental (updatedAt > lastPushAt).
  // 2) Con sesión activa, un timestamp viejo pierde siempre el LWW contra la nube
  //    y el siguiente pull DESHACE la importación en silencio.
  const stamp = Date.now();
  const patch = <T extends { updatedAt?: number }>(rows: T[]): T[] =>
    rows.map(r => ({ ...r, updatedAt: stamp }));

  // Un respaldo se recomprime a 256px para que el archivo sea ligero (ver
  // buildRespaldoBinario). Importar ese archivo NO puede dejar que esa version
  // pobre pise a la que ya esta guardada: sin este guard, exportar → importar
  // degrada las imagenes de forma irreversible. Medido en los datos reales:
  // cuatro imagenes de 288x512 quedaron en 144x256 tras un round-trip, y en
  // el lightbox de escritorio son un sello de 138px en una pantalla de 2560.
  //
  // Solo se conserva la imagen previa cuando AMBAS son data-URL y la guardada
  // pesa mas (mismo codec, mas bytes = mas detalle). Si cualquiera de las dos
  // es una URL http/blob la entrante gana sin comparar: su tamano no depende
  // de como se haya comprimido el archivo de respaldo.
  const conservarImagen = (entrante: Activity, previa?: string): Activity => {
    if (!previa || !entrante.image) return entrante;
    if (!entrante.image.startsWith('data:image/')) return entrante;
    if (!previa.startsWith('data:image/')) return entrante;
    return previa.length > entrante.image.length ? { ...entrante, image: previa } : entrante;
  };

  await db.transaction('rw', db.activities, db.categories, db.settings, db.dayOverrides, db.syncState, async () => {
    // Lectura ANTES de los clear(): quedan en el mismo ámbito de transacción
    // para que nadie pueda escribir entre medias.
    const previas = new Map<string, string>();
    for (const a of await db.activities.toArray()) if (a.image) previas.set(a.id, a.image);
    const previasOv = new Map<string, string>();
    for (const o of await db.dayOverrides.toArray())
      for (const a of o.activities ?? []) if (a.image) previasOv.set(a.id, a.image);

    await db.activities.clear();
    await db.categories.clear();
    await db.settings.clear();
    await db.dayOverrides.clear();

    if (result._activities.length)
      await db.activities.bulkPut(patch(result._activities.map(a => conservarImagen(a, previas.get(a.id)))));
    if (result._categories.length) await db.categories.bulkPut(patch(result._categories));
    if (result._settings.length) await db.settings.bulkPut(patch(result._settings));
    if (result._dayOverrides.length)
      await db.dayOverrides.bulkPut(patch(result._dayOverrides.map(o => ({
        ...o,
        activities: (o.activities ?? []).map(a => conservarImagen(a, previasOv.get(a.id)))
      }))));
    // PRESERVAR lastServerPullAt del syncState (no resetear): el cursor de pull
    // es del dispositivo, no de los datos. Resetearlo haría que el próximo pull
    // re-trajera la nube entera y el LWW pisara el import con lo remoto.
    const prev = await db.syncState.get('1');
    await db.syncState.put({ id: '1', lastServerPullAt: prev?.lastServerPullAt });
  });

  // Petición del usuario: lo importado NO viaja a la nube automáticamente.
  // Pausa el push; se reactiva manualmente desde Ajustes (resumePushAndSync).
  const { pausePushAfterImport } = await import('./sync');
  await pausePushAfterImport();
}

/**
 * @deprecated Usar validateImport() + importValidatedData().
 */
export async function importData(_jsonString: string): Promise<never> {
  throw new Error('importData fue reemplazado: usa validateImport() + importValidatedData().');
}

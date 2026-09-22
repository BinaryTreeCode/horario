import Dexie, { type Table } from 'dexie';
import type { Activity, Category, AppSettings, DayOverride, SyncState } from './types';
import { validateImport, EXPORT_FORMAT_VERSION, type ValidationResult } from './importValidation';
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

      const backupData = JSON.stringify({
        app: 'nature-planner',
        version: EXPORT_FORMAT_VERSION,
        exportDate: new Date().toISOString(),
        activities,
        categories,
        settings,
        dayOverrides
      });
      localStorage.setItem('nature_planner_backup', backupData);
      quotaWarned = false;
    } catch (err: any) {
      console.error('[Backup] Error:', err);
      const isQuotaError =
        err?.name === 'QuotaExceededError' ||
        err?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err?.code === 22 ||
        err?.code === 1014;
      if (isQuotaError && !quotaWarned) {
        quotaWarned = true;
        // Toast de error — persistente hasta que el usuario lo cierre (regla
        // dura de AGENTS.md: nunca alert() nativo). Import diferido para evitar
        // dependencia circular toast ↔ db.
        import('./toast').then(({ toastErr }) =>
          toastErr(
            '⚠️ Respaldo automático pausado: localStorage lleno. Tus datos siguen intactos en la base principal. Usa "Exportar JSON" (Ajustes) o inicia sesión para respaldar en la nube.'
          )
        );
      }
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
}

export async function initDB() {
  try {
    if (!db.isOpen()) {
      await db.open();
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

// ── Export / Import ─────────────────────────────────────────────────────────

export async function exportData(): Promise<string> {
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

export async function importValidatedData(result: ValidationResult): Promise<void> {
  if (!result.valid) {
    throw new Error('Los datos no fueron validados: llama a validateImport() primero.');
  }

  // TODO registro importado recibe updatedAt = ahora:
  // 1) Los de formatos antiguos no traían timestamp y quedarían invisibles para
  //    el push incremental (updatedAt > lastPushAt).
  // 2) Con sesión activa, un timestamp viejo pierde siempre el LWW contra la nube
  //    y el siguiente pull DESHACE la importación en silencio.
  const stamp = Date.now();
  const patch = <T extends { updatedAt?: number }>(rows: T[]): T[] =>
    rows.map(r => ({ ...r, updatedAt: stamp }));

  await db.transaction('rw', db.activities, db.categories, db.settings, db.dayOverrides, db.syncState, async () => {
    await db.activities.clear();
    await db.categories.clear();
    await db.settings.clear();
    await db.dayOverrides.clear();

    if (result._activities.length) await db.activities.bulkPut(patch(result._activities));
    if (result._categories.length) await db.categories.bulkPut(patch(result._categories));
    if (result._settings.length) await db.settings.bulkPut(patch(result._settings));
    if (result._dayOverrides.length) await db.dayOverrides.bulkPut(patch(result._dayOverrides));
    await db.syncState.put({ id: '1' });
  });
}

/**
 * @deprecated Usar validateImport() + importValidatedData().
 */
export async function importData(_jsonString: string): Promise<never> {
  throw new Error('importData fue reemplazado: usa validateImport() + importValidatedData().');
}

import Dexie, { type Table } from 'dexie';
import type { Activity, Category, AppSettings } from './types';

export class ScheduleDB extends Dexie {
  activities!: Table<Activity>;
  categories!: Table<Category>;
  settings!: Table<AppSettings>;

  constructor() {
    super('ScheduleDB');
    this.version(2).stores({
      activities: '++id, categoryId, *daysOfWeek',
      categories: 'id, order',
      settings: 'id, key'
    });
  }
}

export const db = new ScheduleDB();

export const INITIAL_CATEGORIES: Category[] = [
  { id: 'rutina', label: 'Rutina', color: '#4a7c44', order: 0 },
  { id: 'trabajar', label: 'Trabajar', color: '#1a2a44', order: 1 },
  { id: 'comer', label: 'Comer', color: '#8b5a2b', order: 2 },
  { id: 'orar', label: 'Orar', color: '#7fb3d5', order: 3 },
  { id: 'aseo', label: 'Aseo', color: '#319795', order: 4 },
  { id: 'libre', label: 'Libre', color: '#68d391', order: 5 },
  { id: 'dormir', label: 'Dormir', color: '#4a5568', order: 6 },
];

let isInitialized = false;

// Solicita persistencia de almacenamiento al navegador
export async function requestPersistentStorage() {
  if (typeof window !== 'undefined' && navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persisted();
      console.log(`[Persistencia] Estado actual: ${isPersisted ? 'Persistente' : 'Temporal'}`);
      if (!isPersisted) {
        const granted = await navigator.storage.persist();
        console.log(`[Persistencia] Solicitud de persistencia: ${granted ? 'Concedida' : 'Denegada'}`);
        return granted;
      }
      return isPersisted;
    } catch (err) {
      console.error('[Persistencia] Error al solicitar almacenamiento persistente:', err);
    }
  }
  return false;
}

// Respaldo de seguridad en localStorage
let backupTimeout: any = null;
export function backupToLocalStorage() {
  if (typeof window === 'undefined') return;
  if (backupTimeout) clearTimeout(backupTimeout);

  backupTimeout = setTimeout(async () => {
    try {
      if (!isInitialized || !db.isOpen()) return;

      const activities = await db.activities.toArray();
      const categories = await db.categories.toArray();
      const settings = await db.settings.toArray();

      const backupData = JSON.stringify({
        version: 2,
        exportDate: new Date().toISOString(),
        activities,
        categories,
        settings
      });
      localStorage.setItem('nature_planner_backup', backupData);
      console.log('[Backup] Copia de seguridad en localStorage actualizada.');
    } catch (err) {
      console.error('[Backup] Error al realizar el respaldo en localStorage:', err);
    }
  }, 1000);
}

// Registrar hooks en la base de datos para detectar cambios y disparar el respaldo automático
function setupHooks() {
  const triggerBackup = () => {
    if (!isInitialized) return;
    backupToLocalStorage();
  };

  db.activities.hook('creating', triggerBackup);
  db.activities.hook('updating', triggerBackup);
  db.activities.hook('deleting', triggerBackup);

  db.categories.hook('creating', triggerBackup);
  db.categories.hook('updating', triggerBackup);
  db.categories.hook('deleting', triggerBackup);

  db.settings.hook('creating', triggerBackup);
  db.settings.hook('updating', triggerBackup);
  db.settings.hook('deleting', triggerBackup);
}

setupHooks();

async function initializeDefaults() {
  await db.categories.bulkAdd(INITIAL_CATEGORIES);
  await db.settings.bulkAdd([
    { id: 'startHour', key: 'startHour', value: 7 },
    { id: 'endHour', key: 'endHour', value: 23 }
  ]);
}

export async function initDB() {
  try {
    if (!db.isOpen()) {
      await db.open();
    }
    
    // Comprobar si la base de datos está completamente vacía
    const activitiesCount = await db.activities.count();
    const categoriesCount = await db.categories.count();
    const settingsCount = await db.settings.count();
    
    const isEmpty = activitiesCount === 0 && categoriesCount === 0 && settingsCount === 0;
    
    if (isEmpty) {
      console.log('[Init] Base de datos vacía. Buscando respaldo en localStorage...');
      const backupStr = typeof window !== 'undefined' ? localStorage.getItem('nature_planner_backup') : null;
      
      if (backupStr) {
        try {
          const data = JSON.parse(backupStr);
          console.log('[Init] Respaldo encontrado en localStorage. Restaurando...');
          
          await db.transaction('rw', db.activities, db.categories, db.settings, async () => {
            if (data.activities?.length) await db.activities.bulkAdd(data.activities);
            if (data.categories?.length) await db.categories.bulkAdd(data.categories);
            if (data.settings?.length) await db.settings.bulkAdd(data.settings);
          });
          
          console.log('[Init] Restauración exitosa desde localStorage.');
        } catch (restoreErr) {
          console.error('[Init] Error al restaurar desde localStorage, usando datos por defecto:', restoreErr);
          await initializeDefaults();
        }
      } else {
        console.log('[Init] No se encontró respaldo en localStorage. Usando datos por defecto.');
        await initializeDefaults();
      }
    } else {
      // Si la base no está totalmente vacía pero le faltan tablas por alguna razón parcial
      if (categoriesCount === 0) {
        await db.categories.bulkAdd(INITIAL_CATEGORIES);
      }
      if (settingsCount === 0) {
        await db.settings.bulkAdd([
          { id: 'startHour', key: 'startHour', value: 7 },
          { id: 'endHour', key: 'endHour', value: 23 }
        ]);
      }
    }

    // Solicitar persistencia al navegador para evitar la eliminación automática
    await requestPersistentStorage();

    // Habilitar el guardado de futuros respaldos
    isInitialized = true;
    
    // Crear un respaldo inicial de control
    backupToLocalStorage();

  } catch (err) {
    console.error('Error durante initDB:', err);
  }
}

export async function exportData() {
  try {
    const activities = await db.activities.toArray();
    const categories = await db.categories.toArray();
    const settings = await db.settings.toArray();
    return JSON.stringify({
      version: 2,
      exportDate: new Date().toISOString(),
      activities,
      categories,
      settings
    }, null, 2);
  } catch (err) {
    console.error('Error exporting data:', err);
    throw err;
  }
}

export async function importData(jsonString: string) {
  try {
    const data = JSON.parse(jsonString);
    
    if (!data.activities && !data.categories && !data.settings) {
      throw new Error('El archivo no contiene datos válidos del planificador.');
    }

    await db.transaction('rw', db.activities, db.categories, db.settings, async () => {
      // Limpiamos los datos actuales para evitar IDs duplicados u otros conflictos en la importación
      await db.activities.clear();
      await db.categories.clear();
      await db.settings.clear();

      if (data.activities?.length) await db.activities.bulkPut(data.activities);
      if (data.categories?.length) await db.categories.bulkPut(data.categories);
      if (data.settings?.length) await db.settings.bulkPut(data.settings);
    });

    return true;
  } catch (err) {
    console.error('Error importing data:', err);
    throw err;
  }
}

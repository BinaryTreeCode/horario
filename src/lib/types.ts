export interface ActivityStep {
  id: string;
  title: string;
  completed?: boolean;
}

/** Campos de sincronización presentes en toda fila replicable. */
export interface SyncFields {
  /** Marca de tiempo de la última modificación (ms epoch). Resuelve conflictos LWW. */
  updatedAt: number;
  /** Marca de borrado suave (tombstone). undefined = registro vivo. */
  deletedAt?: number;
}

export interface Activity extends SyncFields {
  /** UUID generado en cliente (crypto.randomUUID) para sync multi-dispositivo. */
  id: string;
  categoryId: string;
  name: string;
  description?: string;
  image?: string;   // Imagen ilustrativa de la rutina (data URL o URL externa/blob)
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  daysOfWeek: number[]; // 0-6 (0 = Lunes, 6 = Domingo)
  steps?: ActivityStep[];
}

export interface Category extends SyncFields {
  id: string;
  label: string;
  color: string;
  order: number;
}

export interface AppSettings extends SyncFields {
  id: string;
  key: string;
  value: any;
}

export interface DayOverride extends SyncFields {
  /** 0-6 (0 = Lunes, 6 = Domingo). Clave primaria. */
  day: number;
  activities: Activity[];
}

/** Registro de metadatos de sincronización (tabla syncState con una sola fila id=1). */
export interface SyncState {
  id: string;           // siempre '1'
  lastPushAt?: number;  // último push exitoso al servidor
  lastPullAt?: number;  // último pull exitoso
  lastServerPullAt?: number; // updatedAt del servidor en el último pull
  pendingChanges?: number;
  lastError?: string;
  lastErrorAt?: number;
}

export type SyncStatus = 'offline' | 'local' | 'syncing' | 'synced' | 'error';

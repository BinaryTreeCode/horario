/**
 * Genera el JSON v4 EXACTO del horario actual del usuario (la captura
 * compartida: 26 bloques activos, Ejercicio ya corregido a 19:00–19:45).
 *
 * Toma los datos tal cual están en la BD del preview (fuente de verdad)
 * y emite el archivo final. Uso:
 *   bun run scripts/horario-actual-v4.ts C:/Users/compu/Downloads/horario-actual-v4.json
 */
import { writeFileSync } from 'fs';

const salida = process.argv[2] ?? 'horario-actual-v4.json';
const stamp = Date.now();

// ── Categorías (orden y colores de la BD) ──
const categorias = [
  { id: 'rutina',   label: 'Rutina',   color: '#4a7c44', order: 0 },
  { id: 'trabajar', label: 'Trabajar', color: '#1a2a44', order: 1 },
  { id: 'comer',    label: 'Comer',    color: '#8b5a2b', order: 2 },
  { id: 'orar',     label: 'Orar',     color: '#7fb3d5', order: 3 },
  { id: 'aseo',     label: 'Aseo',     color: '#319795', order: 4 },
  { id: 'libre',    label: 'Libre',    color: '#68d391', order: 5 },
  { id: 'dormir',   label: 'Dormir',   color: '#4a5568', order: 6 }
].map(c => ({ ...c, updatedAt: stamp }));

// ── Actividades: exactamente las 26 de la BD (Ejercicio ya en 19:00) ──
const TODOS = [0, 1, 2, 3, 4, 5, 6];
const acts = [
  // [nombre, inicio, fin, días, categoría]
  ['Rutina',        '07:00', '08:00', TODOS,    'rutina'],
  ['Desayuno',      '08:00', '08:30', TODOS,    'comer'],
  ['trabajo',       '08:30', '09:30', TODOS,    'trabajar'],
  ['Trabajo',       '09:30', '10:30', TODOS,    'trabajar'],
  ['Trabajo',       '10:30', '11:30', [0,2,3,4,5,6], 'trabajar'],
  ['Misa',          '11:00', '13:00', [1],      'orar'],
  ['Baño',          '11:30', '13:00', [0,4],    'rutina'],
  ['Misa',          '11:30', '13:00', [3,5],    'orar'],
  ['Oración',       '11:30', '13:00', [6],      'orar'],
  ['Baño corto',    '11:30', '12:30', [2],      'rutina'],
  ['Ejercicio',     '19:00', '19:45', [0,1,2,3,4], 'dormir'],
  ['Almuerzo',      '13:30', '14:00', TODOS,    'comer'],
  ['wafles',        '14:00', '14:30', TODOS,    'comer'],
  ['trabajo',       '14:30', '15:30', [0,1,2,3,4,5], 'trabajar'],
  ['trabajo',       '15:30', '16:30', [0,1,2,3,4], 'trabajar'],
  ['Aseo',          '15:30', '16:30', [5],      'aseo'],
  ['Onces',         '16:30', '17:00', TODOS,    'comer'],
  ['Aseo',          '17:00', '17:30', [0,2,3,4], 'aseo'],
  ['Oración',       '17:00', '18:30', [5],      'orar'],
  ['Misa',          '17:00', '22:00', [6],      'orar'],
  ['oración',       '17:30', '18:30', [0,1,2,3,4], 'orar'],
  ['Cena',          '18:30', '19:00', [0,1,2,3,4,5], 'comer'],
  ['descanso',      '20:00', '21:00', [5],      'libre'],
  ['trabajo',       '20:00', '21:00', [0,1,2,3,4], 'trabajar'],
  ['trabajo',       '21:00', '22:00', [0,1,2,3,4,5], 'trabajar'],
  ['salud y sueño', '22:00', '23:00', TODOS,    'rutina']
];

const uuid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

const activities = acts.map(([name, startTime, endTime, daysOfWeek, categoryId]) => ({
  id: uuid(),
  categoryId,
  name,
  startTime,
  endTime,
  daysOfWeek,
  updatedAt: stamp
}));

const archivo = {
  app: 'nature-planner',
  version: 4,
  exportDate: new Date().toISOString(),
  activities,
  categories: categorias,
  settings: [
    { id: 'startHour', key: 'startHour', value: 7, updatedAt: stamp },
    { id: 'endHour', key: 'endHour', value: 23, updatedAt: stamp }
  ],
  dayOverrides: []
};

writeFileSync(salida, JSON.stringify(archivo, null, 2), 'utf8');
console.log(`✅ ${salida} — ${activities.length} actividades (UUIDs nuevos), ${categorias.length} categorías`);

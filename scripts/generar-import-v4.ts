/**
 * Generador desde 0 del archivo de importación (formato v4).
 *
 * Lee un export viejo (v2: ids numéricos, sin campos de sync) y RECONSTRUYE
 * el archivo completo: UUIDs v4 nuevos para cada actividad, timestamps
 * frescos, categorías/settings normalizadas y dayOverrides vacío. No hereda
 * nada del formato viejo salvo el contenido de negocio (nombre, horas, días,
 * descripción, pasos).
 *
 * Descarta automáticamente actividades sin daysOfWeek (inválidas para el
 * formato actual) y deduplica por (nombre normalizado + horario + días).
 *
 * Uso: bun run scripts/generar-import-v4.ts <entrada.json> <salida.json>
 */
import { readFileSync, writeFileSync } from 'fs';

const [, , entrada, salida] = process.argv;
if (!entrada || !salida) {
  console.error('Uso: bun run scripts/generar-import-v4.ts <entrada.json> <salida.json>');
  process.exit(1);
}

const uuid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

const TIME_RE = /^(?:([01]?\d|2[0-3]):([0-5]\d)|24:00)$/;
const isTime = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v);

const raw = JSON.parse(readFileSync(entrada, 'utf8'));

// ── Categorías: reconstruidas con id normalizado y updatedAt fresco ──
const categorias = (raw.categories ?? [])
  .filter((c: any) => typeof c?.id === 'string' && c.id && typeof c?.label === 'string' && c.label.trim())
  .map((c: any, i: number) => ({
    id: c.id.slice(0, 64),
    label: c.label.trim().slice(0, 100),
    color: typeof c.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : '#999999',
    order: Number.isFinite(c.order) ? Math.trunc(c.order) : i,
    updatedAt: Date.now()
  }));
const catIds = new Set(categorias.map((c: any) => c.id));

// ── Actividades: UUID nuevo, descarte de inválidas y dedupe ──
const vistas = new Set<string>();
const descartadas: string[] = [];
const duplicadas: string[] = [];
const actividades: any[] = [];

for (const a of raw.activities ?? []) {
  const nombre = typeof a?.name === 'string' ? a.name.trim() : '';
  const problemas: string[] = [];
  if (!nombre) problemas.push('sin nombre');
  if (!isTime(a?.startTime)) problemas.push('hora inicio inválida');
  if (!isTime(a?.endTime)) problemas.push('hora fin inválida');
  const dias: number[] = Array.isArray(a?.daysOfWeek)
    ? [...new Set(a.daysOfWeek.filter((d: unknown) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y)
    : [];
  if (dias.length === 0) problemas.push('sin días asignados');
  if (isTime(a?.startTime) && isTime(a?.endTime)) {
    const [sh, sm] = a.startTime.split(':').map(Number);
    const [eh, em] = a.endTime.split(':').map(Number);
    if (eh * 60 + em <= sh * 60 + sm) problemas.push('fin <= inicio');
  }
  if (problemas.length) {
    descartadas.push(`"${nombre || 'sin nombre'}" (${problemas.join(', ')})`);
    continue;
  }
  // Dedupe: mismo nombre normalizado + horario + días = la misma actividad repetida.
  const clave = `${nombre.toLowerCase()}|${a.startTime}|${a.endTime}|${dias.join(',')}`;
  if (vistas.has(clave)) {
    duplicadas.push(`"${nombre}" ${a.startTime}-${a.endTime} d${dias.join('')}`);
    continue;
  }
  vistas.add(clave);
  actividades.push({
    id: uuid(), // UUID v4 NUEVO — nada de ids heredados
    categoryId: catIds.has(a.categoryId) ? a.categoryId : 'rutina',
    name: nombre.slice(0, 255),
    ...(typeof a.description === 'string' && a.description.trim() ? { description: a.description.slice(0, 2000) } : {}),
    startTime: a.startTime,
    endTime: a.endTime,
    daysOfWeek: dias,
    ...(Array.isArray(a.steps) && a.steps.length
      ? {
          steps: a.steps
            .filter((s: any) => typeof s?.title === 'string' && s.title.trim())
            .map((s: any) => ({ id: uuid(), title: s.title.trim(), completed: !!s.completed }))
        }
      : {}),
    updatedAt: Date.now() // timestamp FRESCO: el sync LWW no lo pisa
  });
}

// ── Settings: reconstruidos ──
const settings = [
  { id: 'startHour', key: 'startHour', value: 7, updatedAt: Date.now() },
  { id: 'endHour', key: 'endHour', value: 23, updatedAt: Date.now() }
];

const archivo = {
  app: 'nature-planner',
  version: 4,
  exportDate: new Date().toISOString(),
  activities: actividades,
  categories: categorias,
  settings,
  dayOverrides: []
};

writeFileSync(salida, JSON.stringify(archivo, null, 2), 'utf8');

console.log(`✅ ${salida}`);
console.log(`   ${actividades.length} actividades (UUIDs nuevos), ${categorias.length} categorías, 2 ajustes`);
if (descartadas.length) {
  console.log(`\n   ⛔ Descartadas (${descartadas.length}):`);
  descartadas.forEach(d => console.log(`      - ${d}`));
}
if (duplicadas.length) {
  console.log(`\n   ♻️ Duplicados consolidados (${duplicadas.length}):`);
  duplicadas.forEach(d => console.log(`      - ${d}`));
}

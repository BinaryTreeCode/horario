import type { Activity, Category, AppSettings, DayOverride } from './types';

export const EXPORT_FORMAT_VERSION = 4;

export interface ValidationResult {
  valid: boolean;
  error?: string;
  summary: {
    activities: number;
    categories: number;
    settings: number;
    dayOverrides: number;
  };
  warnings: string[];
  _activities: Activity[];
  _categories: Category[];
  _settings: AppSettings[];
  _dayOverrides: DayOverride[];
}

const TIME_RE = /^(?:([01]?\d|2[0-3]):([0-5]\d)|24:00)$/;

export function isTimeStr(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v);
}

export function isValidImage(v: unknown): v is string {
  return (
    typeof v === 'string' && v.length > 0 && (
      v.startsWith('data:image/') ||
      v.startsWith('http://') ||
      v.startsWith('https://') ||
      v.startsWith('blob:')
    )
  );
}

/** Acepta UUID string (v4) o número (formatos v2/v3 legacy). */
function isValidId(v: unknown): v is string | number {
  return (typeof v === 'string' && v.length > 0 && v.length <= 64) || typeof v === 'number';
}

export function isValidActivityData(a: any): boolean {
  if (
    typeof a?.name !== 'string' || !a.name.trim() ||
    !isTimeStr(a?.startTime) || !isTimeStr(a?.endTime) ||
    !Array.isArray(a?.daysOfWeek) ||
    !a.daysOfWeek.every((d: unknown) => Number.isInteger(d) && d >= 0 && d <= 6)
  ) {
    return false;
  }
  const [sh, sm] = a.startTime.split(':').map(Number);
  const [eh, em] = a.endTime.split(':').map(Number);
  return eh * 60 + em > sh * 60 + sm;
}

/** Normaliza updatedAt a ms epoch; 0 si no existe o es inválido. */
function normStamp(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function normalizeId(v: unknown, generate: () => string): string {
  if (typeof v === 'string' && v.length > 0) return v.slice(0, 64);
  if (typeof v === 'number') return String(v); // legacy numérico → string
  return generate();
}

/**
 * Normaliza y valida un archivo de exportación ANTES de tocar la base de datos.
 * Función pura: sin dependencias de Dexie ni del navegador.
 */
export function validateImport(jsonString: string): ValidationResult {
  const genId = (): string =>
    (globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`);

  const result: ValidationResult = {
    valid: false,
    summary: { activities: 0, categories: 0, settings: 0, dayOverrides: 0 },
    warnings: [],
    _activities: [],
    _categories: [],
    _settings: [],
    _dayOverrides: []
  };
  const { summary, warnings, _activities, _categories, _settings, _dayOverrides } = result;

  let data: any;
  // El Bloc de notas de Windows guarda UTF-8 con BOM (\uFEFF); JSON.parse lo rechaza.
  const cleaned = jsonString.replace(/^\uFEFF/, '').trim();
  try {
    data = JSON.parse(cleaned);
  } catch (err: any) {
    result.error = `El archivo no es un JSON válido${err?.message ? ` (${err.message})` : ''}. Verifica que no esté dañado o incompleto.`;
    return result;
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    result.error = 'El contenido del archivo no tiene el formato esperado.';
    return result;
  }

  if (data.app !== undefined && data.app !== 'nature-planner') {
    result.error = 'Este archivo pertenece a otra aplicación y no puede importarse aquí.';
    return result;
  }

  if (data.version !== undefined && typeof data.version !== 'number') {
    result.error = 'El número de versión del archivo no es válido.';
    return result;
  }
  if (typeof data.version === 'number' && data.version > EXPORT_FORMAT_VERSION) {
    result.error = `El archivo fue creado con una versión más nueva de la app (v${data.version} > v${EXPORT_FORMAT_VERSION}). Actualiza la aplicación.`;
    return result;
  }
  if (typeof data.version === 'number' && data.version < 2) {
    result.error = `La versión del archivo (v${data.version}) es demasiado antigua para importarse.`;
    return result;
  }

  const hasAnyData =
    Array.isArray(data.activities) || Array.isArray(data.categories) ||
    Array.isArray(data.settings) || Array.isArray(data.dayOverrides);
  if (!hasAnyData) {
    result.error = 'El archivo no contiene datos del planificador (faltan activities, categories, settings y dayOverrides).';
    return result;
  }

  // ── Activities ──
  if (data.activities !== undefined && !Array.isArray(data.activities)) {
    result.error = 'El campo "activities" debe ser una lista.';
    return result;
  }
  for (const [i, a] of (data.activities ?? []).entries()) {
    const problems: string[] = [];
    if (typeof a?.name !== 'string' || !a.name.trim()) problems.push('sin nombre');
    if (!isTimeStr(a?.startTime)) problems.push(`hora de inicio inválida (${JSON.stringify(a?.startTime)})`);
    if (!isTimeStr(a?.endTime)) problems.push(`hora de fin inválida (${JSON.stringify(a?.endTime)})`);
    const days = a?.daysOfWeek;
    if (
      !Array.isArray(days) || days.length === 0 ||
      !days.every((d: unknown) => Number.isInteger(d) && d >= 0 && d <= 6)
    ) {
      problems.push('días de la semana inválidos');
    }
    if (isTimeStr(a?.startTime) && isTimeStr(a?.endTime)) {
      const [sh, sm] = a.startTime.split(':').map(Number);
      const [eh, em] = a.endTime.split(':').map(Number);
      if (eh * 60 + em <= sh * 60 + sm) problems.push('la hora de fin no es posterior a la de inicio');
    }
    if (problems.length > 0) {
      warnings.push(`Actividad #${i + 1}${a?.name ? ` "${a.name}"` : ''}: ${problems.join(', ')}. Será ignorada.`);
      continue;
    }
    if (a?.image !== undefined && a.image !== null && !isValidImage(a.image)) {
      warnings.push(`Actividad #${i + 1} "${a.name}": imagen con formato no reconocido. Se guardará sin imagen.`);
    }
    _activities.push({
      id: normalizeId(a.id, genId),
      categoryId: typeof a.categoryId === 'string' && a.categoryId ? a.categoryId.slice(0, 64) : 'rutina',
      name: a.name.trim().slice(0, 255),
      description: typeof a.description === 'string' ? a.description.slice(0, 2000) : undefined,
      image: isValidImage(a.image) ? a.image : undefined,
      startTime: a.startTime,
      endTime: a.endTime,
      daysOfWeek: [...new Set(days as number[])].sort((x, y) => x - y),
      steps: Array.isArray(a.steps)
        ? a.steps
            .filter((s: any) => typeof s?.title === 'string' && s.title.trim())
            .map((s: any) => ({
              id: typeof s.id === 'string' && s.id ? s.id : genId(),
              title: s.title.trim(),
              completed: !!s.completed
            }))
        : undefined,
      updatedAt: normStamp(a.updatedAt),
      deletedAt: undefined
    });
  }
  summary.activities = _activities.length;

  // ── Categories ──
  if (data.categories !== undefined && !Array.isArray(data.categories)) {
    result.error = 'El campo "categories" debe ser una lista.';
    return result;
  }
  const seenCatIds = new Set<string>();
  for (const [i, c] of (data.categories ?? []).entries()) {
    if (typeof c?.id !== 'string' || !c.id || typeof c?.label !== 'string' || !c.label.trim()) {
      warnings.push(`Categoría #${i + 1}: id o nombre inválido. Será ignorada.`);
      continue;
    }
    const cid = c.id.slice(0, 64);
    if (seenCatIds.has(cid)) {
      warnings.push(`Categoría duplicada "${c.label}" (${cid}). Solo se tomará la primera.`);
      continue;
    }
    seenCatIds.add(cid);
    _categories.push({
      id: cid,
      label: c.label.trim().slice(0, 100),
      color: typeof c.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.color) ? c.color : '#999999',
      order: Number.isFinite(c.order) ? Math.trunc(c.order) : _categories.length,
      updatedAt: normStamp(c.updatedAt),
      deletedAt: undefined
    });
  }
  summary.categories = _categories.length;

  // Integridad referencial: actividades → categorías
  if (summary.activities > 0 && summary.categories > 0) {
    const catIds = new Set(_categories.map(c => c.id));
    const orphans = _activities.filter(a => !catIds.has(a.categoryId));
    if (orphans.length > 0) {
      const names = [...new Set(orphans.map(a => `"${a.name}"`))].slice(0, 5).join(', ');
      warnings.push(
        `${orphans.length} actividad(es) (${names}${orphans.length > 5 ? '…' : ''}) referencian categorías que no existen en el archivo y usarán la categoría "Rutina".`
      );
      orphans.forEach(a => { a.categoryId = 'rutina'; });
    }
  }

  // ── Settings ──
  if (data.settings !== undefined && !Array.isArray(data.settings)) {
    result.error = 'El campo "settings" debe ser una lista.';
    return result;
  }
  for (const [i, s] of (data.settings ?? []).entries()) {
    if (typeof s?.key !== 'string' || !s.key) {
      warnings.push(`Ajuste #${i + 1}: clave inválida. Será ignorado.`);
      continue;
    }
    if (s.key === 'startHour' || s.key === 'endHour') {
      const v = s.value;
      if (!Number.isInteger(v) || v < 0 || v > 24) {
        warnings.push(`Ajuste "${s.key}" tiene un valor fuera de rango (${JSON.stringify(v)}); se usará el valor por defecto.`);
        continue;
      }
    }
    _settings.push({
      id: typeof s.id === 'string' && s.id ? s.id.slice(0, 64) : s.key.slice(0, 64),
      key: s.key.slice(0, 64),
      value: s.value ?? null,
      updatedAt: normStamp(s.updatedAt),
      deletedAt: undefined
    });
  }
  summary.settings = _settings.length;

  // ── DayOverrides ──
  if (data.dayOverrides !== undefined && !Array.isArray(data.dayOverrides)) {
    result.error = 'El campo "dayOverrides" debe ser una lista.';
    return result;
  }
  for (const [i, o] of (data.dayOverrides ?? []).entries()) {
    if (!Number.isInteger(o?.day) || o.day < 0 || o.day > 6) {
      warnings.push(`Edición temporal #${i + 1}: día inválido. Será ignorada.`);
      continue;
    }
    if (!Array.isArray(o.activities)) {
      warnings.push(`Edición temporal del día ${o.day + 1}: lista de actividades inválida. Será ignorada.`);
      continue;
    }
    if (o.activities.length === 0) {
      warnings.push(`Edición temporal del día ${o.day + 1}: vacía. Será ignorada (no genera filas fantasma).`);
      continue;
    }
    const validOvActs: Activity[] = [];
    for (const [j, a] of o.activities.entries()) {
      if (isValidActivityData(a)) {
        if (a?.image !== undefined && a.image !== null && !isValidImage(a.image)) {
          warnings.push(`Edición temporal del día ${o.day + 1}: actividad #${j + 1} "${a.name}": imagen con formato no reconocido. Se guardará sin imagen.`);
        }
        validOvActs.push({
          ...a,
          id: normalizeId(a.id, genId),
          categoryId: typeof a.categoryId === 'string' && a.categoryId ? a.categoryId.slice(0, 64) : 'rutina',
          name: a.name.trim().slice(0, 255),
          description: typeof a.description === 'string' ? a.description.slice(0, 2000) : undefined,
          image: isValidImage(a.image) ? a.image : undefined,
          daysOfWeek: [...new Set((a.daysOfWeek ?? []) as number[])].sort((x: number, y: number) => x - y),
          steps: Array.isArray(a.steps)
            ? a.steps
                .filter((st: any) => typeof st?.title === 'string' && st.title.trim())
                .map((st: any) => ({
                  id: typeof st.id === 'string' && st.id ? st.id : genId(),
                  title: st.title.trim(),
                  completed: !!st.completed
                }))
            : undefined,
          updatedAt: normStamp(a.updatedAt),
          deletedAt: undefined
        });
        continue;
      }
      warnings.push(`Edición temporal del día ${o.day + 1}: actividad #${j + 1} inválida. Será ignorada.`);
    }
    if (validOvActs.length === 0) {
      warnings.push(`Edición temporal del día ${o.day + 1}: todas sus actividades son inválidas. Será ignorada.`);
      continue;
    }
    _dayOverrides.push({
      day: o.day,
      activities: validOvActs,
      updatedAt: normStamp(o.updatedAt),
      deletedAt: undefined
    });
  }
  summary.dayOverrides = _dayOverrides.length;

  result.valid = true;
  return result;
}

import type { Activity, Category, AppSettings, DayOverride } from './types';

export const EXPORT_FORMAT_VERSION = 4;

/** Identificador del formato compacto posicional (respaldo ~85% más chico). */
export const COMPACT_FORMAT = 'c1';

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

/** Placeholder de imagen binaria del export .npz (ver exportarRespaldoBinario
 *  en db.ts): { "i": índice de entrada en el ZIP, "f": mime }. El lector
 *  (backupFile.ts) lo reconstruye como data-URL ANTES de validateImport, así
 *  que aquí SOLO debería aparecer si alguien editó el .npz a mano. Se acepta
 *  con warning: la fila conserva datos, solo pierde la imagen. */
export function isPlaceholderImagen(v: unknown): v is { i: number; f: string } {
  return (
    typeof v === 'object' && v !== null &&
    Number.isInteger((v as any).i) && (v as any).i >= 0 &&
    typeof (v as any).f === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/i.test((v as any).f)
  );
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

// ── Formato compacto 'c1' ─────────────────────────────────────────────────
// Respaldo posicional ~85% más chico que el JSON completo: sin ids ni
// updatedAt (el import los regenera). Estructura:
//   cat:  [id, label, color, order]
//   acts: [name, startTime, endTime, daysOfWeek, catIdx, desc?, steps?, image?]
//   set:  [key, value]
//   ovs:  [day, [misma fila posicional que acts]]
// catIdx es el índice en `cat` (-1 = sin categoría → 'rutina'). Los steps se
// guardan como [title] o [title, 1] (completado). La imagen vive en la última
// posición opcional: si existe, se rellenan los huecos con null.

export interface BackupPayload {
  activities: Activity[];
  categories: Category[];
  settings: AppSettings[];
  dayOverrides: DayOverride[];
}

// ── Migración de versiones antiguas ─────────────────────────────────────
// Cadena pura de pasos: cada función transforma el payload de su versión de
// entrada al siguiente (v2→v3→v4). Sin dependencias de BD ni navegador, así
// toda la cadena se testea unitariamente. Un archivo viejo NUNCA se rechaza
// por "demasiado antiguo" si tiene datos: se migra con warnings transparentes.

const MIGRATION_ORIGIN = 'migración';

/** v2 → v3: v2 no tiene dayOverrides (se crearon en v3). */
function migrateV2toV3(data: any): any {
  if (data.dayOverrides === undefined) data.dayOverrides = [];
  return data;
}

/** v3 → v4: ids numéricos de activities → UUID string, campos de sync
 *  (updatedAt/deletedAt) en todas las filas, y mapeo de categoryId
 *  referencial intacto (en v3 las categorías ya tenían id string). */
function migrateV3toV4(data: any, warnings: string[], genId: () => string): any {
  const idMap = new Map<number, string>();
  for (const a of data.activities ?? []) {
    if (typeof a?.id === 'number') idMap.set(a.id, genId());
  }
  const mapAct = (a: any): any => {
    if (typeof a?.id === 'number') return { ...a, id: idMap.get(a.id) ?? genId() };
    return a;
  };
  data.activities = (data.activities ?? []).map(mapAct);
  data.dayOverrides = (data.dayOverrides ?? []).map((o: any) => ({
    ...o,
    activities: (o?.activities ?? []).map(mapAct)
  }));
  // Campos de sync: el normalizador downstream (normStamp) completa los que
  // falten, pero los seteamos aquí para que el registro migrado sea fiel:
  // datos de antes del sync se comportan como "nunca editados" (updatedAt 0).
  for (const c of data.categories ?? []) { if (c?.updatedAt === undefined) c.updatedAt = 0; }
  for (const s of data.settings ?? []) { if (s?.updatedAt === undefined) s.updatedAt = 0; }
  for (const a of data.activities ?? []) { if (a?.updatedAt === undefined) a.updatedAt = 0; }
  for (const o of data.dayOverrides ?? []) { if (o?.updatedAt === undefined) o.updatedAt = 0; }
  warnings.push(`${MIGRATION_ORIGIN}: archivo v${data.version} actualizado al formato actual (ids regenerados, campos de sincronización agregados).`);
  return data;
}

/** Migra un payload validado en estructura a la versión actual, paso a paso.
 *  Devuelve el payload migrado y agrega a `warnings` lo que hizo. */
export function migrateBackup(data: any, warnings: string[], genId: () => string): any {
  let v = typeof data.version === 'number' ? data.version : EXPORT_FORMAT_VERSION;
  while (v < EXPORT_FORMAT_VERSION) {
    if (v === 2) { data = migrateV2toV3(data); v = 3; }
    else if (v === 3) { data = migrateV3toV4(data, warnings, genId); v = 4; }
    else {
      // Hueco en la cadena (versión sin migrador): no adivinamos. El bloque
      // de rechazo de validateImport informará "demasiado antigua" con el
      // número exacto, y el usuario sabrá qué archivo es.
      break;
    }
    data.version = v;
  }
  return data;
}

/** Empaqueta datos vivos (sin tombstones) en el formato compacto 'c1'. */
export function compactToBackup(data: BackupPayload): Record<string, unknown> {
  const cat = data.categories.map(c => [c.id, c.label, c.color, c.order]);
  const catIdx = new Map(data.categories.map((c, i) => [c.id, i] as const));

  const encAct = (a: Activity): unknown[] => {
    // Ranuras FIJAS: la posición codifica el campo. Si se rellena una ranura
    // tardía, las intermedias quedan como null (nunca desplazar: el descodificador
    // lee por índice). Se recortan los nulos del final para no inflar el archivo.
    const row: unknown[] = [
      a.name,
      a.startTime,
      a.endTime,
      [...a.daysOfWeek],
      catIdx.get(a.categoryId) ?? -1,
      a.description ?? null,
      a.steps?.length ? a.steps.map(s => (s.completed ? [s.title, 1] : [s.title])) : null,
      a.image ?? null
    ];
    while (row.length > 5 && row[row.length - 1] == null) row.pop();
    return row;
  };

  return {
    app: 'nature-planner',
    fmt: COMPACT_FORMAT,
    v: EXPORT_FORMAT_VERSION,
    exportDate: new Date().toISOString(),
    cat,
    acts: data.activities.map(encAct),
    set: data.settings.map(s => [s.key, s.value]),
    ovs: data.dayOverrides.map(o => [o.day, o.activities.map(encAct)])
  };
}

/** Decodifica una fila posicional de actividad al formato completo.
 *  La validación fina (horas, días, truncados) la hace el pipeline existente. */
function decAct(row: unknown, what: string, n: number, warnings: string[], catList: any[]): any | null {
  if (!Array.isArray(row)) {
    warnings.push(`${what} #${n + 1}: fila inválida. Será ignorada.`);
    return null;
  }
  const [name, start, end, days, catIdx, desc, steps, image] = row;
  if (isPlaceholderImagen(image)) {
    // Placeholder binario del .npz que leerRespaldo no pudo reconstruir
    // (binario ausente = archivo editado o dañado): se informa y la fila
    // continúa sin imagen (mismo trato que en el formato full).
    warnings.push(`${what} #${n + 1} "${name}": imagen binaria del respaldo no pudo reconstruirse (archivo editado o dañado). Se guardará sin imagen.`);
  }
  const act: any = { name, startTime: start, endTime: end, daysOfWeek: days };
  if (typeof catIdx === 'number' && catIdx >= 0 && catList[catIdx]) {
    act.categoryId = catList[catIdx].id;
  }
  if (typeof desc === 'string' && desc) act.description = desc;
  if (Array.isArray(steps)) {
    act.steps = steps
      .map((s: unknown) => (Array.isArray(s) ? { title: s[0], completed: s[1] === 1 || s[1] === true } : { title: s }))
      .filter((s: any) => typeof s.title === 'string' && s.title.trim());
  }
  if (typeof image === 'string' && image) act.image = image;
  return act;
}

/** Expande un archivo compacto 'c1' a la estructura completa EN MEMORIA,
 *  para que continúe por el pipeline de validación existente sin duplicarlo. */
function expandCompact(data: any, warnings: string[]): any {
  const catRows = Array.isArray(data.cat) ? data.cat : [];
  const catList: any[] = [];
  catRows.forEach((row: unknown, i: number) => {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0]) {
      warnings.push(`Categoría compacta #${i + 1}: fila inválida. Será ignorada.`);
      return;
    }
    catList.push({
      id: row[0],
      label: typeof row[1] === 'string' ? row[1] : '',
      color: row[2],
      order: typeof row[3] === 'number' ? row[3] : i
    });
  });

  const decRows = (rows: unknown, what: string) => {
    if (!Array.isArray(rows)) return [];
    return rows.map((row, i) => decAct(row, what, i, warnings, catList)).filter(Boolean);
  };

  return {
    app: 'nature-planner',
    version: typeof data.v === 'number' ? data.v : EXPORT_FORMAT_VERSION,
    exportDate: data.exportDate,
    activities: decRows(data.acts, 'Actividad compacta'),
    categories: catList,
    settings: (Array.isArray(data.set) ? data.set : []).map((row: unknown, i: number) => {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0]) {
        warnings.push(`Ajuste compacto #${i + 1}: fila inválida. Será ignorado.`);
        return null;
      }
      return { key: row[0], value: row[1] ?? null };
    }).filter(Boolean),
    dayOverrides: (Array.isArray(data.ovs) ? data.ovs : []).map((row: unknown, i: number) => {
      if (!Array.isArray(row) || !Number.isInteger(row[0]) || (row[0] as number) < 0 || (row[0] as number) > 6) {
        warnings.push(`Edición temporal compacta #${i + 1}: día inválido. Será ignorada.`);
        return null;
      }
      const day: number = row[0];
      return { day, activities: decRows(row[1], `Edición temporal compacta del día ${day + 1}`) };
    }).filter(Boolean)
  };
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

  // Formato compacto 'c1': expandir en memoria a la estructura completa y
  // continuar por el MISMO pipeline de validación (whitelist, warnings,
  // integridad referencial). Los ids/updatedAt se regeneran abajo como siempre.
  if (data.fmt === COMPACT_FORMAT) {
    if (data.v !== undefined && (typeof data.v !== 'number' || data.v > EXPORT_FORMAT_VERSION)) {
      result.error = `El archivo compacto fue creado con una versión más nueva de la app (v${data.v} > v${EXPORT_FORMAT_VERSION}). Actualiza la aplicación.`;
      return result;
    }
    if (data.acts === undefined && data.cat === undefined && data.set === undefined && data.ovs === undefined) {
      result.error = 'El archivo compacto no contiene datos del planificador (faltan acts, cat, set y ovs).';
      return result;
    }
    data = expandCompact(data, result.warnings);
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

  // Migración transparente v2/v3 → actual ANTES de la validación por campo:
  // el pipeline de whitelist de abajo trabaja siempre con el formato actual.
  if (typeof data.version === 'number' && data.version < EXPORT_FORMAT_VERSION) {
    const prev = data.version;
    data = migrateBackup(data, warnings, genId);
    if (data.version !== EXPORT_FORMAT_VERSION) {
      result.error = `La versión del archivo (v${prev}) es demasiado antigua para importarse.`;
      return result;
    }
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
    if (isPlaceholderImagen(a?.image)) {
      warnings.push(`Actividad #${i + 1} "${a.name}": imagen binaria del respaldo no pudo reconstruirse (archivo editado o dañado). Se guardará sin imagen.`);
    } else if (a?.image !== undefined && a.image !== null && !isValidImage(a.image)) {
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
        if (isPlaceholderImagen(a?.image)) {
          warnings.push(`Edición temporal del día ${o.day + 1}: actividad #${j + 1} "${a.name}": imagen binaria del respaldo no pudo reconstruirse (archivo editado o dañado). Se guardará sin imagen.`);
        } else if (a?.image !== undefined && a.image !== null && !isValidImage(a.image)) {
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

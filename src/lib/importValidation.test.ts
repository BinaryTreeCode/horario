import { describe, test, expect } from 'bun:test';
import { validateImport, EXPORT_FORMAT_VERSION } from './importValidation';

const okAct = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  categoryId: 'trabajar',
  name: 'Trabajo profundo',
  startTime: '08:00',
  endTime: '10:00',
  daysOfWeek: [0, 1],
  updatedAt: 1700000000000
};

const validFile = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    app: 'nature-planner',
    version: 3,
    exportDate: new Date().toISOString(),
    activities: [okAct],
    categories: [
      { id: 'trabajar', label: 'Trabajar', color: '#1a2a44', order: 0 },
      { id: 'rutina', label: 'Rutina', color: '#4a7c44', order: 1 }
    ],
    settings: [
      { id: 'startHour', key: 'startHour', value: 7 },
      { id: 'endHour', key: 'endHour', value: 23 }
    ],
    ...overrides
  });

describe('validateImport', () => {
  test('JSON inválido → error claro', () => {
    const r = validateImport('{ esto no es json');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('JSON');
  });

  test('no-objeto (array o string) → error', () => {
    expect(validateImport('[]').valid).toBe(false);
    expect(validateImport('"hola"').valid).toBe(false);
    expect(validateImport('null').valid).toBe(false);
  });

  test('archivo de otra app → rechazado', () => {
    const r = validateImport(JSON.stringify({ app: 'otra-app', activities: [] }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('otra aplicación');
  });

  test('versión futura → rechazado', () => {
    const r = validateImport(JSON.stringify({ app: 'nature-planner', version: EXPORT_FORMAT_VERSION + 1 }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('más nueva');
  });

  test('versión antigua (v1) → rechazado', () => {
    const r = validateImport(JSON.stringify({ app: 'nature-planner', version: 1, activities: [] }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('demasiado antigua');
  });

  test('sin ninguna tabla reconocible → rechazado', () => {
    const r = validateImport(JSON.stringify({ app: 'nature-planner', version: 3 }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('no contiene datos');
  });

  test('actividad sin nombre → warning y se descarta', () => {
    const r = validateImport(validFile({ activities: [{ ...okAct, name: '   ' }] }));
    expect(r.valid).toBe(true);
    expect(r.summary.activities).toBe(0);
    expect(r.warnings[0]).toContain('sin nombre');
  });

  test('hora de inicio inválida → warning y se descarta', () => {
    const r = validateImport(validFile({ activities: [{ ...okAct, startTime: '8am' }] }));
    expect(r.summary.activities).toBe(0);
    expect(r.warnings.join(' ')).toContain('hora de inicio inválida');
  });

  test('fin <= inicio → descartada', () => {
    const r = validateImport(validFile({ activities: [{ ...okAct, endTime: '07:00' }] }));
    expect(r.summary.activities).toBe(0);
    expect(r.warnings.join(' ')).toContain('no es posterior');
  });

  test('daysOfWeek fuera de rango / vacío / no entero → descartada', () => {
    for (const days of [[7], [-1], [1.5], ['lunes'], []]) {
      const r = validateImport(validFile({ activities: [{ ...okAct, daysOfWeek: days }] }));
      expect(r.summary.activities).toBe(0);
      expect(r.warnings.join(' ')).toContain('días de la semana inválidos');
    }
  });

  test('días duplicados se deduplican y ordenan', () => {
    const r = validateImport(validFile({ activities: [{ ...okAct, daysOfWeek: [2, 0, 2, 1] }] }));
    expect(r.summary.activities).toBe(1);
    expect(r._activities[0].daysOfWeek).toEqual([0, 1, 2]);
  });

  test('imagen inválida → se descarta la imagen, no la actividad', () => {
    const r = validateImport(validFile({ activities: [{ ...okAct, image: 'javascript:alert(1)' }] }));
    expect(r.summary.activities).toBe(1);
    expect(r._activities[0].image).toBeUndefined();
    expect(r.warnings.join(' ')).toContain('imagen');
  });

  test('imagen data URL válida se conserva', () => {
    const img = 'data:image/webp;base64,AAAA';
    const r = validateImport(validFile({ activities: [{ ...okAct, image: img }] }));
    expect(r._activities[0].image).toBe(img);
  });

  test('steps inválidos se filtran; válidos conservan título/completado', () => {
    const r = validateImport(validFile({
      activities: [{
        ...okAct,
        steps: [
          { id: 'a', title: 'Paso 1', completed: true },
          { title: '' },
          null,
          { id: 'b', title: 'Paso 2' }
        ]
      }]
    }));
    expect(r.summary.activities).toBe(1);
    expect(r._activities[0].steps).toHaveLength(2);
    expect(r._activities[0].steps![0].completed).toBe(true);
    expect(r._activities[0].steps![1].id).toBe('b');
  });

  test('paso sin id recibe uno generado', () => {
    const r = validateImport(validFile({
      activities: [{ ...okAct, steps: [{ title: 'Sin id' }] }]
    }));
    // v4 genera UUIDs (no prefijo step-); solo verificamos que recibió un id no vacío
    expect(r._activities[0].steps![0].id.length).toBeGreaterThan(8);
  });

  test('color de categoría inválido → fallback #999999', () => {
    const r = validateImport(validFile({
      categories: [{ id: 'x', label: 'X', color: 'red;', order: 0 }]
    }));
    expect(r.summary.categories).toBe(1);
    expect(r._categories[0].color).toBe('#999999');
  });

  test('categoría duplicada → warning y solo la primera', () => {
    const r = validateImport(validFile({
      categories: [
        { id: 'x', label: 'X1', color: '#111111', order: 0 },
        { id: 'x', label: 'X2', color: '#222222', order: 1 }
      ]
    }));
    expect(r.summary.categories).toBe(1);
    expect(r._categories[0].label).toBe('X1');
    expect(r.warnings.join(' ')).toContain('duplicada');
  });

  test('actividad huérfana → reasignada a "rutina" con warning', () => {
    const r = validateImport(validFile({
      activities: [{ ...okAct, categoryId: 'no-existe' }]
    }));
    expect(r.summary.activities).toBe(1);
    expect(r._activities[0].categoryId).toBe('rutina');
    expect(r.warnings.join(' ')).toContain('categorías que no existen');
  });

  test('startHour fuera de rango → se omite con warning', () => {
    const r = validateImport(validFile({
      settings: [{ id: 'startHour', key: 'startHour', value: 30 }]
    }));
    expect(r.summary.settings).toBe(0);
    expect(r.warnings.join(' ')).toContain('startHour');
  });

  test('archivo solo con dayOverrides → válido', () => {
    const r = validateImport(JSON.stringify({
      app: 'nature-planner',
      version: 3,
      dayOverrides: [{ day: 2, activities: [{ ...okAct }], updatedAt: '2026-01-01T00:00:00Z' }]
    }));
    expect(r.valid).toBe(true);
    expect(r.summary.dayOverrides).toBe(1);
    expect(r.summary.activities).toBe(0);
  });

  test('dayOverride con día 7 → descartado', () => {
    const r = validateImport(JSON.stringify({
      app: 'nature-planner',
      version: 3,
      dayOverrides: [{ day: 7, activities: [] }]
    }));
    expect(r.valid).toBe(true);
    expect(r.summary.dayOverrides).toBe(0);
    expect(r.warnings.join(' ')).toContain('día inválido');
  });

  test('override vacío (activities: []) → ignorado, sin filas fantasma', () => {
    const r = validateImport(JSON.stringify({
      app: 'nature-planner',
      version: 4,
      dayOverrides: [
        { day: 0, activities: [] },
        { day: 1, activities: [{ ...okAct }] }
      ]
    }));
    expect(r.valid).toBe(true);
    expect(r.summary.dayOverrides).toBe(1);
    expect(r._dayOverrides[0].day).toBe(1);
    expect(r.warnings.join(' ')).toContain('vacía');
  });

  test('override cuyas actividades son todas inválidas → ignorado por completo', () => {
    const r = validateImport(JSON.stringify({
      app: 'nature-planner',
      version: 4,
      dayOverrides: [{ day: 0, activities: [{ ...okAct, endTime: '08:00' }] }]
    }));
    expect(r.summary.dayOverrides).toBe(0);
    const w = r.warnings.join(' ');
    expect(w).toContain('actividad #1 inválida');
    expect(w).toContain('ignorada');
  });

  test('actividad de override normalizada con la misma whitelist', () => {
    const r = validateImport(JSON.stringify({
      app: 'nature-planner',
      version: 4,
      dayOverrides: [{
        day: 3,
        activities: [{
          ...okAct,
          id: 'x'.repeat(80),
          name: '  Override largo  ',
          description: 'd'.repeat(5000),
          image: 'javascript:alert(1)',
          steps: [{ title: 'Paso válido' }, 'basura', null],
          categoryId: 'trabajar'
        }]
      }]
    }));
    expect(r.summary.dayOverrides).toBe(1);
    const a = r._dayOverrides[0].activities[0];
    expect(a.id.length).toBeLessThanOrEqual(64);
    expect(a.name).toBe('Override largo');
    expect(a.description!.length).toBeLessThanOrEqual(2000);
    expect(a.image).toBeUndefined();
    expect(a.steps).toHaveLength(1);
    expect(a.steps![0].title).toBe('Paso válido');
    expect(a.categoryId).toBe('trabajar');
    expect(r.warnings.join(' ')).toContain('formato no reconocido');
  });

  test('id demasiado largo se trunca a 64 chars', () => {
    const r = validateImport(validFile({ activities: [{ ...okAct, id: 'y'.repeat(200) }] }));
    expect(r._activities[0].id.length).toBe(64);
  });

  test('updatedAt inválido (string/negativo) → normalizado a 0', () => {
    const r = validateImport(validFile({
      activities: [{ ...okAct, updatedAt: 'ayer' }],
      categories: [{ id: 'trabajar', label: 'Trabajar', color: '#1a2a44', order: 0, updatedAt: -5 }]
    }));
    expect(r._activities[0].updatedAt).toBe(0);
    expect(r._categories[0].updatedAt).toBe(0);
  });

  test('export v2 sin dayOverrides (legado) → válido, id numérico normalizado a string', () => {
    const r = validateImport(JSON.stringify({
      version: 2,
      activities: [{ ...okAct, id: 42 }],
      categories: [{ id: 'trabajar', label: 'Trabajar', color: '#1a2a44', order: 0 }],
      settings: []
    }));
    expect(r.valid).toBe(true);
    expect(r.summary.activities).toBe(1);
    expect(r._activities[0].id).toBe('42');
  });

  test('archivo completo válido → sin warnings y resumen correcto', () => {
    const r = validateImport(validFile());
    expect(r.valid).toBe(true);
    expect(r.warnings).toHaveLength(0);
    expect(r.summary).toEqual({ activities: 1, categories: 2, settings: 2, dayOverrides: 0 });
  });
});

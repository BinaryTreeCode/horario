import { describe, it, expect } from 'bun:test';
import { ACTIVIDADES_SEMILLA, INITIAL_CATEGORIES, filasSemilla } from './db';

// La semilla de una instalación nueva tiene tres contratos, y ninguno se veía
// mirando el código:
//  1) updatedAt 0 → no es un cambio del usuario y no viaja a la nube (LWW).
//  2) id estable → dos dispositivos que editen la misma actividad semilla
//     convergen a la MISMA fila en el servidor en vez de crear dos homónimas
//     que nunca se reconcilian.
//  3) filas completas → updatedAt presente. Una fila sin él rompe el orden de
//     la columna (NaN al comparar) y rompe el pull, sin que ningún tipo avise:
//     el bug real que introdujo un `as Activity` sobre datos sin materializar.

describe('semilla de instalación nueva', () => {
  it('las filas escritas llevan updatedAt 0 (semilla, no mutación)', () => {
    for (const fila of filasSemilla()) {
      expect(fila.updatedAt, `la fila ${fila.id} necesita updatedAt`).toBe(0);
    }
  });

  it('toda fila de la semilla tiene los campos que la app lee', () => {
    for (const fila of filasSemilla()) {
      expect(typeof fila.updatedAt).toBe('number');
      expect(Array.isArray(fila.daysOfWeek)).toBe(true);
      expect(fila.startTime).toMatch(/^\d{2}:\d{2}$/);
      expect(fila.endTime).toMatch(/^\d{2}:\d{2}$/);
      expect(typeof fila.name).toBe('string');
    }
  });

  it('filasSemilla devuelve días copiados, no la referencia compartida', () => {
    // ACTIVIDADES_SEMILLA comparte un mismo array TODOS entre varias filas.
    // Si una fila lo mutara (editar días de una actividad), todas las demás
    // cambiarían de días en memoria. Se usa "Trabajo" porque su lista NO
    // incluye el domingo: ahí el cambio se ve.
    const filas = filasSemilla();
    const trabajo = filas.find(f => f.id === 'seed-trabajo')!;
    expect(trabajo.daysOfWeek).not.toContain(6);
    trabajo.daysOfWeek.push(6);
    expect(ACTIVIDADES_SEMILLA.find(s => s.id === 'seed-trabajo')!.daysOfWeek).not.toContain(6);
  });

  it('los ids son estables y predecibles, no UUID aleatorios', () => {
    const ids = ACTIVIDADES_SEMILLA.map(a => a.id);
    expect(new Set(ids).size, 'los ids de la semilla deben ser únicos').toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^seed-/);
      // Un UUID random por dispositivo es exactamente lo que hay que evitar:
      // la misma actividad sería una fila distinta en cada uno.
      expect(id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it('misma definición en cada arranque (determinista)', () => {
    // El determinismo es lo que permite que el test e2e de accesibilidad
    // encuentre siempre el caso corto de 15 minutos.
    expect(ACTIVIDADES_SEMILLA.map(a => `${a.id}@${a.startTime}`)).toEqual([
      'seed-rutina-matutina@07:00',
      'seed-desayuno@08:00',
      'seed-trabajo@09:00',
      'seed-almuerzo@13:00',
      'seed-aseo-personal@22:00',
      'seed-tomar-sol@17:30',
    ]);
  });

  it('todas las categorías de la semilla existen en INITIAL_CATEGORIES', () => {
    const ids = new Set(INITIAL_CATEGORIES.map(c => c.id));
    for (const a of ACTIVIDADES_SEMILLA) {
      expect(ids.has(a.categoryId), `categoría desconocida: ${a.categoryId}`).toBe(true);
    }
  });

  it('el fin es posterior al inicio y hay días válidos', () => {
    const aMin = (h: string) => {
      const [hh, mm] = h.split(':').map(Number);
      return hh * 60 + mm;
    };
    for (const a of ACTIVIDADES_SEMILLA) {
      expect(aMin(a.endTime)).toBeGreaterThan(aMin(a.startTime));
      expect(a.daysOfWeek.length).toBeGreaterThan(0);
      for (const d of a.daysOfWeek) {
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(6);
      }
    }
  });

  it('incluye el caso de 15 minutos que usa el guard de accesibilidad', () => {
    const corta = ACTIVIDADES_SEMILLA.find(a => a.id === 'seed-tomar-sol');
    expect(corta).toBeDefined();
    expect(corta!.startTime).toBe('17:30');
    expect(corta!.endTime).toBe('17:45');
  });
});

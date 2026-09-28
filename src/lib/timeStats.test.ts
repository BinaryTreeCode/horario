import { describe, it, expect } from 'bun:test';
import type { Activity, Category } from './types';
import { computeCategoryStats, totalHours, formatHours } from './timeStats';

const cats: Category[] = [
  { id: 'c-rutina', label: 'Rutina', color: '#4a7c2f' },
  { id: 'c-trabajar', label: 'Trabajar', color: '#1a2a4a' }
] as unknown as Category[];

function act(partial: Partial<Activity>): Activity {
  return {
    id: crypto.randomUUID(),
    label: 'X',
    startTime: '08:00',
    endTime: '09:00',
    daysOfWeek: [0, 1, 2, 3, 4],
    categoryId: 'c-rutina',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial
  } as Activity;
}

describe('computeCategoryStats', () => {
  it('la semana suma más que un solo día (bug del 15.8h duplicado)', () => {
    const acts = [
      act({ categoryId: 'c-rutina', startTime: '08:00', endTime: '09:00', daysOfWeek: [0, 1, 2, 3, 4] }),
      act({ categoryId: 'c-trabajar', startTime: '09:00', endTime: '17:00', daysOfWeek: [0, 1, 2, 3, 4] })
    ];
    const day = totalHours(computeCategoryStats(acts, cats, [0]));
    const week = totalHours(computeCategoryStats(acts, cats, [0, 1, 2, 3, 4, 5, 6]));
    expect(day).toBe(9);           // 1h rutina + 8h trabajar
    expect(week).toBe(45);         // 5 días × 9h
    expect(week).toBeGreaterThan(day);
  });

  it('un día sin actividades aporta cero (fin de semana libre)', () => {
    const acts = [act({ daysOfWeek: [0] })];
    const week = totalHours(computeCategoryStats(acts, cats, [0, 1, 2, 3, 4, 5, 6]));
    expect(week).toBe(1);
  });

  it('los solapamientos no se cuentan doble: se reparten entre categorías', () => {
    const acts = [
      act({ categoryId: 'c-rutina', startTime: '08:00', endTime: '10:00', daysOfWeek: [0] }),
      act({ categoryId: 'c-trabajar', startTime: '08:00', endTime: '10:00', daysOfWeek: [0] })
    ];
    const stats = computeCategoryStats(acts, cats, [0]);
    expect(totalHours(stats)).toBe(2);
    expect(stats.find(s => s.key === 'c-rutina')!.value).toBe(1);
    expect(stats.find(s => s.key === 'c-trabajar')!.value).toBe(1);
  });

  it('actividades que cruzan medianoche no se colapsan (end <= start se ignora)', () => {
    const acts = [act({ startTime: '23:00', endTime: '01:00', daysOfWeek: [0] })];
    expect(totalHours(computeCategoryStats(acts, cats, [0]))).toBe(0);
  });

  it('categorías sin horas no aparecen en el resultado', () => {
    const acts = [act({ categoryId: 'c-rutina', daysOfWeek: [0] })];
    const stats = computeCategoryStats(acts, cats, [0]);
    expect(stats).toHaveLength(1);
    expect(stats[0].key).toBe('c-rutina');
  });
});

describe('formatHours', () => {
  it('formatea horas y minutos exactos', () => {
    expect(formatHours(7.5)).toBe('7h 30m');
    expect(formatHours(3)).toBe('3h');
    expect(formatHours(0.5)).toBe('30m');
    expect(formatHours(0)).toBe('0m');
  });

  it('evita residuos de flotantes', () => {
    expect(formatHours(15.799999999)).toBe('15h 48m');
  });
});

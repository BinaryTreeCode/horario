import { describe, test, expect } from 'bun:test';
import { computeRestores } from './undoPlan';
import type { UndoOp } from './undo';
import type { Activity, DayOverride } from './types';

const act = (id: string, start: string, end: string, updatedAt: number, days = [0]): Activity => ({
  id, categoryId: 'c', name: `A-${id}`, startTime: start, endTime: end, daysOfWeek: days, updatedAt
});

const op = (rows: UndoOp['rows'], overrides?: UndoOp['overrides']): UndoOp => ({ label: 'test', rows, overrides });

describe('computeRestores', () => {
  test('restaura el before cuando la fila sigue intacta', () => {
    const before = act('1', '08:00', '09:00', 100);
    const after = act('1', '10:00', '11:00', 200);
    const plan = computeRestores(op([{ before, after }]), new Map([['1', after]]), new Map());
    expect(plan.acts.length).toBe(1);
    expect(plan.acts[0].startTime).toBe('08:00');
    expect(plan.delActs.length).toBe(0);
    expect(plan.skipped).toBe(0);
  });

  test('descarta la fila si el usuario la mutó después (guard updatedAt)', () => {
    const before = act('1', '08:00', '09:00', 100);
    const after = act('1', '10:00', '11:00', 200);
    const mutated = act('1', '12:00', '13:00', 999);
    const plan = computeRestores(op([{ before, after }]), new Map([['1', mutated]]), new Map());
    expect(plan.acts.length).toBe(0);
    expect(plan.skipped).toBe(1);
  });

  test('deshacer una creación elimina la fila', () => {
    const created = act('2', '08:00', '09:00', 100);
    const plan = computeRestores(op([{ before: null, after: created }]), new Map([['2', created]]), new Map());
    expect(plan.delActs).toEqual(['2']);
    expect(plan.acts.length).toBe(0);
  });

  test('deshacer un borrado resucita la fila (after era null, fila ausente)', () => {
    const before = act('3', '08:00', '09:00', 100);
    // after: null — la fila ya no debe existir para restaurar
    const plan = computeRestores(op([{ before, after: null }]), new Map([['3', undefined]]), new Map());
    expect(plan.acts.length).toBe(1);
    expect(plan.acts[0].id).toBe('3');
  });

  test('override creado → se elimina el día; override previo → se restaura', () => {
    const ovBefore: DayOverride = { day: 3, activities: [act('x', '08:00', '09:00', 1)], updatedAt: 10 };
    const ovAfter: DayOverride = { day: 3, activities: [act('x', '09:00', '10:00', 1)], updatedAt: 20 };
    const planNew = computeRestores(op([], [{ day: 3, before: null, after: ovAfter }]), new Map(), new Map([[3, ovAfter]]));
    expect(planNew.delOverrides).toEqual([3]);
    const planPrev = computeRestores(op([], [{ day: 3, before: ovBefore, after: ovAfter }]), new Map(), new Map([[3, ovAfter]]));
    expect(planPrev.overrides.length).toBe(1);
    expect(planPrev.overrides[0].activities![0].startTime).toBe('08:00');
  });

  test('override mutado después → skipped', () => {
    const ovAfter: DayOverride = { day: 3, activities: [], updatedAt: 20 };
    const ovNow: DayOverride = { day: 3, activities: [], updatedAt: 55 };
    const plan = computeRestores(op([], [{ day: 3, before: null, after: ovAfter }]), new Map(), new Map([[3, ovNow]]));
    expect(plan.skipped).toBe(1);
    expect(plan.delOverrides.length).toBe(0);
  });
});

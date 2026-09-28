// Estadísticas de horas planificadas por categoría — módulo PURO (sin Dexie,
// sin stores) para poder testearlo con bun test de forma aislada.
//
// Bug histórico que corrige: la versión anterior replicaba el MISMO intervalo
// `daysOfWeek.length` veces y la lógica anti-solapamiento dividía cada tramo
// entre las copias, cancelándose: la semana sumaba exactamente lo mismo que
// un día (el "15.8h" duplicado de los donuts). Ahora se recorre día por día
// y se acumula de verdad.

import type { Activity, Category } from './types.js';

/** "HH:MM" → horas decimales (acepta "24:00"). Replica parseTime de stores.ts sin arrastrar la importación de Dexie. */
function parseTimeToHours(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + m / 60;
}

export interface CategoryStat {
  key: string;
  label: string;
  color: string;
  /** Horas decimales de la categoría en los días pedidos. */
  value: number;
}

/**
 * Horas por categoría para los días pedidos (índices 0=Lunes..6=Domingo,
 * misma convención que Activity.daysOfWeek).
 *
 * Los solapamientos NO se cuentan doble: dentro de cada día los tramos se
 * reparten a partes iguales entre las categorías que los cubren (así el total
 * del día nunca excede el tramo horario real).
 */
export function computeCategoryStats(
  activities: Activity[],
  categories: Category[],
  days: number[],
  /** Rango horario configurado (startHour..endHour): los intervalos fuera del
   *  rango se RECORTAN, no se descartan — así las stats y el "Libre" siempre
   *  hablan del horario planificado, nunca del tiempo fuera de él. */
  range?: { start: number; end: number }
): CategoryStat[] {
  const stats: Record<string, number> = {};

  for (const day of days) {
    // 1) Intervalos concretos (start, end, categoryId) de ESTE día
    const intervals: { start: number; end: number; categoryId: string }[] = [];
    for (const a of activities) {
      if (!a.daysOfWeek.includes(day)) continue;
      let s = parseTimeToHours(a.startTime);
      let e = parseTimeToHours(a.endTime);
      if (e <= s) continue;
      if (range) {
        s = Math.max(s, range.start);
        e = Math.min(e, range.end);
        if (e <= s) continue; // queda fuera del rango horario por completo
      }
      intervals.push({ start: s, end: e, categoryId: a.categoryId });
    }
    if (intervals.length === 0) continue;

    // 2) Breakpoints → cobertura por tramo, repartida entre las categorías activas
    const points = [...new Set(intervals.flatMap(iv => [iv.start, iv.end]))].sort((x, y) => x - y);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const covering = intervals.filter(iv => iv.start <= a && iv.end >= b);
      if (covering.length === 0) continue;
      const slice = (b - a) / covering.length;
      for (const iv of covering) {
        stats[iv.categoryId] = (stats[iv.categoryId] || 0) + slice;
      }
    }
  }

  return categories
    .map((c: Category) => ({
      key: c.id,
      label: c.label,
      value: stats[c.id] || 0,
      color: c.color
    }))
    .filter((s: CategoryStat) => s.value > 0);
}

/**
 * Capacidad REAL del rango horario configurado: "Libre" son los HUECOS
 * dentro del horario (p. ej. 7→23 = 16h por día), nunca el tiempo fuera de
 * él. La semana es la misma capacidad × 7 días.
 */
export function capacidadDia(startHour: number, endHour: number): number {
  return Math.max(0, endHour - startHour);
}
export function capacidadSemana(startHour: number, endHour: number): number {
  return capacidadDia(startHour, endHour) * 7;
}

/**
 * Añade la categoría sintética "espacio libre": horas del rango pedido que
 * ninguna actividad cubre (capacidad − ocupación, nunca negativa).
 *
 * La ocupación diaria real ya está libre de dobles conteos (los solapamientos
 * se reparten, no se suman), así que basta un reparto proporcional simple.
 */
export function withFreeTime(
  stats: CategoryStat[],
  capacity: number
): CategoryStat[] {
  const used = Math.min(capacity, totalHours(stats));
  const free = capacity - used;
  if (free <= 0) return stats;
  return [
    ...stats,
    {
      key: '__free__',
      label: '__free__',
      color: 'var(--donut-free, #d8d5cd)',
      value: free
    }
  ];
}

/** Total de horas de una lista de stats. */
export function totalHours(stats: CategoryStat[]): number {
  return stats.reduce((acc, s) => acc + s.value, 0);
}

/** "7.5" → "7h 30m"; "0.5" → "30m"; "3" → "3h". Minutos redondeados para evitar residuos de flotantes. */
export function formatHours(hours: number): string {
  const totalMin = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

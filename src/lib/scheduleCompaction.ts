import type { Activity } from './types';
import { parseTime, formatTime } from './timeUtils';

/**
 * Compacta las actividades de un día eliminando huecos hacia el límite indicado.
 * - 'arriba': desplaza las actividades hacia `limiteH` (inicio del día) conservando duraciones.
 * - 'abajo': desplaza las actividades hacia `limiteH` (fin del día) conservando duraciones.
 * No muta los objetos originales recibidos; retorna un nuevo arreglo ordenado cronológicamente.
 */
export function compactarDia(
  acts: Activity[],
  limiteH: number,
  direccion: 'arriba' | 'abajo'
): Activity[] {
  if (!acts || acts.length === 0) return [];

  // Clonar actividades superficialmente para no mutar las de entrada
  const dayActs = acts.map(a => ({ ...a }));

  if (direccion === 'arriba') {
    dayActs.sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));
    let prevEnd = limiteH;
    for (const act of dayActs) {
      const actStart = parseTime(act.startTime);
      if (actStart > prevEnd) {
        const duration = parseTime(act.endTime) - actStart;
        act.startTime = formatTime(prevEnd);
        act.endTime = formatTime(prevEnd + duration);
      }
      prevEnd = parseTime(act.endTime);
    }
    return dayActs;
  } else {
    // Desde la última hacia atrás
    dayActs.sort((a, b) => parseTime(b.endTime) - parseTime(a.endTime));
    let nextStart = limiteH;
    for (const act of dayActs) {
      const actEnd = parseTime(act.endTime);
      if (actEnd < nextStart) {
        const duration = actEnd - parseTime(act.startTime);
        act.startTime = formatTime(nextStart - duration);
        act.endTime = formatTime(nextStart);
      }
      nextStart = parseTime(act.startTime);
    }
    // Devolver ordenadas cronológicamente
    dayActs.sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));
    return dayActs;
  }
}

/**
 * Calcula los cambios de horario necesarios para compactar la semana completa día por día.
 * Conserva la semántica de `Dashboard.svelte` donde una actividad multi-día se comparte
 * y se ajusta consecutivamente por cada día evaluado.
 * Retorna una lista de cambios `{ id, startTime, endTime }` para aquellas actividades
 * cuyos horarios se hayan modificado.
 */
export function planearCompactacionSemanal(
  activities: Activity[],
  limiteH: number,
  direccion: 'arriba' | 'abajo'
): { id: string; startTime: string; endTime: string }[] {
  if (!activities || activities.length === 0) return [];

  // Clonar las actividades para simular la compactación multi-día
  const updatedActivities = activities.map(a => ({
    ...a,
    daysOfWeek: [...(a.daysOfWeek || [])]
  }));

  for (let day = 0; day < 7; day++) {
    const dayActs = updatedActivities.filter(a => a.daysOfWeek.includes(day));

    if (direccion === 'arriba') {
      dayActs.sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));
      let prevEnd = limiteH;
      for (const act of dayActs) {
        const actStart = parseTime(act.startTime);
        if (actStart > prevEnd) {
          const duration = parseTime(act.endTime) - actStart;
          act.startTime = formatTime(prevEnd);
          act.endTime = formatTime(prevEnd + duration);
        }
        prevEnd = parseTime(act.endTime);
      }
    } else {
      dayActs.sort((a, b) => parseTime(b.endTime) - parseTime(a.endTime));
      let nextStart = limiteH;
      for (const act of dayActs) {
        const actEnd = parseTime(act.endTime);
        if (actEnd < nextStart) {
          const duration = actEnd - parseTime(act.startTime);
          act.startTime = formatTime(nextStart - duration);
          act.endTime = formatTime(nextStart);
        }
        nextStart = parseTime(act.startTime);
      }
    }
  }

  const cambios: { id: string; startTime: string; endTime: string }[] = [];
  for (const act of updatedActivities) {
    const original = activities.find(o => o.id === act.id);
    if (original && (original.startTime !== act.startTime || original.endTime !== act.endTime)) {
      if (act.id) {
        cambios.push({
          id: act.id,
          startTime: act.startTime,
          endTime: act.endTime
        });
      }
    }
  }

  return cambios;
}

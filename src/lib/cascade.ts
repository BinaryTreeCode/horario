/**
 * Resolución de colisiones (cascada push-down) compartida por las vistas
 * Día y Semana. Un solo dueño: cuando cambia la matemática, cambia en ambos
 * lados. Pura y testeada (cascade.test.ts).
 *
 * Modelo (greedy forward, acotado por construcción): cada bloque se coloca
 * después de lo ya colocado (push-down) preservando su duración; si no cabe
 * antes del fin del día se sube pegado al final; si tampoco cabe ahí, queda
 * en el borde y se recorta (último recurso). NADA sale nunca del rango
 * [startHour, endHour] ni por abajo ni por arriba (A2) — sin horas
 * negativas tipo "06:30" en un día 7–10.
 *
 * Aritmética en MINUTOS ENTEROS: evita "09:60" por error de coma flotante
 * con duraciones importadas no múltiplo de 15 (9.999h → 09:60).
 *
 * Multi-día: las actividades son UNA fila con horario global, así que un
 * cambio se propaga en cierre transitivo: cada día afectado se resuelve con
 * la actividad arrastrada ANCLADA (pin) a lo que el usuario vio; los vecinos
 * empujados cambian su horario global, lo que puede afectar SUS otros días →
 * se re-resuelven hasta estabilizar (acotado a 7 iteraciones = 7 días).
 */
import type { Activity } from './types.js';

export interface Slot {
  id: string;
  start: number;
  end: number;
}

/** Convertidor inyectable para no importar la store desde este módulo puro. */
export interface TimeCodec {
  parse: (time: string) => number;
  format: (hour: number) => string;
}

/** Hora → minutos enteros, redondeados al minuto (blindaje anti-flotantes). */
const toMin = (h: number) => Math.round(h * 60);

/**
 * Aplica la cascada push-down a un día completo, en minutos enteros y
 * acotada a [startHour, endHour]. `slots` debe cubrir TODAS las actividades
 * del día. Con `pinnedId`, esa actividad es una pared: nunca se mueve ni se
 * recorta (el usuario la vio así). Sin pinnedId, todos los bloques son
 * colocables. Toque mínimo: no cierra huecos pre-existentes (M2).
 */
export function resolveDayCascade(
  slots: Slot[],
  endHour: number,
  pinnedId?: string,
  startHour = 0
): Slot[] {
  const startMin = toMin(startHour);
  const endMin = toMin(endHour);

  // En empates de arranque la pared va PRIMERO: si el drop cae exactamente
  // encima de otra actividad, la existente se empuja hacia abajo (hay
  // espacio) — misma semántica push-down que la vista Día, no solape.
  const all = slots
    .map(s => ({ id: s.id, start: toMin(s.start), end: toMin(s.end) }))
    .sort((a, b) => a.start - b.start || (a.id === pinnedId ? -1 : b.id === pinnedId ? 1 : 0));

  const out: { id: string; start: number; end: number }[] = [];
  let cursor = startMin; // fin del último bloque colocado (barrera de push-down)

  for (const slot of all) {
    if (slot.id === pinnedId) {
      // Pared: queda exactamente donde el usuario la soltó.
      cursor = Math.max(cursor, slot.end);
      out.push(slot);
      continue;
    }

    const dur = Math.max(0, slot.end - slot.start);
    let start = Math.max(slot.start, cursor); // push-down preservando duración
    let end = start + dur;

    if (end > endMin) {
      // No cabe donde quedó: subir pegado al final del día (comprimir hacia
      // atrás) si hay hueco completo; si no, pegado al borde y recorte.
      const pulled = Math.max(cursor, endMin - dur);
      if (pulled + dur <= endMin) {
        start = pulled;
        end = pulled + dur;
      } else {
        start = Math.min(start, endMin);
        end = endMin;
      }
    }

    if (start < startMin) start = startMin;
    end = Math.max(end, start); // guard anti-inversión

    out.push({ id: slot.id, start, end });
    cursor = Math.max(cursor, end);
  }

  return out.map(s => ({ id: s.id, start: s.start / 60, end: s.end / 60 }));
}

export interface WeeklyResolution {
  /** id → slot final, por día incluido en el cierre. */
  byDay: Map<number, Map<string, Slot>>;
  /** Horario global final por actividad (lo escribible en la BD). */
  times: Map<string, Slot>;
}

/**
 * Propaga el cambio de una actividad a TODOS los días afectados.
 * `pinnedStart` es el arranque que el usuario vio en el preview (la pared).
 * `mineDays` son los días finales de la arrastrada (el commit puede quitar el
 * origen en un drag entre columnas — la BD aún tiene los viejos).
 */
export function propagateWeekly(
  activities: Activity[],
  actId: string,
  pinnedStart: number,
  endHour: number,
  codec: TimeCodec,
  mineDays: number[],
  newDuration?: number,
  startHour = 0
): WeeklyResolution {
  const act = activities.find(a => a.id === actId);
  if (!act) return { byDay: new Map(), times: new Map() };
  const duration = newDuration ?? (codec.parse(act.endTime) - codec.parse(act.startTime));

  const times = new Map<string, Slot>();
  for (const a of activities) {
    times.set(a.id!, { id: a.id!, start: codec.parse(a.startTime), end: codec.parse(a.endTime) });
  }
  times.set(actId, { id: actId, start: pinnedStart, end: pinnedStart + duration });

  const myDays = new Set(mineDays);
  const isOnDay = (a: Activity, day: number) =>
    a.id === actId ? myDays.has(day) : a.daysOfWeek.includes(day);

  const daySet = new Set<number>(mineDays);
  for (let iter = 0; iter < 7; iter++) {
    let changed = false;
    for (const day of [...daySet].sort((a, b) => a - b)) {
      const slots = activities.filter(a => isOnDay(a, day)).map(a => times.get(a.id!)!);
      const resolved = resolveDayCascade(slots, endHour, actId, startHour);
      for (const s of resolved) {
        const cur = times.get(s.id);
        if (!cur || Math.abs(cur.start - s.start) > 1e-9 || Math.abs(cur.end - s.end) > 1e-9) {
          // El push de un vecino es LOCAL al día: cambiar su horario global
          // lo movería también en días donde NADIE lo empujó (corrupción
          // silenciosa, ex-C3). Protección: solo se acepta el movimiento
          // global del vecino si no colisiona con nadie en SUS otros días;
          // si rompería, se descarta (queda el solape local permitido).
          const owner = activities.find(a => a.id === s.id);
          if (owner && owner.id !== actId) {
            const otherDays = owner.daysOfWeek.filter(d => !daySet.has(d));
            const breaks = otherDays.some(d =>
              activities
                .filter(a => a.id !== owner.id && a.daysOfWeek.includes(d))
                .some(o => {
                  const t = times.get(o.id!)!;
                  return s.start < t.end - 1e-9 && t.start < s.end - 1e-9;
                })
            );
            if (breaks) continue;
          }
          times.set(s.id, s);
          changed = true;
          if (owner) owner.daysOfWeek.forEach(d => daySet.add(d));
        }
      }
    }
    if (!changed) break;
  }

  const byDay = new Map<number, Map<string, Slot>>();
  for (const day of daySet) {
    const daySlots = activities.filter(a => isOnDay(a, day)).map(a => times.get(a.id!)!);
    byDay.set(day, new Map(daySlots.map(s => [s.id, s])));
  }
  return { byDay, times };
}

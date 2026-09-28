<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Activity, Category, DayOverride } from '../lib/types';
  import { parseTime, getActivityColor, formatTime, format12h } from '../lib/stores';
  import { resolveDayCascade, resolveResizeDay, resolveNudgeDay, propagateWeekly, capacidadResizeWeekly } from '../lib/cascade';
  import type { WeeklyResolution } from '../lib/cascade';
  import { db } from '../lib/db';
  import { duplicateActivity as duplicateActivityOp } from '../lib/activityOps';
  import { Copy, Trash2, ListChecks, ImageIcon } from '@lucide/svelte';
  import ImageLightbox from './ImageLightbox.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr, toastErrRepetido } from '../lib/toast';
  import { cloneAct } from '../lib/undo';
  import { portal } from '../lib/portal';
  import { createDragEngine, type DragHooks, type DragTarget } from '../lib/dragEngine';
  import { t, tNow } from '../lib/i18n';

  interface Props {
    activities: Activity[];
    categories: Category[];
    settings: { startHour: number; endHour: number };
    dayOverrides?: DayOverride[];
    onSelectDay: (day: number) => void;
    onEditActivity: (id: string | null) => void;
  }

  let { activities, categories, settings, dayOverrides = [], onSelectDay, onEditActivity }: Props = $props();

  // ── Drag & Drop: la mecánica vive en src/lib/dragEngine.ts (dueño único,
  // compartida con la vista Día). El quiet-hold táctil (G6) se ELIMINÓ (F3
  // del plan v2): el dedo quieto ya no cancela el drag — era la causa de
  // arrastres "trabados". El menú contextual queda solo para mouse (click
  // derecho); "Duplicar" vive en el modal de edición.
  // (La supresión del click sintético post-drag vive en el motor.)

  function openContextMenu(activityId: string, x: number, y: number) {
    // Solo mouse (click derecho). Clamp para que el menú no se salga de la
    // ventana (MENU_H: 2 items × 44px + padding — con 130 quedaba fuera en
    // landscape; ya no cuenta "Duplicar", que vive en el modal).
    const MENU_W = 220;
    const MENU_H = 160;
    const cx = Math.min(x, window.innerWidth - MENU_W - 8);
    const cy = Math.min(y, window.innerHeight - MENU_H - 8);
    contextMenu = { show: true, x: Math.max(4, cx), y: Math.max(4, cy), activityId };
  }

  const engine = createDragEngine({
    ghostClass: 'drag-ghost',
    scrollAxis: 'x',
    // El scroller real del eje x es el CONTENEDOR (.grid-scroll es flex,
    // overflow visible): el auto-scroll de bordes necesita el que tiene
    // overflow-x:auto.
    scrollContainer: () => document.querySelector('.weekly-grid-container')
  });

  onDestroy(() => engine.destroy());

  const days = $derived([0, 1, 2, 3, 4, 5, 6].map(i => $t(`day.${i}`)));
  const startHour = $derived(settings.startHour);
  const endHour = $derived(settings.endHour);
  const totalHours = $derived(endHour - startHour);
  
  // 15-minute precision (4 slots per hour)
  const slotsPerHour = 4;
  /** Altura de slot en px. En viewports anchos (≥1536px) sube a 30px para
   *  aprovechar pantallas grandes/ultrawide: la matemática del drag no cambia
   *  porque usa esta constante (reactiva) y el rect vivo del grid. */
  const ALTURA_COMPACTA = 26; // ≥26px/slot: bloques de 15min tocables (~44px los de 30min, 104px los de 1h)
  const ALTURA_GRANDE = 30;
  let slotHeightPx = $state(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1536px)').matches ? ALTURA_GRANDE : ALTURA_COMPACTA
  );
  const totalSlots = $derived(totalHours * slotsPerHour);

  $effect(() => {
    const mq = window.matchMedia('(min-width: 1536px)');
    const sync = () => { slotHeightPx = mq.matches ? ALTURA_GRANDE : ALTURA_COMPACTA; };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });

  const hours = $derived(Array.from({ length: totalHours + 1 }, (_, i) => startHour + i));

  /** Codec de tiempos inyectable a la cascada (única instancia). */
  const CODEC = { parse: parseTime, format: formatTime };

  // Calculate grid row position with 15-min precision using round
  function getRowPosition(timeStr: string) {
    const time = parseTime(timeStr);
    const offset = time - startHour;
    return Math.max(1, Math.round(offset * slotsPerHour) + 1);
  }

  interface LayoutActivity extends Activity {
    rowStart: number;
    rowEnd: number;
    numSlots: number;
    top: string;
    height: string;
    left: string;
    width: string;
  }

  // Filter, calculate precise row slots and resolve overlaps per day.
  // Layout absoluto (top/height en %) en vez de grid-row: permite animar la
  // cascada con transition CSS (grid-row no es animable). Los tracks son los
  // mismos clusters de solape de antes.
  function getDayActivitiesWithLayout(dayIndex: number, preview?: Map<string, { start: number; end: number }>, excludeId?: string | null) {
    const dayActs = activities
      .filter((a: Activity) => a.daysOfWeek.includes(dayIndex))
      .map(a => {
        const p = preview?.get(a.id!);
        return {
          ...a,
          _start: p ? p.start : parseTime(a.startTime),
          _end: p ? p.end : parseTime(a.endTime)
        };
      })
      .sort((a, b) => a._start - b._start || (b._end - b._start) - (a._end - a._start));

    if (dayActs.length === 0) return { items: [] as LayoutActivity[], maxCols: 1 };

    // En pleno drag la tarjeta arrastrada NO participa en clusters/tracks:
    // es un fantasma (sigue al cursor); excluirla evita que una vecina que
    // ocupa su hueco la parta en columnas angostas.
    const layoutable = excludeId ? dayActs.filter(a => a.id !== excludeId) : dayActs;
    if (layoutable.length === 0) {
      // Solo el fantasma: se dibuja a ancho completo en su slot de BD.
      const d = dayActs.find(a => a.id === excludeId)!;
      return {
        items: [ghostItem(d)],
        maxCols: 1
      };
    }

    // Group into clusters of overlapping activities
    const clusters: (typeof layoutable)[] = [];
    let currentCluster: typeof layoutable = [];
    let clusterEnd = -1;

    for (const act of layoutable) {
      if (currentCluster.length === 0 || act._start < clusterEnd - 0.0001) {
        currentCluster.push(act);
        clusterEnd = Math.max(clusterEnd, act._end);
      } else {
        clusters.push(currentCluster);
        currentCluster = [act];
        clusterEnd = act._end;
      }
    }
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    let overallMaxCols = 1;
    const preliminaryItems: { act: typeof layoutable[0]; track: number; clusterCols: number }[] = [];

    for (const cluster of clusters) {
      const tracks: number[] = [];
      for (const act of cluster) {
        let assigned = -1;
        for (let t = 0; t < tracks.length; t++) {
          if (tracks[t] <= act._start + 0.0001) {
            assigned = t;
            tracks[t] = act._end;
            break;
          }
        }
        if (assigned === -1) {
          assigned = tracks.length;
          tracks.push(act._end);
        }
        preliminaryItems.push({ act, track: assigned, clusterCols: 0 });
      }

      const cCols = Math.max(1, tracks.length);
      if (cCols > overallMaxCols) overallMaxCols = cCols;

      for (let j = preliminaryItems.length - cluster.length; j < preliminaryItems.length; j++) {
        preliminaryItems[j].clusterCols = cCols;
      }
    }

    const resultItems: LayoutActivity[] = preliminaryItems.map(item => {
      const s = item.act._start;
      const e = item.act._end;
      const topPct = ((s - startHour) / totalHours) * 100;
      const heightPct = ((e - s) / totalHours) * 100;
      const widthPct = 100 / overallMaxCols;
      const leftPct = item.track * widthPct;
      return {
        ...item.act,
        rowStart: getRowPosition(item.act.startTime),
        rowEnd: Math.max(getRowPosition(item.act.startTime) + 1, getRowPosition(item.act.endTime)),
        numSlots: Math.max(1, Math.round((e - s) * slotsPerHour)),
        top: `${topPct}%`,
        height: `calc(${heightPct}% - 3px)`,
        left: `${overallMaxCols > 1 ? leftPct : 0}%`,
        width: overallMaxCols > 1 ? `calc(${widthPct}% - 3px)` : '100%'
      };
    });

    // El fantasma se reinserta a ancho completo, en su slot de BD (el cursor lo transporta).
    if (excludeId) {
      const d = dayActs.find(a => a.id === excludeId);
      if (d) resultItems.push(ghostItem(d));
    }

    return { items: resultItems, maxCols: overallMaxCols };
  }

  function ghostItem(d: any): LayoutActivity {
    const s = parseTime(d.startTime);
    const e = parseTime(d.endTime);
    const topPct = ((s - startHour) / totalHours) * 100;
    const heightPct = ((e - s) / totalHours) * 100;
    return {
      ...d,
      rowStart: getRowPosition(d.startTime),
      rowEnd: Math.max(getRowPosition(d.startTime) + 1, getRowPosition(d.endTime)),
      numSlots: Math.max(1, Math.round((e - s) * slotsPerHour)),
      top: `${topPct}%`,
      height: `calc(${heightPct}% - 3px)`,
      left: '0%',
      width: '100%'
    };
  }

  // Drag and Drop handlers (mecánica en src/lib/dragEngine.ts)
  let draggedActivityId = $state<string | null>(null);
  let dragSourceDay = $state<number | null>(null);
  let dragOffsetHours = 0;
  /** Última mitad elegida por pisado: histéresis ±10% — cruzar el centro no
   *  alterna antes/después hasta alejarse del umbral (mata la vibración). */
  let mitadActual = new Map<string, 'antes' | 'despues'>();
  /** Firma del último preview publicado: si no cambió por CONTENIDO, no se
   *  reasigna (las transiciones CSS no se relanzan → cero parpadeo). */
  let firmaPreview = '';

  /** Histéresis del umbral de mitades: ZONA 0.5 con banda muerta ±0.1. */
  function decidirMitad(pisadoId: string, rel: number): 'antes' | 'despues' {
    const previa = mitadActual.get(pisadoId) ?? 'antes';
    const zona = previa === 'antes' ? 0.5 + 0.1 : 0.5 - 0.1;
    const nueva = rel < zona ? 'antes' : 'despues';
    mitadActual.set(pisadoId, nueva);
    return nueva;
  }

  /** Columna + grid bajo el puntero (null = fuera de la grilla). */
  function dropTargetAt(x: number, y: number): { day: number; grid: HTMLElement } | null {
    const col = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.day-column');
    if (!col) return null;
    const day = [...document.querySelectorAll('.day-column')].indexOf(col);
    const grid = document.querySelectorAll('.slots-grid')[day] as HTMLElement | undefined;
    return day >= 0 && grid ? { day, grid } : null;
  }

  /** Inicio (horas, snap 15min) para un drop en un grid — el preview y el
   *  commit usan la MISMA matemática: lo que se ve es lo que se guarda. */
  function slotStartAt(grid: HTMLElement, y: number, duration: number): number {
    const rect = grid.getBoundingClientRect();
    let start = (y - rect.top) / (slotHeightPx * slotsPerHour) + startHour - dragOffsetHours;
    start = Math.round(start * 4) / 4;
    return Math.max(startHour, Math.min(start, endHour - duration));
  }

  const dragHooks: DragHooks = {
    onActivate(t) {
      draggedActivityId = t.activityId;
      dragSourceDay = (t.meta as { day: number }).day;
      mitadActual.clear();
      firmaPreview = '';
    },
    onMove(t, x, y) {
      // Sincrónico a propósito: la protección anti-jitter NO es el throttle
      // (los rAF pueden venir throttled) sino la doble barrera determinista
      // de publicarPreview: histéresis en la mitad + firma por contenido que
      // evita reescribir el layout si el resultado no cambió.
      dragGhostXY = { x, y };
      if (draggedActivityId === null) return;
      actualizarPreview(x, y);
    },
    async onDrop(t, x, y) {
      const sourceDay = (t.meta as { day: number }).day;
      const activity = activities.find(a => a.id === t.activityId);
      if (!activity) { clearDragPreview(); return; }
      const target = dropTargetAt(x, y);
      const day = target?.day ?? sourceDay;
      const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
      // La MISMA matemática del preview decide validez y layout: lo que se
      // vio es lo que se guarda. Inválido → toast ⛔ y el bloque vuelve.
      if (target) {
        const rect = target.grid.getBoundingClientRect();
        const fingerHour = startHour + (y - rect.top) / (slotHeightPx * slotsPerHour);
        let newStart = Math.round((startHour + (y - rect.top) / (slotHeightPx * slotsPerHour) - dragOffsetHours) * 4) / 4;
        newStart = Math.max(startHour, Math.min(newStart, endHour - duration));
        const targetSlots = activities
          .filter(a => a.daysOfWeek.includes(day))
          .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
        const crossInto = !activity.daysOfWeek.includes(day);
        const res = resolveDayCascade(
          targetSlots,
          { id: t.activityId, start: newStart, end: newStart + duration },
          fingerHour,
          crossInto,
          startHour,
          endHour
        );
        if (!res.valido) {
          // Puerta de repetición: 1er fallo silencioso, al insistir → toast.
          toastErrRepetido(`mover-semana:${day}`, res.motivo);
          clearDragPreview();
          return;
        }
        // ── Cascada completa con RECHAZO multi-día: si el movimiento choca
        // en otro día, NO se escribe nada y el bloque vuelve (antes la
        // "pared" empujaba ajenos sin permiso).
        dragSourceDay = sourceDay;
        const cascada = computeFullCascade(t.activityId, day, res.movido.start, res);
        if (!cascada.valido) {
          // Puerta de repetición: 1er fallo silencioso, al insistir → toast.
          toastErrRepetido(`mover-semana:${day}`, cascada.motivo);
          clearDragPreview();
          return;
        }
        dropPreview = { day, slots: new Map(res.slots.map(s => [s.id, { start: s.start, end: s.end }])) };
        let newDays = [...activity.daysOfWeek];
        const idx = newDays.indexOf(sourceDay);
        if (idx !== -1) {
          newDays[idx] = day;
        } else if (!newDays.includes(day)) {
          newDays.push(day);
        }
        newDays = [...new Set(newDays)].sort((a, b) => a - b);
        // Asentado suave: el dropPreview ya posiciona la tarjeta en su slot
        // final; el commit corre debajo y el doble rAF suelta el ancla sin
        // salto (igual que la vista Día).
        try {
          await commitWeeklyTimes(cascada.times, `Mover ${activity.name} a ${days[day]}`, { id: t.activityId, days: newDays });
        } finally {
          settle2(() => clearDragPreview());
        }
        return;
      }
      // Soltar FUERA de la grilla = cancelar (el bloque vuelve a su sitio):
      // nunca commit-un-movimiento-al-startHour (corruptor silencioso).
      clearDragPreview();
    },
    onCancel() {
      // C2: soltar fuera de la grilla, Esc o cancel — sin reset la tarjeta
      // queda con opacidad y fuera del layout hasta el próximo arrastre.
      clearDragPreview();
    }
  };

  /** Doble rAF: la store re-emite y el navegador pinta antes de soltar el ancla. */
  /** Doble rAF con fallback por timeout: ver settle2 de la vista Día
   *  (rAF throttled en navegadores embebidos → la limpieza nunca correría). */
  const settle2 = (fn: () => void) => {
    let done = false;
    const run = () => { if (!done) { done = true; fn(); } };
    requestAnimationFrame(() => requestAnimationFrame(run));
    setTimeout(run, 160);
  };

  /**
   * Recalcula el preview del drop (throttled por rAF desde onMove). Hora
   * CRUDA del dedo decide hueco vs mitades; histéresis en el umbral; el
   * resultado solo se publica si difiere por CONTENIDO del anterior.
   */
  function actualizarPreview(x: number, y: number) {
    if (draggedActivityId === null) return;
    const activity = activities.find(a => a.id === draggedActivityId);
    if (!activity) return;
    const target = dropTargetAt(x, y);
    if (!target) {
      publicarPreview(null, null, false, '');
      return;
    }
    const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
    const rect = target.grid.getBoundingClientRect();
    const fingerHour = startHour + (y - rect.top) / (slotHeightPx * slotsPerHour);
    const start = Math.round((startHour + (y - rect.top) / (slotHeightPx * slotsPerHour) - dragOffsetHours) * 4) / 4;
    const snapped = Math.max(startHour, Math.min(start, endHour - duration));
    const targetSlots = activities
      .filter(a => a.daysOfWeek.includes(target.day))
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    const crossInto = !activity.daysOfWeek.includes(target.day);
    const res = resolveDayCascade(
      targetSlots,
      { id: activity.id!, start: snapped, end: snapped + duration },
      fingerHour,
      crossInto,
      startHour,
      endHour
    );
    publicarPreview(
      target.day,
      res.valido ? res.slots : null,
      !res.valido,
      !res.valido ? '⛔ No cabe' : res.accion === 'insertar' ? '↕ Insertar aquí' : ''
    );
  }

  /** Publica el preview solo si el contenido cambió (anti-parpadeo). */
  function publicarPreview(day: number | null, slots: { id: string; start: number; end: number }[] | null, invalido: boolean, hint: string) {
    const firma = slots ? `${day}:${slots.map(s => `${s.id}@${s.start}-${s.end}`).join('|')}` : 'null';
    if (draggedActivityId !== null) {
      const mio = slots?.find(s => s.id === draggedActivityId);
      if (mio) dragGhostHora = `${format12h(formatTime(mio.start))} – ${format12h(formatTime(mio.end))}`;
      // (El resalte de mitad del pisado se retiró: el feedback de posición
      // vive en el clon flotante — hora proyectada + acción del drop.)
    }
    if (firma === firmaPreview) {
      setInvalid(invalido); // el texto puede cambiar sin cambiar el layout
      dragHint = hint;
      return;
    }
    firmaPreview = firma;
    setInvalid(invalido);
    dragHint = hint;
    dropPreview = slots ? { day: day!, slots: new Map(slots.map(s => [s.id, { start: s.start, end: s.end }])) } : null;
  }

  function handleItemPointerDown(e: PointerEvent, activity: Activity, dayIndex: number) {
    const card = e.currentTarget as HTMLElement;
    const rect = card.getBoundingClientRect();
    dragOffsetHours = ((e.clientY - rect.top) / rect.height) * (parseTime(activity.endTime) - parseTime(activity.startTime));
    // Métricas del clon flotante estilo demo: el bloque flotará anclado al
    // MISMO punto relativo donde se agarró (grabDX/DY) y con su tamaño real.
    grabDX = e.clientX - rect.left;
    grabDY = e.clientY - rect.top;
    grabW = rect.width;
    grabH = rect.height;
    // El motor arma: mouse por umbral (5px), táctil por long-press (260ms).
    engine.begin(e, { card, activityId: activity.id!, meta: { day: dayIndex } }, dragHooks);
  }

  /**
   * Vista previa del drop (igual que la vista Día): id → {start, end} en
   * horas, calculada en dragover SIN tocar la BD. Las actividades del día
   * destino se deslizan en vivo vía transition CSS hacia su posición
   * predicha. null = sin drag activo.
   */
  let dropPreview = $state<{ day: number; slots: Map<string, { start: number; end: number }> } | null>(null);
  /** Drop inválido: no cabe / pisaría — tarjeta roja y al soltar vuelve. */
  let dragInvalid = $state(false);
  /** Shake one-shot del clon flotante: solo en la transición válido→inválido;
   *  pegado a .invalido se reiniciaría en cada pointermove = zumbido. */
  let shakeInvalid = $state(false);
  let shakeTimer: ReturnType<typeof setTimeout> | null = null;
  function setInvalid(v: boolean) {
    if (v && !dragInvalid) {
      shakeInvalid = true;
      if (shakeTimer) clearTimeout(shakeTimer);
      shakeTimer = setTimeout(() => { shakeInvalid = false; }, 350);
    } else if (!v) {
      shakeInvalid = false;
      if (shakeTimer) { clearTimeout(shakeTimer); shakeTimer = null; }
    }
    dragInvalid = v;
  }
  /** Rótulo del gesto dentro del fantasma: qué hará el drop. */
  let dragHint = $state('');
  /** Posición del cursor para el fantasma flotante (null = sin drag). */
  let dragGhostXY = $state<{ x: number; y: number } | null>(null);
  /** Hora proyectada del fantasma: el slot final del arrastrado en el preview. */
  let dragGhostHora = $state('');
  /** Punto de agarre dentro del bloque (px) y tamaño real: el clon flotante
   *  se dibuja en el mismo punto relativo al cursor — cero salto al armar
   *  (patrón .bloque.flotante de la demo). Se capturan en pointerdown. */
  let grabDX = 0;
  let grabDY = 0;
  let grabW = 0;
  let grabH = 0;
  /** Actividad y color del fantasma flotante (clon visual del bloque). */
  const ghostActivity = $derived(activities.find(a => a.id === draggedActivityId) ?? null);
  const ghostColor = $derived(ghostActivity ? getActivityColor(ghostActivity.categoryId, categories) : '#2d3748');

  /**
   * Cascada completa para el commit: TODOS los días de la actividad (incluido
   * el destino si el drag cruza columnas). Devuelve la resolución COMPLETA:
   * si el movimiento choca en otro día (o algún día desborda) → valido=false
   * y NO se escribe nada (el bloque vuelve). Es la regla del usuario: mover
   * jamás empuja fuera del día del drop.
   */
  function computeFullCascade(
    actId: string,
    targetDay: number,
    anchorStart: number,
    resDestino?: { slots: { id: string; start: number; end: number }[] }
  ): WeeklyResolution {
    const activity = activities.find(a => a.id === actId);
    if (!activity) return { byDay: new Map(), times: new Map(), valido: false, motivo: '⛔ Actividad no encontrada' };
    const origDays = activity.daysOfWeek;
    const finalDays = dragSourceDay !== null && origDays.includes(dragSourceDay)
      ? [...origDays.filter(d => d !== dragSourceDay), targetDay]
      : [...origDays];
    // Con resDestino el día del drop se siembra EXACTO (lo que se vio);
    // los demás días se validan contra el slot anclado (sin empujar a nadie).
    return propagateWeekly(
      activities, actId, anchorStart, endHour, CODEC, [...new Set(finalDays)],
      undefined, 0, false,
      resDestino ? { day: targetDay, slots: resDestino.slots } : undefined
    );
  }



  // M6 (WCAG 2.5.7): mover sin puntero. ±15 min es un deseo EXACTO: la
  // actividad ancla como pared y empuja en cadena en TODOS sus días (el
  // teclado no tiene dedo ni mitades). Si algún día desborda → ⛔ y nada
  // se escribe.
  async function nudgeWeekly(activity: Activity, deltaH: number) {
    if (draggedActivityId !== null) return;
    const dur = parseTime(activity.endTime) - parseTime(activity.startTime);
    let newStart = Math.round((parseTime(activity.startTime) + deltaH) * 4) / 4;
    newStart = Math.max(startHour, Math.min(newStart, endHour - dur));
    const times = new Map<string, { start: number; end: number }>();
    let invalido = false;
    for (const d of activity.daysOfWeek) {
      const daySlots = activities
        .filter(a => a.daysOfWeek.includes(d))
        .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
      const res = resolveNudgeDay(daySlots, activity.id!, newStart, startHour, endHour);
      if (!res.valido) invalido = true;
      for (const s of res.slots) {
        times.set(s.id, { start: s.start, end: s.end });
      }
    }
    if (invalido) { toastErrRepetido(`teclado-sem:${activity.id}`, '⛔ No cabe: el empuje desbordaría el día'); return; }
    await commitWeeklyTimes(times, `${activity.name} → ${format12h(formatTime(newStart))}`);
  }

  /**
   * Punto de escritura de horarios globales (drop, teclado y resize lo
   * reusan): delega en commitCambios (transacción atómica + undo/redo de un
   * paso, fase 1 del plan v2) y muestra el toast con [Deshacer].
   */
  async function commitWeeklyTimes(
    times: Map<string, { start: number; end: number }>,
    label: string,
    daysChange?: { id: string; days: number[] }
  ): Promise<string | null> {
    const acts: Activity[] = [];
    for (const [id, slot] of times) {
      const before = activities.find(a => a.id === id);
      if (!before) continue;
      const t0 = formatTime(slot.start);
      const t1 = formatTime(slot.end);
      const days = daysChange?.id === id ? daysChange.days : before.daysOfWeek;
      // Comparación por CONTENIDO: no escribir filas no-op (churn de updatedAt → ruido en el sync LWW).
      if (t0 !== before.startTime || t1 !== before.endTime || days.join(',') !== before.daysOfWeek.join(',')) {
        acts.push({ ...cloneAct(before), startTime: t0, endTime: t1, daysOfWeek: days });
      }
    }
    if (acts.length === 0) return null;
    try {
      const { commitCambios } = await import('../lib/commit');
      // Sin toast de éxito (pedido del usuario): el movimiento confirmado no
      // avisa nada; los errores sí (toastErr). El paso queda en el stack de
      // undo por si se reviviera la acción.
      await commitCambios({ label, acts });
      return label;
    } catch {
      toastErr(tNow('toast.couldNotMove'));
      return null;
    }
  }

  function clearDragPreview() {
    // C2: corre al soltar, cancelar o con Esc. Sin el reset de ids, la
    // tarjeta queda con opacidad 0.55 y fuera del layout hasta el próximo drag.
    draggedActivityId = null;
    dragSourceDay = null;
    dropPreview = null;
    setInvalid(false);
    shakeInvalid = false;
    dragHint = '';
    dragGhostXY = null;
    dragGhostHora = '';
    firmaPreview = '';
    mitadActual.clear();
  }

  // ── Resize bidireccional (estirar arriba/abajo) en la grilla semanal ──
  // Mismo motor, gesto inmediato y sin fantasma. Semántica acordada: la
  // duración cambia en TODOS los días (global); keepPlace conserva el lado
  // fijo ('abajo' conserva inicio, 'arriba' conserva fin). Único gesto que
  // empuja en cadena — con candado: si un día desborda → ⛔ y nada se escribe.
  interface WeekResizeMeta {
    day: number;
    lado: 'arriba' | 'abajo';
    origStart: number;
    origEnd: number;
    startY: number;
  }

  const weekResizeHooks: DragHooks = {
    onActivate(t) {
      draggedActivityId = t.activityId; // excluye la tarjeta del clustering
    },
    onMove(t, _x, clientY) {
      const m = t.meta as WeekResizeMeta;
      const calc = computeWeekResize(clientY, t.activityId, m);
      if (calc) {
        setInvalid(!calc.valido);
        // F4: la capacidad global acotó el deseo → feedback del por qué.
        dragHint = calc.limitadoPor ? `↕ Limitado por ${calc.limitadoPor}` : '';
        dropPreview = { day: m.day, slots: calc.slots };
      }
    },
    async onDrop(t, _x, clientY) {
      const m = t.meta as WeekResizeMeta;
      const calc = computeWeekResize(clientY, t.activityId, m);
      draggedActivityId = null;
      dragSourceDay = null;
      setInvalid(false);
      shakeInvalid = false;
      dragHint = '';
      if (!calc) { dropPreview = null; return; }
      if (!calc.valido) { toastErrRepetido(`estirar-sem:${m.day}`, '⛔ No cabe: estirar desbordaría el día'); dropPreview = null; return; }
      // Commit global: el borde del PUNTERO manda. Con lado 'arriba' el fin
      // queda fijo (ancla = nuevo inicio) y la nueva duración viaja a todos
      // los días; el rechazo multi-día del candado protege el límite.
      const act = activities.find(a => a.id === t.activityId);
      const nuevaDur = m.lado === 'abajo'
        ? calc.newEnd! - m.origStart
        : m.origEnd - calc.newStart!;
      const ancla = m.lado === 'abajo' ? m.origStart : calc.newStart!;
      // Lado del estirar: 'arriba' ancla el FIN y lo pisado sube en cadena
      // (igual que el preview de resolveResizeDay) — antes el commit
      // re-derivaba con pared anclada al inicio y los vecinos traspasaban.
      const sem = propagateWeekly(activities, t.activityId, ancla, endHour, CODEC, act?.daysOfWeek ?? [], nuevaDur, 0, true, undefined, m.lado);
      if (!sem.valido) { toastErrRepetido(`estirar-sem:${m.day}`, sem.motivo); dropPreview = null; return; }
      await commitWeeklyTimes(sem.times, `Estirar ${act?.name ?? 'actividad'}`);
      dropPreview = null;
    },
    onCancel() {
      draggedActivityId = null;
      dragSourceDay = null;
      dropPreview = null;
      setInvalid(false);
      shakeInvalid = false;
    }
  };

  function startResize(e: PointerEvent, activity: Activity, dayIndex: number, lado: 'arriba' | 'abajo') {
    e.stopPropagation(); // no disparar long-press/click/drag del ítem
    e.preventDefault();
    engine.beginImmediate(
      e,
      { card: e.currentTarget as HTMLElement, activityId: activity.id!, meta: { day: dayIndex, lado, origStart: parseTime(activity.startTime), origEnd: parseTime(activity.endTime), startY: e.clientY } satisfies WeekResizeMeta },
      weekResizeHooks,
      { ghost: false }
    );
  }

  /**
   * Cálculo COMPARTIDO por preview y commit del resize (una sola matemática):
   * el borde del puntero (snap 15min, clamp) y el mapa resuelto. 'abajo'
   * conserva el inicio (cascada empuja hacia abajo); 'arriba' conserva el fin
   * (cascada empuja hacia arriba). Nunca reacomoda la tarjeta que se estira.
   */
  function computeWeekResize(
    clientY: number,
    actId: string,
    m: WeekResizeMeta
  ): { lado: 'arriba' | 'abajo'; newEnd?: number; newStart?: number; valido: boolean; limitadoPor?: string; slots: Map<string, { start: number; end: number }> } | null {
    const col = document.querySelectorAll('.day-column .slots-grid')[m.day];
    if (!col) return null;
    const deltaSlots = (clientY - m.startY) / slotHeightPx;
    const daySlots = activities
      .filter(a => a.daysOfWeek.includes(m.day))
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    if (m.lado === 'abajo') {
      let newEnd = Math.round((m.origEnd + deltaSlots / slotsPerHour) * 4) / 4;
      // Regla del usuario: estirar SIEMPRE topa, nunca se rechaza. El deseo
      // del puntero se acota por la capacidad GLOBAL (mínima entre los días
      // de la actividad): la duración viaja a todos sus días, así el commit
      // jamás desborda → sin candado ni ⛔ (el encoger no se acota).
      if (newEnd > m.origEnd) {
        const capMin = capacidadResizeWeekly(activities, actId, 'abajo', CODEC, startHour, endHour);
        newEnd = Math.min(newEnd, m.origEnd + capMin / 60);
      }
      newEnd = Math.max(m.origStart + 0.25, Math.min(newEnd, endHour));
      const res = resolveResizeDay(daySlots, actId, 'abajo', newEnd, startHour, endHour);
      return { lado: m.lado, newEnd, valido: res.valido, limitadoPor: res.limitadoPor, slots: new Map(res.slots.map(s => [s.id, { start: s.start, end: s.end }])) };
    }
    let newStart = Math.round((m.origStart + deltaSlots / slotsPerHour) * 4) / 4;
    // Espejo hacia arriba: acotar por la capacidad global antes de resolver.
    if (newStart < m.origStart) {
      const capMin = capacidadResizeWeekly(activities, actId, 'arriba', CODEC, startHour, endHour);
      newStart = Math.max(newStart, m.origStart - capMin / 60);
    }
    newStart = Math.max(startHour, Math.min(newStart, m.origEnd - 0.25));
    const res = resolveResizeDay(daySlots, actId, 'arriba', newStart, startHour, endHour);
    return { lado: m.lado, newStart, valido: res.valido, limitadoPor: res.limitadoPor, slots: new Map(res.slots.map(s => [s.id, { start: s.start, end: s.end }])) };
  }

  // Context Menu logic
  let contextMenu = $state({ show: false, x: 0, y: 0, activityId: null as string | null });

  // Lightbox para ver la imagen de la rutina
  let viewingImageActivity = $state<Activity | null>(null);

  const activityHasImage = $derived(
    contextMenu.activityId !== null &&
    !!activities.find(a => a.id === contextMenu.activityId)?.image
  );

  function handleContextMenu(e: MouseEvent, activityId: string) {
    e.preventDefault();
    openContextMenu(activityId, e.clientX, e.clientY);
  }

  function closeContextMenu() {
    contextMenu.show = false;
  }

  async function duplicateActivity() {
    const sourceId = contextMenu.activityId;
    closeContextMenu();
    if (!sourceId) return;

    const source = activities.find(a => a.id === sourceId);
    if (!source) return;

    // Duplicar en los mismos días de la semana que la original
    const days = source.daysOfWeek?.length ? source.daysOfWeek : [0];
    const clone = await duplicateActivityOp(sourceId, {
      startHour,
      endHour,
      days
    });

    if (clone) {
      toastOk(tNow('toast.duplicated', { name: clone.name, time: format12h(clone.startTime) }));
    } else {
      toastErr(tNow('toast.noGap'));
    }
  }

  let confirmDelete = $state(false);

  function askDeleteActivity() {
    if (contextMenu.activityId) confirmDelete = true;
    closeContextMenu();
  }

  async function deleteActivity() {
    const id = contextMenu.activityId;
    if (!id) return;
    try {
      await db.activities.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
      // Propagar el borrado a las ediciones temporales (dayOverrides) que la copiaron
      const overrides = await db.dayOverrides.toArray();
      const dirty = overrides
        .filter(o => o.activities?.some(a => a.id === id))
        .map(o => ({ ...o, activities: o.activities.filter(a => a.id !== id) }));
      if (dirty.length > 0) await db.dayOverrides.bulkPut(dirty);
      toastOk(tNow('toast.deleted'));
    } catch (err: any) {
      console.error(err);
    }
  }
</script>

<svelte:window onclick={closeContextMenu} onscroll={closeContextMenu} />

<div class="weekly-grid-container" style="--total-slots: {totalSlots}; --slot-height: {slotHeightPx}px">
  <div class="scroll-hint" aria-hidden="true">{$t('week.scrollHint')}</div>
  <div class="grid-scroll">
  <div class="time-column">
    <div class="header-spacer"></div>
    {#each hours as hour}
      <div class="hour-label" style="grid-row: {getRowPosition(hour + ':00') + 1}">
        <span class="hour-text">{hour % 12 || 12}:00</span>
        <span class="hour-ampm">{hour < 12 || hour === 24 ? 'AM' : 'PM'}</span>
      </div>
      {#if hour < endHour}
        <div class="half-hour-label" style="grid-row: {getRowPosition(hour + ':30') + 1}">
          <span class="half-text">{hour % 12 || 12}:30</span>
        </div>
      {/if}
    {/each}
  </div>

  <div class="days-columns">
    {#each days as day, i}
      {@const dayData = getDayActivitiesWithLayout(i, dropPreview?.day === i ? dropPreview.slots : undefined, draggedActivityId !== null && (dragSourceDay === i || dropPreview?.day === i) ? draggedActivityId : null)}
      <div class="day-column" class:col-dragging={draggedActivityId !== null}>
        <!-- Nombre completo SIEMPRE accesible: en columna angosta el header muestra
             la abreviatura (Mié/Sáb) y el title lleva el nombre entero. Sin
             nombres cortados a medias jamás. -->
        <button class="day-header" onclick={() => onSelectDay(i)} aria-label={$t('week.viewDay', { day })} title="{day}">
          <span class="day-name">
            <span class="day-name-completo">{day}</span>
            <span class="day-name-corto" aria-hidden="true">{day.slice(0, 3)}</span>
          </span>
          {#if dayOverrides.some(o => o.day === i && o.activities?.length >= 0)}
            <span class="day-temp-badge" title={$t('week.tempBadge')}>⚡</span>
          {/if}
        </button>
        <div
          class="slots-grid"
        >
          {#each dayData.items as activity (activity.id)}
            {@const numSlots = activity.numSlots}
            <button 
              class="activity-item" 
              class:short={numSlots <= 1}
              class:drag-ghost={draggedActivityId === activity.id}
              class:drop-invalid={draggedActivityId === activity.id && dragInvalid}
              onpointerdown={(e) => handleItemPointerDown(e, activity, i)}
              oncontextmenu={(e) => handleContextMenu(e, activity.id!)}
              style="top: {activity.top}; height: {activity.height}; left: {activity.left}; width: {activity.width}; --bg-color: {getActivityColor(activity.categoryId, categories)}"
              onclick={() => onEditActivity(activity.id!)}
              onkeydown={(e) => {
                // M6 (WCAG 2.5.7): ↑/↓ = ±15 min con cascada global. Enter y
                // Espacio ya abren edición (comportamiento nativo de <button>).
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  nudgeWeekly(activity, e.key === 'ArrowUp' ? -0.25 : 0.25);
                }
              }}
              aria-label="{activity.name}, {format12h(activity.startTime)} — {format12h(activity.endTime)}{activity.steps?.length ? `, ${activity.steps.length}` : ''}. {$t('dayView.keyboardHint')}"
            >
              <div class="activity-title">
                <span>{activity.name}</span>
                {#if activity.image}
                  <span
                    class="grid-steps-icon grid-image-icon"
                    role="button"
                    tabindex="0"
                    title={$t('menu.viewImage')}
                    onclick={(e) => { e.stopPropagation(); viewingImageActivity = activity; }}
                    onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); viewingImageActivity = activity; } }}
                  >
                    <ImageIcon size={10} />
                  </span>
                {/if}
                {#if activity.steps && activity.steps.length > 0}
                  <span class="grid-steps-icon">
                    <ListChecks size={10} />
                  </span>
                {/if}
              </div>
                <div
                  class="resize-handle top"
                  aria-hidden="true"
                  onpointerdown={(e) => startResize(e, activity, i, 'arriba')}
                ></div>
                <div
                  class="resize-handle"
                  aria-hidden="true"
                  onpointerdown={(e) => startResize(e, activity, i, 'abajo')}
                ></div>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
  </div>

  {#if draggedActivityId !== null && dragGhostXY && ghostActivity}
    <!-- Fantasma flotante estilo demo: clon del BLOQUE COMPLETO (tamaño real,
         color de categoría) anclado al punto de agarre, con la hora proyectada
         y la acción del drop (fixed = no le afectan overflow ni scroll). -->
    <div class="drag-float" use:portal class:invalido={dragInvalid} class:shake={shakeInvalid} aria-hidden="true"
      onanimationend={(e) => { if (e.animationName === 'shake') shakeInvalid = false; }}
      style="left: {dragGhostXY.x - grabDX}px; top: {dragGhostXY.y - grabDY}px; width: {grabW}px; height: {grabH}px; --bg-color: {ghostColor}">
      <div class="df-title"><span>{ghostActivity.name}</span></div>
      <span class="df-hora">{dragGhostHora}</span>
    </div>
  {/if}

  {#if contextMenu.show}
    <!-- Portal a body: backdrop-filter de .glass-panel ancestro crea containing block y rompe el position:fixed -->
    <div class="custom-context-menu glass-panel" use:portal style="top: {contextMenu.y}px; left: {contextMenu.x}px">
      <button onclick={duplicateActivity} aria-label={$t('menu.duplicate')}>
        <Copy size={16} /> {$t('menu.duplicate')}
      </button>
      {#if viewingImageActivity === null && activityHasImage}
        <button onclick={() => { viewingImageActivity = activities.find(a => a.id === contextMenu.activityId) || null; }}>
          <ImageIcon size={16} /> {$t('menu.viewImage')}
        </button>
      {/if}
      <button class="delete-btn" onclick={askDeleteActivity}>
        <Trash2 size={16} /> {$t('menu.delete')}
      </button>
    </div>
  {/if}

  <ConfirmDialog
    bind:open={confirmDelete}
    title="Eliminar actividad"
    message="La actividad se eliminará de toda la semana (y de las ediciones temporales). Esta acción no se puede deshacer."
    confirmText="Eliminar"
    danger
    onconfirm={deleteActivity}
  />

  {#if viewingImageActivity}
    <ImageLightbox activity={viewingImageActivity} onClose={() => viewingImageActivity = null} />
  {/if}
</div>

<style>
  .weekly-grid-container {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    max-width: 100%;
    padding-bottom: 1rem;
    padding-top: 10px;
    position: relative;
    scrollbar-width: thin;
    /* Contenedor de consulta (CQ): los breakpoints de la grilla reaccionan al
       ANCHO REAL DEL CONTENEDOR y no al viewport. Ventaja práctica: si mañana
       la grilla vive en un panel lateral o en pantalla dividida, su layout se
       adapta solo — sin tocar una sola regla. inline-size = solo el eje
       horizontal participa (el alto no crea contención, no rompe el track). */
    container: weekly-grid / inline-size;
  }

  /* El scroll es del CONTENIDO (no del contenedor): así la columna de horas
     puede quedar pegajosa y los días no arrastran la página entera.
     Piso total: columna de horas (68px) + 7 días al mínimo legible (88px).
     Bajo ese ancho el scroll horizontal toma el relevo sin aplastar días. */
  .grid-scroll {
    display: flex;
    /* Llena el ancho disponible (flex:1) PERO sin bajar del piso. El piso
       total es escalonado como las columnas (68px horas + 7×piso + gaps):
       88px/día en desktop, 66px en ≤768px, 56px en ≤480px — así en un móvil
       de 320px caben 4 días sin scroll (antes: 2 días y scroll eterno). */
    flex: 1;
    min-width: calc(68px + 7 * 88px + 6px);
  }
  @container weekly-grid (width < 768px) {
    .grid-scroll {
      min-width: calc(48px + 7 * 66px + 6px);
    }
  }
  @container weekly-grid (width < 480px) {
    .grid-scroll {
      min-width: calc(48px + 7 * 56px + 6px);
    }
  }

  .time-column {
    display: grid;
    grid-template-rows: 40px repeat(var(--total-slots), var(--slot-height));
    width: 68px;
    padding-right: 0.5rem;
    border-right: 1px solid rgba(0,0,0,0.08);
    user-select: none;
    flex-shrink: 0;
    /* Pegajosa al deslizar hacia los lados: las horas siempre visibles. */
    position: sticky;
    left: 0;
    z-index: 20;
    background: rgba(255, 255, 255, 0.82);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  /* En contenedor angosto la columna de horas se compacta igual que los días
     (misma escala que los breakpoints del piso de columnas). */
  @container weekly-grid (width < 768px) {
    .time-column {
      width: 56px;
    }
  }
  @container weekly-grid (width < 480px) {
    .time-column {
      width: 48px;
    }
  }

  .header-spacer {
    height: 40px;
  }

  .hour-label {
    font-size: 0.72rem;
    font-weight: 700;
    color: #4a5568;
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: 2px;
    transform: translateY(-50%);
    white-space: nowrap;
    padding-right: 4px;
  }

  .hour-text {
    color: #2d3748;
  }

  .hour-ampm {
    font-size: 0.6rem;
    font-weight: 600;
    color: #718096;
  }

  .half-hour-label {
    font-size: 0.64rem;
    font-weight: 500;
    color: #a0aec0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    transform: translateY(-50%);
    white-space: nowrap;
    opacity: 0.85;
    padding-right: 4px;
  }

  .days-columns {
    flex: 1;
    display: grid;
    /* Ajuste dinámico con piso y tope (pedido del usuario): reparte el ancho
       sin aplastar los días ni dejarlos gigantes.
       % y NO fr dentro de clamp (fr invalida la declaración entera):
       14.2857% = 1/7 del contenedor, menos 1px por el gap entre columnas
       (6 gaps consumen 6px que el % puro ignora — sin el descuento, la suma
       de columnas excede el contenedor en 6px y aparece micro-scroll).
       Piso ESCALONADO (cobertura general móvil): el 88px fijo era una pared
       en 320/425px (2 días en pantalla y scroll eterno). En móvil angosto el
       piso baja: 66px en ≤768px, 56px en ≤480px — el día SIEMPRE cabe en su
       mínimo y el scroll solo aparece cuando no caben los 7 días. */
    grid-template-columns: repeat(7, clamp(88px, calc(14.2857% - 1px), 220px));
    gap: 1px;
    background: rgba(0,0,0,0.06);
  }
  @container weekly-grid (width < 768px) {
    .days-columns {
      grid-template-columns: repeat(7, clamp(66px, calc(14.2857% - 1px), 220px));
    }
  }
  @container weekly-grid (width < 480px) {
    .days-columns {
      grid-template-columns: repeat(7, clamp(56px, calc(14.2857% - 1px), 220px));
    }
  }

  .day-column {
    display: flex;
    flex-direction: column;
    background: white;
    min-width: 0;
    overflow: hidden;
  }

  .day-header {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--color-brown-bark, #4a3728);
    border-bottom: 1px solid rgba(0,0,0,0.08);
    background: white;
    border: none;
    cursor: pointer;
    transition: background 0.2s;
    overflow: hidden; /* el nombre largo nunca desborda la columna */
    box-sizing: border-box;
  }

  /* Nombre completo SIEMPRE legible (nada cortado a medias):
     .day-name-completo manda mientras el ancho de columna lo permite; debajo
     de ~76px de columna, la abreviatura de 3 letras toma el relevo y el
     nombre entero queda en title del botón. El flip es por contenedor,
     no por viewport: igual que los pisos de columnas. */
  .day-name {
    display: inline-flex;
    max-width: 100%;
    overflow: hidden;
  }
  .day-name-corto {
    display: none;
  }
  @container weekly-grid (width < 590px) {
    /* 7 columnas: <590px de grilla = columnas de <~76px → 'Miércoles' (10
       caracteres a 0.85rem ≈ 71px) no cabe completo → abreviatura. */
    .day-name-completo {
      display: none;
    }
    .day-name-corto {
      display: inline;
    }
  }

  .day-header:hover {
    background: rgba(92, 64, 51, 0.05);
  }

  .day-temp-badge {
    font-size: 0.68rem;
    margin-left: 0.25rem;
    color: #b45309;
    background: #fef3c7;
    border: 1px solid #fde68a;
    border-radius: 6px;
    padding: 0 3px;
    line-height: 1.2;
    display: inline-flex;
    align-items: center;
  }

  .slots-grid {
    flex: 1;
    position: relative;
    overflow: hidden;
    /* La altura la fija la grilla de fondo vía --total-slots; los hijos son
       absolutos (top/height en %) para poder animar la cascada. */
    /* Repeating guide lines: :00 solid line, :30 subtle line, :15 and :45 faint lines */
    background-size: 100% calc(var(--slot-height) * 4);
    background-image: linear-gradient(
      to bottom,
      rgba(0, 0, 0, 0.09) 0px,
      rgba(0, 0, 0, 0.09) 1px,
      transparent 1px,
      transparent calc(var(--slot-height) - 1px),
      rgba(0, 0, 0, 0.02) calc(var(--slot-height) - 1px),
      rgba(0, 0, 0, 0.02) var(--slot-height),
      transparent var(--slot-height),
      transparent calc(var(--slot-height) * 2 - 1px),
      rgba(0, 0, 0, 0.05) calc(var(--slot-height) * 2 - 1px),
      rgba(0, 0, 0, 0.05) calc(var(--slot-height) * 2),
      transparent calc(var(--slot-height) * 2),
      transparent calc(var(--slot-height) * 3 - 1px),
      rgba(0, 0, 0, 0.02) calc(var(--slot-height) * 3 - 1px),
      rgba(0, 0, 0, 0.02) calc(var(--slot-height) * 3),
      transparent calc(var(--slot-height) * 3)
    );
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  }

  .slots-grid::before {
    content: '';
    display: block;
    height: calc(var(--total-slots) * var(--slot-height));
  }

  .activity-item {
    position: absolute;
    background: var(--bg-color);
    color: white;
    margin: 1px;
    border-radius: 4px;
    padding: 2px 5px;
    text-align: left;
    border: none;
    cursor: grab;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    overflow: hidden;
    opacity: 0.93;
    /* Cascada animada (igual que la vista Día): top/height transicionan. */
    transition: top 0.18s cubic-bezier(0.2, 0, 0, 1), height 0.18s cubic-bezier(0.2, 0, 0, 1), transform 0.15s, box-shadow 0.15s, opacity 0.15s;
    min-width: 0;
    min-height: 24px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    box-sizing: border-box;
    -webkit-user-select: none;
    user-select: none; /* arrastrar >5px no selecciona el texto de la grilla */
  }  /* Tarjeta ORIGINAL durante el drag: atenuada, sin más (el bloque real
     vuela bajo el cursor como clon). Sin transición: con top/transform
     animados la tarjeta perseguía al cursor con retardo (drag entrecortado
     y "dirección invertida" percibida). */
  .activity-item.drag-ghost {
    opacity: 0.45;
    transition: none;
    /* Parpadeo de z-index (fix): la tarjeta original vive bajo el cursor y
       el :hover le dispara sin parar (con el shake del clon, alterna
       hover/no-hover = salto frenético de índices z con el vecino pisado).
       z-index fijo alto durante TODO el gesto. */
    z-index: 100;
  }
  .col-dragging .activity-item.drag-ghost:hover,
  .col-dragging .activity-item.drag-ghost:focus-visible {
    z-index: 100;
    transform: none;
    outline: none;
  }

  /* En pleno drag los vecinos no compiten: sin hover (scale/outline/z-index)
     ni focus ring — el plano superior es SOLO del arrastrado. */
  .col-dragging .activity-item:hover,
  .col-dragging .activity-item:focus-visible {
    transform: none;
    outline: none;
    z-index: auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  }

  /* Drop inválido: no cabe — rojo y al soltar el bloque vuelve. */
  .activity-item.drop-invalid {
    background: #e0453a !important;
    color: #fff !important;
  }

  /* Accesibilidad: sin deslizamientos para quien pide menos movimiento. */
  @media (prefers-reduced-motion: reduce) {
    .activity-item,
    .activity-item.drag-ghost,
    .drag-float,
    .drag-float.shake {
      transition: none !important;
      animation: none !important;
    }
  }

  /* ── Resize bidireccional: asa superior (espejo de la inferior) ── */
  .resize-handle.top {
    top: 0;
    bottom: auto;
  }
  .resize-handle.top::after {
    bottom: auto;
    top: 2px;
  }

  /* ── Fantasma flotante estilo demo: BLOQUE COMPLETO (fixed, clon del
     arrastrado con su tamaño real y color de categoría) ── */
  .drag-float {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--bg-color, #2d3748);
    color: #fff;
    overflow: hidden;
    box-sizing: border-box;
    /* Sombra del bloque flotante de la demo: capa de contacto + caída suave
       y profunda, con la rotación característica del arrastre. will-change
       promueve el clon a su propia capa: el scroll no re-rasteriza la sombra
       (se "perdía" al scrollear con el bloque agarrado). */
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18), 0 12px 28px rgba(0, 0, 0, 0.32);
    transform: rotate(-1.5deg);
    will-change: transform, box-shadow;
    transition: background 0.15s, box-shadow 0.15s;
  }
  /* Shake ONE-SHOT: la clase .shake solo se enciende en la transición
     válido→inválido (setInvalid del script) y se limpia en animationend —
     pegarla a .invalido (re-aplicada en cada pointermove cerca del límite)
     reinicia la animación en cada movimiento = zumbido frenético. */
  .drag-float.invalido {
    background: #e0453a !important;
    box-shadow: 0 0 0 3px rgba(224, 69, 58, 0.4), 0 12px 28px rgba(0, 0, 0, 0.35);
  }
  .drag-float.shake {
    animation: shake 0.3s ease;
  }
  .drag-float .df-title {
    font-weight: 700;
    font-size: 0.78rem;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .drag-float .df-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-clamp: 2;
    white-space: normal;
    word-break: break-word;
  }
  .drag-float .df-hora {
    font-size: 0.62rem;
    font-weight: 700;
    opacity: 0.92;
  }
  @keyframes shake {
    0%, 100% { margin-left: 0; }
    25% { margin-left: -3px; }
    75% { margin-left: 3px; }
  }

  /* Inhibir el hover en pleno drag: sin scale/translate ni re-layout
     (causa de ticks y sacudidas al agarrar). */
  .activity-item:active.drag-ghost {
    transform: scale(0.98);
  }
  .activity-item:hover,
  .activity-item:focus-visible {
    opacity: 1;
    z-index: 5;
    box-shadow: 0 3px 10px rgba(0,0,0,0.25);
    outline: 3px solid var(--color-green-dark, #2d5a3d);
    outline-offset: 2px;
  }

  .activity-item:active {
    cursor: grabbing;
  }

  /* Handle de redimensionado (estirar borde inferior) */
  /* Zona PROPORCIONAL (30%, piso 9px, tope 22px): tarjetas cortas de 15-30
     min conservan superficie suficiente para agarrar y mover. */
  .resize-handle {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 30%;
    min-height: 9px;
    max-height: 22px;
    cursor: ns-resize;
    touch-action: none;
  }
  .resize-handle::after {
    content: '';
    position: absolute;
    left: 20%;
    right: 20%;
    bottom: 2px;
    height: 3px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.5);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .activity-item:hover .resize-handle::after,
  .activity-item:focus-visible .resize-handle::after {
    opacity: 1;
  }

  .activity-item:hover {
    opacity: 1;
    z-index: 30;
    transform: scale(1.02);
    box-shadow: 0 4px 12px rgba(0,0,0,0.22);
  }

  .slots-grid:hover {
    background-color: rgba(0,0,0,0.01);
  }

  .activity-title {
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    line-height: 1.25;
  }

  .activity-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-clamp: 2;
    white-space: normal;
    word-break: break-word;
    min-width: 0;
  }

  /* Bloques de 15 min (1 slot): una sola línea con ellipsis — 2 líneas
     no caben en la altura del bloque y el texto se recorta. */
  .activity-item.short .activity-title {
    font-size: 0.68rem;
  }
  .activity-item.short .activity-title span {
    -webkit-line-clamp: 1;
    line-clamp: 1;
    white-space: nowrap;
    display: block;
  }
  /* Con las columnas compactas de móvil (piso 56px) el título normal baja
     un punto: "Miércoles" completo entra en 56px sin recortes agresivos. */
  @container weekly-grid (width < 480px) {
    .activity-title {
      font-size: 0.7rem;
    }
    .activity-item.short .activity-title {
      font-size: 0.62rem;
    }
  }

  /* Hint de scroll horizontal solo cuando el contenedor es angosto */
  .scroll-hint {
    display: none;
  }
  @container weekly-grid (width < 768px) {
    .scroll-hint {
      display: block;
      font-size: 0.75rem;
      color: #6b7a6e;
      padding: 2px 4px 6px;
      text-align: center;
      animation: hint-fade 5s ease forwards;
    }
  }
  @keyframes hint-fade {
    0%, 70% { opacity: 1; }
    100% { opacity: 0.35; }
  }

  .grid-steps-icon {
    display: inline-flex;
    align-items: center;
    background: rgba(255, 255, 255, 0.3);
    padding: 1px 3px;
    border-radius: 4px;
    font-size: 0.65rem;
    flex-shrink: 0;
  }

  .grid-image-icon {
    cursor: pointer;
    transition: all 0.15s;
  }

  .grid-image-icon:hover {
    background: rgba(255, 255, 255, 0.5);
    transform: scale(1.1);
  }

  .custom-context-menu {
    position: fixed;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
    min-width: 200px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.15);
    border: 1px solid rgba(0,0,0,0.05);
  }

  .custom-context-menu button {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    min-height: 44px; /* regla dura #5: medido 39px antes */
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-brown-bark);
    border-radius: 8px;
    transition: all 0.2s;
    text-align: left;
  }

  .custom-context-menu button:hover {
    background: rgba(92, 64, 51, 0.05);
    color: var(--color-green-dark);
  }

  .custom-context-menu button.delete-btn {
    color: #e53e3e;
    border-top: 1px solid rgba(0,0,0,0.05);
    margin-top: 0.25rem;
    padding-top: 0.75rem;
    border-radius: 0 0 8px 8px;
  }

  .custom-context-menu button.delete-btn:hover {
    background: #fff5f5;
  }

  /* Desktop grande / ultrawide (≥1536px): la cabecera de día gana aire y la
     tipografía de bloques sube medio punto — en 21:9 la grilla es el elemento
     dominante y merece la legibilidad extra. AL FINAL del bloque: misma
     especificidad que las reglas base, gana por orden de cascade. */
  @media (min-width: 1536px) {
    .header-spacer {
      height: 48px;
    }
    .day-header {
      height: 52px;
      font-size: 0.95rem;
    }
    .activity-title {
      font-size: 0.88rem;
    }
    .activity-item.short .activity-title {
      font-size: 0.76rem;
    }
    .hour-label {
      font-size: 0.78rem;
    }
  }
</style>

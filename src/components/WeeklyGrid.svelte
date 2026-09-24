<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Activity, Category, DayOverride } from '../lib/types';
  import { parseTime, getActivityColor, formatTime, format12h } from '../lib/stores';
  import { propagateWeekly } from '../lib/cascade';
  import { db } from '../lib/db';
  import { duplicateActivity as duplicateActivityOp } from '../lib/activityOps';
  import { Copy, Trash2, ListChecks, ImageIcon } from '@lucide/svelte';
  import ImageLightbox from './ImageLightbox.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr } from '../lib/toast';
  import { pushUndo, cloneAct } from '../lib/undo';
  import { portal } from '../lib/portal';
  import { createDragEngine, type DragHooks, type DragTarget } from '../lib/dragEngine';

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
  // compartida con la vista Día). El quiet-hold táctil de 550ms (G6: iOS no
  // dispara contextmenu) abre el menú: dedo quieto = menú, mover = drag.
  // (La supresión del click sintético post-drag vive en el motor.)

  function openContextMenu(activityId: string, x: number, y: number) {
    // Clamp para que el menú no se salga de la ventana
    // (MENU_H: 2-3 items × 44px + padding — con 130 el menú quedaba fuera en landscape)
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
    scrollContainer: () => document.querySelector('.weekly-grid-container'),
    quietHold: {
      ms: 550,
      onQuiet: (t, x, y) => openContextMenu(t.activityId, x, y)
    }
  });

  onDestroy(() => engine.destroy());

  const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const startHour = $derived(settings.startHour);
  const endHour = $derived(settings.endHour);
  const totalHours = $derived(endHour - startHour);
  
  // 15-minute precision (4 slots per hour)
  const slotsPerHour = 4;
  const slotHeightPx = 26; // ≥26px/slot: bloques de 15min tocables (~44px los de 30min, 104px los de 1h)
  const totalSlots = $derived(totalHours * slotsPerHour);

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
  let lastPreviewKey = -1;

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
    },
    onMove(_t, x, y) {
      if (draggedActivityId === null) return;
      const activity = activities.find(a => a.id === draggedActivityId);
      if (!activity) return;
      const target = dropTargetAt(x, y);
      if (!target) return;
      const start = slotStartAt(target.grid, y, parseTime(activity.endTime) - parseTime(activity.startTime));
      const key = target.day * 400 + start * 4; // recalcula solo al cambiar de slot
      if (key === lastPreviewKey) return;
      lastPreviewKey = key;
      dropPreview = { day: target.day, slots: (propagateWeekly(activities, draggedActivityId, start, endHour, CODEC, [target.day]).byDay.get(target.day) ?? new Map()) };
    },
    async onDrop(t, x, y) {
      const sourceDay = (t.meta as { day: number }).day;
      const activity = activities.find(a => a.id === t.activityId);
      if (!activity) { clearDragPreview(); return; }
      const target = dropTargetAt(x, y);
      const day = target?.day ?? sourceDay;
      const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
      // Ancla = la MISMA matemática del preview: lo que se vio es lo que se guarda.
      const newStart = target ? slotStartAt(target.grid, y, duration) : startHour;
      dragSourceDay = sourceDay; // computeFullCascade la usa para el canje de días
      const cascada = computeFullCascade(t.activityId, day, newStart);
      let newDays = [...activity.daysOfWeek];
      const idx = newDays.indexOf(sourceDay);
      if (idx !== -1) {
        newDays[idx] = day;
      } else if (!newDays.includes(day)) {
        newDays.push(day);
      }
      newDays = [...new Set(newDays)].sort((a, b) => a - b);
      // M1: una sola transacción — un fallo a mitad no deja escrituras parciales.
      await commitWeeklyTimes(cascada, `Mover ${activity.name} a ${days[day]}`, { id: t.activityId, days: newDays });
      clearDragPreview();
    },
    onCancel() {
      // C2: soltar fuera de la grilla, Esc o cancel — sin reset la tarjeta
      // queda con opacidad y fuera del layout hasta el próximo arrastre.
      clearDragPreview();
    }
  };

  function handleItemPointerDown(e: PointerEvent, activity: Activity, dayIndex: number) {
    const card = e.currentTarget as HTMLElement;
    const rect = card.getBoundingClientRect();
    dragOffsetHours = ((e.clientY - rect.top) / rect.height) * (parseTime(activity.endTime) - parseTime(activity.startTime));
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

  /**
   * Preview del drop en un día: usa la cascada multi-día (src/lib/cascade.ts).
   * Lo que se ve es lo que se guarda — el preview de la columna destino es
   * exactamente el mapa que persistirá dragHooks.onDrop. (inline en onMove)
   */
  /**
   * Cascada completa para el commit: TODOS los días de la actividad (incluido
   * el destino si el drag cruza columnas). La arrastrada queda ANCLADA al slot
   * que el usuario vio (pin) y la propagación corre hasta estabilizar, para
   * que ningún día herede solapes no resueltos — la causa de la corrupción.
   * Devuelve los horarios GLOBALES finales (una fila = un horario).
   */
  function computeFullCascade(actId: string, targetDay: number, anchorStart: number): Map<string, { start: number; end: number }> {
    const activity = activities.find(a => a.id === actId);
    if (!activity) return new Map();
    const origDays = activity.daysOfWeek;
    const finalDays = dragSourceDay !== null && origDays.includes(dragSourceDay)
      ? [...origDays.filter(d => d !== dragSourceDay), targetDay]
      : [...origDays];
    return propagateWeekly(activities, actId, anchorStart, endHour, CODEC, [...new Set(finalDays)]).times;
  }



  // M6 (WCAG 2.5.7): mover sin puntero. Reusa la cascada del drop: la
  // actividad ancla en ±15 min y las vecinas se resuelven en TODOS sus días.
  // Misma transacción y reset de estado que dragHooks.onDrop.
  async function nudgeWeekly(activity: Activity, deltaH: number) {
    if (draggedActivityId !== null) return;
    const dur = parseTime(activity.endTime) - parseTime(activity.startTime);
    let newStart = Math.round((parseTime(activity.startTime) + deltaH) * 4) / 4;
    newStart = Math.max(startHour, Math.min(newStart, endHour - dur));
    const cascada = propagateWeekly(
      activities, activity.id!, newStart, endHour,
      CODEC, [...activity.daysOfWeek]
    ).times;
    await commitWeeklyTimes(cascada, `${activity.name} → ${format12h(formatTime(newStart))}`);
  }

  /**
   * Único punto de escritura de horarios globales (drop, teclado y resize lo
   * reusan): escribe en transacción las filas cuyo slot cambió y registra el
   * undo (los snapshots "antes" se toman de la store, que aún es el estado
   * previo). Devuelve el label del undo o null si nada cambió.
   */
  async function commitWeeklyTimes(
    times: Map<string, { start: number; end: number }>,
    label: string,
    daysChange?: { id: string; days: number[] }
  ): Promise<string | null> {
    const stamp = Date.now();
    const updates: Promise<unknown>[] = [];
    const rows: { before: Activity; after: Activity }[] = [];
    for (const [id, slot] of times) {
      const before = activities.find(a => a.id === id);
      if (!before) continue;
      const t0 = formatTime(slot.start);
      const t1 = formatTime(slot.end);
      const days = daysChange?.id === id ? daysChange.days : before.daysOfWeek;
      // Comparación por CONTENIDO (no por referencia): un daysChange con días
      // idénticos no debe escribir una fila no-op (churn de updatedAt → ruido
      // en el sync LWW).
      const daysChanged = days.join(',') !== before.daysOfWeek.join(',');
      if (t0 !== before.startTime || t1 !== before.endTime || daysChanged) {
        rows.push({
          before: cloneAct(before),
          after: { ...cloneAct(before), startTime: t0, endTime: t1, daysOfWeek: days, updatedAt: stamp }
        });
        updates.push(db.activities.put(rows[rows.length - 1].after));
      }
    }
    if (updates.length === 0) return null;
    try {
      await db.transaction('rw', db.activities, async () => {
        await Promise.all(updates);
      });
      pushUndo({ label, rows });
      return label;
    } catch {
      toastErr('No se pudo mover');
      return null;
    }
  }

  function clearDragPreview() {
    // C2: corre al soltar, cancelar o con Esc. Sin el reset de ids, la
    // tarjeta queda con opacidad 0.55 y fuera del layout hasta el próximo drag.
    draggedActivityId = null;
    dragSourceDay = null;
    dropPreview = null;
    lastPreviewKey = -1;
  }

  // ── Resize (estirar borde inferior) en la grilla semanal ─────────────
  // Mismo motor, gesto inmediato y sin fantasma. Semántica acordada: la
  // duración cambia en TODOS los días (global); keepPlace conserva el inicio.
  interface WeekResizeMeta {
    day: number;
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
      if (calc) dropPreview = { day: m.day, slots: calc.slots };
    },
    async onDrop(t, _x, clientY) {
      const m = t.meta as WeekResizeMeta;
      const calc = computeWeekResize(clientY, t.activityId, m);
      draggedActivityId = null;
      dragSourceDay = null;
      if (!calc) { dropPreview = null; return; }
      // Commit global: la duración viene del PUNTERO (newEnd), no del mapa
      // resuelto — el reacomodo de cascada no debe redefinir el estirado.
      const act = activities.find(a => a.id === t.activityId);
      const times = propagateWeekly(activities, t.activityId, m.origStart, endHour, CODEC, act?.daysOfWeek ?? [], calc.newEnd - m.origStart, 0, true).times;
      await commitWeeklyTimes(times, `Estirar ${act?.name ?? 'actividad'}`);
      dropPreview = null;
      lastPreviewKey = -1;
    },
    onCancel() {
      draggedActivityId = null;
      dragSourceDay = null;
      dropPreview = null;
    }
  };

  function startResize(e: PointerEvent, activity: Activity, dayIndex: number) {
    e.stopPropagation(); // no disparar long-press/click/drag del ítem
    e.preventDefault();
    engine.beginImmediate(
      e,
      { card: e.currentTarget as HTMLElement, activityId: activity.id!, meta: { day: dayIndex, origStart: parseTime(activity.startTime), origEnd: parseTime(activity.endTime), startY: e.clientY } satisfies WeekResizeMeta },
      weekResizeHooks,
      { ghost: false }
    );
  }

  /**
   * Cálculo COMPARTIDO por preview y commit del resize (una sola matemática):
   * newEnd desde el puntero (snap 15min, clamp) y el mapa resuelto con
   * keepPlace=true — al estirar, el INICIO queda anclado: la cascada empuja
   * hacia abajo, nunca reacomoda la tarjeta que se estira.
   */
  function computeWeekResize(clientY: number, actId: string, m: WeekResizeMeta): { newEnd: number; slots: Map<string, { start: number; end: number }> } | null {
    const col = document.querySelectorAll('.day-column .slots-grid')[m.day];
    if (!col) return null;
    const deltaSlots = (clientY - m.startY) / slotHeightPx;
    let newEnd = Math.round((m.origEnd + deltaSlots / slotsPerHour) * 4) / 4;
    newEnd = Math.max(m.origStart + 0.25, Math.min(newEnd, endHour));
    const res = propagateWeekly(activities, actId, m.origStart, endHour, CODEC, activities.find(a => a.id === actId)?.daysOfWeek ?? [], newEnd - m.origStart, 0, true);
    return { newEnd, slots: res.byDay.get(m.day) ?? new Map() };
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
      toastOk(`${clone.name} → ${format12h(clone.startTime)}`);
    } else {
      toastErr('No hay hueco libre para duplicar');
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
      toastOk('Actividad eliminada');
    } catch (err: any) {
      console.error(err);
    }
  }
</script>

<svelte:window onclick={closeContextMenu} onscroll={closeContextMenu} />

<div class="weekly-grid-container" style="--total-slots: {totalSlots}; --slot-height: {slotHeightPx}px">
  <div class="scroll-hint" aria-hidden="true">Deslizá para ver los días →</div>
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
      <div class="day-column">
        <button class="day-header" onclick={() => onSelectDay(i)} aria-label="Ver {day} en vista de día">
          <span class="day-name">{day}</span>
          {#if dayOverrides.some(o => o.day === i && o.activities?.length >= 0)}
            <span class="day-temp-badge" title="Tiene edición temporal activa en la vista diaria">⚡</span>
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
              aria-label="{activity.name}, {format12h(activity.startTime)} a {format12h(activity.endTime)}{activity.steps?.length ? `, ${activity.steps.length} pasos` : ''}. Flechas arriba/abajo para mover, Enter para editar"
            >
              <div class="activity-title">
                <span>{activity.name}</span>
                {#if activity.image}
                  <span
                    class="grid-steps-icon grid-image-icon"
                    role="button"
                    tabindex="0"
                    title="Ver imagen de la rutina"
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
                class="resize-handle"
                aria-hidden="true"
                onpointerdown={(e) => startResize(e, activity, i)}
              ></div>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
  </div>

  {#if contextMenu.show}
    <!-- Portal a body: backdrop-filter de .glass-panel ancestro crea containing block y rompe el position:fixed -->
    <div class="custom-context-menu glass-panel" use:portal style="top: {contextMenu.y}px; left: {contextMenu.x}px">
      <button onclick={duplicateActivity} aria-label="Duplicar actividad como bloque independiente">
        <Copy size={16} /> Duplicar (Independiente)
      </button>
      {#if viewingImageActivity === null && activityHasImage}
        <button onclick={() => { viewingImageActivity = activities.find(a => a.id === contextMenu.activityId) || null; }}>
          <ImageIcon size={16} /> Ver imagen
        </button>
      {/if}
      <button class="delete-btn" onclick={askDeleteActivity}>
        <Trash2 size={16} /> Eliminar
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
  }

  /* El scroll es del CONTENIDO (no del contenedor): así la columna de horas
     puede quedar pegajosa y los días no arrastran la página entera. */
  .grid-scroll {
    display: flex;
    min-width: 720px;
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
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 1px;
    background: rgba(0,0,0,0.06);
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
  }

  /* El fantasma arrastrado: sin transición de top (el HTML5 DnD no mueve la
     tarjeta, solo la imagen del cursor) pero elevado, semi-transparente y
     con una presión sutil (98%) — feedback de agarre minimalista. */
  .activity-item.drag-ghost {
    opacity: 0.55;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.3);
    z-index: 40;
    transform: scale(0.98);
  }

  /* Accesibilidad: sin deslizamientos para quien pide menos movimiento. */
  @media (prefers-reduced-motion: reduce) {
    .activity-item,
    .activity-item.drag-ghost {
      transition: none !important;
      animation: none !important;
    }
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

  /* Hint de scroll horizontal solo en pantallas angostas */
  .scroll-hint {
    display: none;
  }
  @media (max-width: 768px) {
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
</style>

<script lang="ts">
  import type { Activity, Category, DayOverride } from '../lib/types';
  import { parseTime, getActivityColor, formatTime, format12h } from '../lib/stores';
  import { db } from '../lib/db';
  import { duplicateActivity as duplicateActivityOp } from '../lib/activityOps';
  import { Copy, Trash2, ListChecks, ImageIcon } from '@lucide/svelte';
  import ImageLightbox from './ImageLightbox.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr } from '../lib/toast';

  interface Props {
    activities: Activity[];
    categories: Category[];
    settings: { startHour: number; endHour: number };
    dayOverrides?: DayOverride[];
    onSelectDay: (day: number) => void;
    onEditActivity: (id: number) => void;
  }

  let { activities, categories, settings, dayOverrides = [], onSelectDay, onEditActivity }: Props = $props();

  const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const startHour = $derived(settings.startHour);
  const endHour = $derived(settings.endHour);
  const totalHours = $derived(endHour - startHour);
  
  // 15-minute precision (4 slots per hour)
  const slotsPerHour = 4;
  const slotHeightPx = 26; // ≥26px/slot: bloques de 15min tocables (~44px los de 30min, 104px los de 1h)
  const totalSlots = $derived(totalHours * slotsPerHour);

  const hours = $derived(Array.from({ length: totalHours + 1 }, (_, i) => startHour + i));

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
    colStart: number;
    colSpan: number;
  }

  // Filter, calculate precise row slots and resolve overlaps per day
  function getDayActivitiesWithLayout(dayIndex: number) {
    const dayActs = activities
      .filter((a: Activity) => a.daysOfWeek.includes(dayIndex))
      .map(a => {
        const rowStart = getRowPosition(a.startTime);
        const rowEnd = Math.max(rowStart + 1, getRowPosition(a.endTime));
        return {
          ...a,
          rowStart,
          rowEnd,
          numSlots: rowEnd - rowStart,
          _start: parseTime(a.startTime),
          _end: parseTime(a.endTime)
        };
      })
      .sort((a, b) => a._start - b._start || (b._end - b._start) - (a._end - a._start));

    if (dayActs.length === 0) return { items: [] as LayoutActivity[], maxCols: 1 };

    // Group into clusters of overlapping activities
    const clusters: (typeof dayActs)[] = [];
    let currentCluster: typeof dayActs = [];
    let clusterEnd = -1;

    for (const act of dayActs) {
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
    const preliminaryItems: { act: typeof dayActs[0]; track: number; clusterCols: number }[] = [];

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

    const resultItems: LayoutActivity[] = preliminaryItems.map(item => ({
      ...item.act,
      colStart: item.track + 1,
      colSpan: item.clusterCols === 1 ? overallMaxCols : 1
    }));

    return { items: resultItems, maxCols: overallMaxCols };
  }

  // Drag and Drop handlers
  let draggedActivityId = $state<string | null>(null);
  let dragSourceDay = $state<number | null>(null);
  let dragOffset = $state(0);

  function handleDragStart(e: DragEvent, activity: Activity, dayIndex: number) {
    draggedActivityId = activity.id!;
    dragSourceDay = dayIndex;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    dragOffset = (e.clientY - rect.top) / slotHeightPx;
    
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', activity.id!.toString());
      e.dataTransfer.effectAllowed = 'move';
    }
  }

  async function handleDrop(e: DragEvent, dayIndex: number) {
    e.preventDefault();
    if (draggedActivityId === null || dragSourceDay === null) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    let slotIndex = Math.floor(y / slotHeightPx);
    
    // Adjust by drag offset so it drops where you grabbed it
    slotIndex = Math.max(0, slotIndex - Math.floor(dragOffset));

    const activity = activities.find(a => a.id === draggedActivityId);
    
    if (activity) {
      const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
      const durationSlots = Math.max(1, Math.round(duration * slotsPerHour));
      slotIndex = Math.min(slotIndex, Math.max(0, totalSlots - durationSlots));

      const newStartHour = startHour + (slotIndex / slotsPerHour);
      const newEndHour = newStartHour + duration;
      
      let newDays = [...activity.daysOfWeek];
      const idx = newDays.indexOf(dragSourceDay);
      if (idx !== -1) {
        newDays[idx] = dayIndex;
      } else if (!newDays.includes(dayIndex)) {
        newDays.push(dayIndex);
      }
      newDays = [...new Set(newDays)].sort((a, b) => a - b);

      await db.activities.update(draggedActivityId, {
        startTime: formatTime(newStartHour),
        endTime: formatTime(newEndHour),
        daysOfWeek: newDays,
        updatedAt: Date.now()
      });
    }
    
    draggedActivityId = null;
    dragSourceDay = null;
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  // Context Menu logic
  let contextMenu = $state({ show: false, x: 0, y: 0, activityId: null as string | null });

  // Lightbox para ver la imagen de la rutina
  let viewingImageActivity = $state<Activity | null>(null);

  const activityHasImage = $derived(
    contextMenu.activityId !== null &&
    !!activities.find(a => a.id === contextMenu.activityId)?.image
  );

  function handleContextMenu(e: MouseEvent, activityId: number) {
    e.preventDefault();
    // Clamp para que el menú no se salga de la ventana
    const MENU_W = 220;
    const MENU_H = 130;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    contextMenu = { show: true, x: Math.max(4, x), y: Math.max(4, y), activityId };
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
      toastErr('No hay hueco libre ese día para duplicar');
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
    <div class="scroll-hint" aria-hidden="true">Deslizá para ver todos los días →</div>
    {#each days as day, i}
      {@const dayData = getDayActivitiesWithLayout(i)}
      <div class="day-column">
        <button class="day-header" onclick={() => onSelectDay(i)} aria-label="Ver {day} en vista de día">
          <span class="day-name">{day}</span>
          {#if dayOverrides.some(o => o.day === i && o.activities?.length >= 0)}
            <span class="day-temp-badge" title="Tiene edición temporal activa en la vista diaria">⚡</span>
          {/if}
        </button>
        <div 
          class="slots-grid" 
          style="grid-template-columns: repeat({dayData.maxCols}, minmax(0, 1fr));"
          ondragover={handleDragOver}
          ondrop={(e) => handleDrop(e, i)}
        >
          {#each dayData.items as activity (activity.id)}
            {@const rowStart = activity.rowStart}
            {@const rowEnd = activity.rowEnd}
            {@const numSlots = activity.numSlots}
            <button 
              class="activity-item" 
              class:short={numSlots <= 1}
              draggable="true"
              ondragstart={(e) => handleDragStart(e, activity, i)}
              oncontextmenu={(e) => handleContextMenu(e, activity.id!)}
              style="grid-row: {rowStart} / {rowEnd}; grid-column: {activity.colStart} / span {activity.colSpan}; --bg-color: {getActivityColor(activity.categoryId, categories)}"
              onclick={() => onEditActivity(activity.id!)}
              aria-label="{activity.name}, {format12h(activity.startTime)} a {format12h(activity.endTime)}{activity.steps?.length ? `, ${activity.steps.length} pasos` : ''}"
              title="{activity.name} • {format12h(activity.startTime)} - {format12h(activity.endTime)}"
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
                  <span class="grid-steps-icon" title="{activity.steps.length} pasos">
                    <ListChecks size={10} />
                  </span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </div>

  {#if contextMenu.show}
    <div class="custom-context-menu glass-panel" style="top: {contextMenu.y}px; left: {contextMenu.x}px">
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
    display: flex;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    min-width: 720px;
    padding-bottom: 1rem;
    padding-top: 10px;
    position: relative;
    scrollbar-width: thin;
  }

  .time-column {
    display: grid;
    grid-template-rows: 40px repeat(var(--total-slots), var(--slot-height));
    width: 68px;
    padding-right: 0.5rem;
    border-right: 1px solid rgba(0,0,0,0.08);
    user-select: none;
    flex-shrink: 0;
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
    display: grid;
    grid-template-rows: repeat(var(--total-slots), var(--slot-height));
    position: relative;
    overflow: hidden;
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

  .activity-item {
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
    transition: transform 0.15s, box-shadow 0.15s, opacity 0.15s;
    min-width: 0;
    min-height: 24px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    box-sizing: border-box;
  }
  .activity-item:hover,
  .activity-item:focus-visible {
    opacity: 1;
    z-index: 5;
    box-shadow: 0 3px 10px rgba(0,0,0,0.25);
  }

  .activity-item:active {
    cursor: grabbing;
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
    animation: fadeIn 0.1s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  .custom-context-menu button {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
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

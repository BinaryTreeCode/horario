<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Activity, Category } from '../lib/types.ts';
  import { parseTime, getActivityColor, formatTime } from '../lib/stores.ts';
  import { Clock, Edit3, Copy, Trash2 } from 'lucide-svelte';
  import { db } from '../lib/db.ts';

  interface Props {
    day: number;
    activities: Activity[];
    categories: Category[];
    settings: { startHour: number; endHour: number };
    onEditActivity: (id: number) => void;
  }

  let { day, activities, categories, settings, onEditActivity }: Props = $props();

  const dayName = $derived(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'][day]);
  const startHour = $derived(settings.startHour);
  const endHour = $derived(settings.endHour);
  const totalHours = $derived(endHour - startHour);

  // Time bar state
  let now = $state(new Date());
  let interval: any;

  onMount(() => {
    interval = setInterval(() => {
      now = new Date();
    }, 60000);
  });

  onDestroy(() => {
    clearInterval(interval);
  });

  const currentMinutes = $derived(now.getHours() * 60 + now.getMinutes());
  const startMinutes = $derived(startHour * 60);
  const endMinutes = $derived(endHour * 60);
  
  const barTopPercent = $derived(((currentMinutes - startMinutes) / (endMinutes - startMinutes)) * 100);
  const isNowInRange = $derived(currentMinutes >= startMinutes && currentMinutes <= endMinutes);

  const dayActivities = $derived(activities.filter((a: Activity) => a.daysOfWeek.includes(day)));

  function calculateActivityPosition(startTime: string, endTime: string) {
    const s = parseTime(startTime);
    const e = parseTime(endTime);
    const top = ((s - startHour) / totalHours) * 100;
    const height = ((e - s) / totalHours) * 100;
    return { top: `${top}%`, height: `${height}%` };
  }

  function format12h(timeStr: string) {
    const [h, m] = timeStr.split(':').map(Number);
    const period = h < 12 ? 'AM' : (h === 24 ? 'AM' : 'PM');
    const hour12 = h % 12 || 12;
    return `${hour12}:${m.toString().padStart(2, '0')} ${period}`;
  }

  // Drag and Drop
  let draggedActivityId = $state<number | null>(null);
  let dragOffsetPercent = $state(0);

  function handleDragStart(e: DragEvent, activity: Activity) {
    draggedActivityId = activity.id!;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const clickYPercent = ((e.clientY - rect.top) / rect.height) * (parseTime(activity.endTime) - parseTime(activity.startTime));
    dragOffsetPercent = clickYPercent;

    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', activity.id!.toString());
      e.dataTransfer.effectAllowed = 'move';
    }
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    if (draggedActivityId === null) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;
    const yPercent = y / rect.height;
    
    let newStartHour = startHour + (yPercent * totalHours) - dragOffsetPercent;
    
    // Snap to 15 minutes
    newStartHour = Math.round(newStartHour * 4) / 4;

    const activity = activities.find(a => a.id === draggedActivityId);
    if (!activity) { draggedActivityId = null; return; }

    const duration = parseTime(activity.endTime) - parseTime(activity.startTime);

    // Clamp within day bounds
    newStartHour = Math.max(startHour, Math.min(newStartHour, endHour - duration));
    let newEndHour = newStartHour + duration;

    // ── Collision resolution (cascade push-down) ──────────────────────────
    // Build a mutable map of all OTHER same-day activities with their times.
    type SlotMap = { id: number; start: number; end: number };
    const siblings: SlotMap[] = dayActivities
      .filter(a => a.id !== draggedActivityId)
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }))
      .sort((a, b) => a.start - b.start);

    // Place the dragged activity first.
    const dragged: SlotMap = { id: draggedActivityId, start: newStartHour, end: newEndHour };

    // Merge into one list and sort by start time.
    const all: SlotMap[] = [...siblings, dragged].sort((a, b) => a.start - b.start);

    // Forward pass: push each activity down if it overlaps the previous one.
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur  = all[i];
      if (cur.start < prev.end) {
        const shift = prev.end - cur.start;
        cur.start += shift;
        cur.end   += shift;
      }
    }

    // Backward pass: if any activity was pushed beyond endHour, pull it back
    // and cascade upward (push earlier activities up).
    for (let i = all.length - 1; i >= 0; i--) {
      const cur = all[i];
      const dur = cur.end - cur.start;
      if (cur.end > endHour) {
        cur.end   = endHour;
        cur.start = endHour - dur;
      }
      if (i > 0) {
        const prev = all[i - 1];
        if (prev.end > cur.start) {
          // Push the previous activity upward to make room
          const prevDur = parseTime(activities.find(a => a.id === prev.id)!.endTime)
                        - parseTime(activities.find(a => a.id === prev.id)!.startTime);
          prev.end   = cur.start;
          prev.start = cur.start - prevDur;
        }
      }
    }

    // Persist all changed activities in one batch.
    const updates = all.filter(slot => {
      const orig = activities.find(a => a.id === slot.id);
      if (!orig) return false;
      return formatTime(slot.start) !== orig.startTime || formatTime(slot.end) !== orig.endTime;
    });

    await Promise.all(
      updates.map(slot =>
        db.activities.update(slot.id, {
          startTime: formatTime(slot.start),
          endTime:   formatTime(slot.end)
        })
      )
    );
    // ──────────────────────────────────────────────────────────────────────

    draggedActivityId = null;
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  // Context Menu logic
  let contextMenu = $state({ show: false, x: 0, y: 0, activityId: null as number | null });

  function handleContextMenu(e: MouseEvent, activityId: number) {
    e.preventDefault();
    contextMenu = { show: true, x: e.clientX, y: e.clientY, activityId };
  }

  function closeContextMenu() {
    contextMenu.show = false;
  }

  async function duplicateActivity() {
    if (contextMenu.activityId) {
      const original = await db.activities.get(contextMenu.activityId);
      if (original) {
        const { id: _, ...clone } = original;
        clone.name = `${clone.name} (copia)`;
        await db.activities.add(clone);
      }
    }
    closeContextMenu();
  }

  async function deleteActivity() {
    if (contextMenu.activityId) {
      if (confirm('¿Eliminar esta actividad?')) {
        await db.activities.delete(contextMenu.activityId);
      }
    }
    closeContextMenu();
  }
</script>

<svelte:window onclick={closeContextMenu} onscroll={closeContextMenu} />

<div class="daily-view">
  <div class="daily-header">
    <h2>{dayName}</h2>
    <div class="current-time-display">
      <Clock size={16} /> {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </div>
  </div>

  <div class="daily-container">
    <div class="time-track">
      {#each Array.from({ length: totalHours + 1 }, (_, i) => startHour + i) as hour}
        <div class="hour-marker" style="top: {((hour - startHour) / totalHours) * 100}%">
          <span>{hour % 12 || 12}:00 {hour < 12 ? 'AM' : (hour === 24 ? 'AM' : 'PM')}</span>
        </div>
      {/each}
    </div>

    <div 
      class="activities-track"
      ondragover={handleDragOver}
      ondrop={handleDrop}
    >
      {#each dayActivities as activity}
        {@const pos = calculateActivityPosition(activity.startTime, activity.endTime)}
        <div 
          class="daily-activity-card glass-panel" 
          draggable="true"
          ondragstart={(e) => handleDragStart(e, activity)}
          oncontextmenu={(e) => handleContextMenu(e, activity.id!)}
          style="top: {pos.top}; height: {pos.height}; border-left-color: {getActivityColor(activity.categoryId, categories)}"
        >
          <div class="activity-content">
            <div class="activity-name">{activity.name}</div>
            <div class="activity-time">
              {#if activity.startTime === activity.endTime}
                {format12h(activity.startTime)}
              {:else}
                {format12h(activity.startTime)} - {format12h(activity.endTime)}
              {/if}
            </div>
            <button class="edit-btn" onclick={() => onEditActivity(activity.id!)}>
              <Edit3 size={14} />
            </button>
          </div>
        </div>
      {/each}

      {#if isNowInRange}
        <div class="time-bar" style="top: {barTopPercent}%">
          <div class="time-bar-dot">
            <span class="time-bar-label">
              {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
          <div class="time-bar-line"></div>
        </div>
      {/if}
    </div>
  </div>

  {#if contextMenu.show}
    <div class="custom-context-menu glass-panel" style="top: {contextMenu.y}px; left: {contextMenu.x}px">
      <button onclick={duplicateActivity}>
        <Copy size={16} /> Duplicar (Independiente)
      </button>
      <button class="delete-btn" onclick={deleteActivity}>
        <Trash2 size={16} /> Eliminar
      </button>
    </div>
  {/if}
</div>

<style>
  .daily-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .daily-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 1px solid rgba(0,0,0,0.05);
  }

  .daily-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--color-green-dark);
  }

  .current-time-display {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--color-brown-bark);
    padding: 0.5rem 1rem;
    background: rgba(92, 64, 51, 0.05);
    border-radius: 20px;
  }

  .daily-container {
    flex: 1;
    position: relative;
    display: flex;
    margin: 1.5rem;
    overflow-y: auto;
    min-height: 1400px; /* Increased scale to reduce crowding */
  }

  .time-track {
    width: 70px;
    position: relative;
    border-right: 1px solid rgba(0,0,0,0.05);
  }

  .hour-marker {
    position: absolute;
    width: 100%;
    transform: translateY(-50%);
    font-size: 0.75rem;
    color: #888;
    display: flex;
    justify-content: flex-end;
    padding-right: 0.5rem;
  }

  .activities-track {
    flex: 1;
    position: relative;
    margin-left: 1rem;
  }

  .daily-activity-card {
    position: absolute;
    width: 100%;
    left: 0;
    background: white;
    border-left: 5px solid;
    padding: 0.5rem 1rem;
    box-sizing: border-box;
    transition: transform 0.2s, box-shadow 0.2s, background 0.2s, top 0.25s ease, height 0.25s ease;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-start; /* Start from top to handle long tasks */
    min-height: 2.25rem;
    z-index: 1;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    cursor: grab;
  }

  .daily-activity-card:active {
    cursor: grabbing;
  }

  .daily-activity-card:hover {
    transform: translateX(5px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    z-index: 10;
    overflow: visible;
    background: #fdfdfd;
  }

  .activity-content {
    display: flex;
    flex-direction: row; /* Global row layout as requested */
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    height: 100%;
    min-height: 1.25rem;
    padding-right: 2.5rem; /* Space for edit button */
  }

  .activity-time {
    font-size: 0.8rem;
    color: #888;
    font-weight: 500;
    white-space: nowrap;
    opacity: 0.8;
  }

  .activity-name {
    font-weight: 700;
    font-size: 1rem;
    color: var(--text-main);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .edit-btn {
    position: absolute;
    top: 50%;
    right: 0.75rem;
    transform: translateY(-50%);
    background: white;
    border: none;
    color: #bbb;
    cursor: pointer;
    padding: 0.35rem;
    opacity: 0;
    transition: all 0.2s;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  }

  .daily-activity-card:hover .edit-btn {
    opacity: 1;
  }

  .edit-btn:hover {
    color: var(--color-green-dark);
  }

  .time-bar {
    position: absolute;
    width: 100%;
    left: -1rem; /* Extend to time track */
    right: 0;
    z-index: 20;
    pointer-events: none;
    display: flex;
    align-items: center;
  }

  .time-bar-dot {
    width: 10px;
    height: 10px;
    background: #e53e3e;
    border-radius: 50%;
    box-shadow: 0 0 5px rgba(229, 62, 62, 0.5);
    position: relative;
    display: flex;
    align-items: center;
  }

  .time-bar-label {
    position: absolute;
    right: 15px; /* Move to the left of the dot */
    background: #e53e3e;
    color: white;
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
    white-space: nowrap;
    pointer-events: none;
    display: flex;
    align-items: center;
  }

  .time-bar-label::after {
    content: '';
    position: absolute;
    right: -4px;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-left: 4px solid #e53e3e;
  }  
  .time-bar-line {
    flex: 1;
    height: 2px;
    background: #e53e3e;
    opacity: 0.5;
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

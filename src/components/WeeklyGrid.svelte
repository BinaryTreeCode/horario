<script lang="ts">
  import type { Activity, Category } from '../lib/types.ts';
  import { parseTime, getActivityColor, formatTime } from '../lib/stores.ts';
  import { db } from '../lib/db.ts';
  import { Copy, Trash2, ListChecks } from 'lucide-svelte';

  interface Props {
    activities: Activity[];
    categories: Category[];
    settings: { startHour: number; endHour: number };
    onSelectDay: (day: number) => void;
    onEditActivity: (id: number) => void;
  }

  let { activities, categories, settings, onSelectDay, onEditActivity }: Props = $props();

  const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const startHour = $derived(settings.startHour);
  const endHour = $derived(settings.endHour);
  const totalHours = $derived(endHour - startHour);
  const slotsPerHour = 2; // Every 30 mins
  const totalSlots = $derived(totalHours * slotsPerHour);

  const hours = $derived(Array.from({ length: totalHours + 1 }, (_, i) => startHour + i));

  // Function to calculate grid row position
  function getRowPosition(timeStr: string) {
    const time = parseTime(timeStr);
    const offset = time - startHour;
    return Math.max(1, Math.floor(offset * slotsPerHour) + 1);
  }

  // Filter and prepare activities per day
  function getDayActivities(dayIndex: number) {
    return activities.filter((a: Activity) => a.daysOfWeek.includes(dayIndex));
  }

  // Drag and Drop handlers
  let draggedActivityId = $state<number | null>(null);
  let dragSourceDay = $state<number | null>(null);
  let dragOffset = $state(0);

  function handleDragStart(e: DragEvent, activity: Activity, dayIndex: number) {
    draggedActivityId = activity.id!;
    dragSourceDay = dayIndex;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    dragOffset = (e.clientY - rect.top) / 20; // in slots (20px per slot)
    
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
    let slotIndex = Math.floor(y / 20); // 20px is slot height
    
    // Adjust by drag offset so it drops where you grabbed it
    slotIndex = Math.max(0, slotIndex - Math.floor(dragOffset));

    const newStartHour = startHour + (slotIndex / slotsPerHour);
    const activity = activities.find(a => a.id === draggedActivityId);
    
    if (activity) {
      const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
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
        daysOfWeek: newDays
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

<div class="weekly-grid-container">
  <div class="time-column">
    <div class="header-spacer"></div>
    {#each hours as hour}
      <div class="hour-label" style="grid-row: {getRowPosition(hour + ':00') + 1}">
        {hour % 12 || 12}:00 {hour < 12 ? 'AM' : (hour === 24 ? 'AM' : 'PM')}
      </div>
    {/each}
  </div>

  <div class="days-columns" style="--total-slots: {totalSlots}">
    {#each days as day, i}
      <div class="day-column">
        <button class="day-header" onclick={() => onSelectDay(i)}>
          {day}
        </button>
        <div 
          class="slots-grid" 
          ondragover={handleDragOver}
          ondrop={(e) => handleDrop(e, i)}
        >
          {#each getDayActivities(i) as activity}
            {@const rowStart = getRowPosition(activity.startTime)}
            {@const rowEnd = Math.max(rowStart + 1, getRowPosition(activity.endTime))}
            <button 
              class="activity-item" 
              draggable="true"
              ondragstart={(e) => handleDragStart(e, activity, i)}
              oncontextmenu={(e) => handleContextMenu(e, activity.id!)}
              style="grid-row: {rowStart} / {rowEnd}; --bg-color: {getActivityColor(activity.categoryId, categories)}"
              onclick={() => onEditActivity(activity.id!)}
            >
              <div class="activity-title">
                {activity.name}
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
  .weekly-grid-container {
    display: flex;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    min-width: 650px;
    padding-bottom: 1rem;
    padding-top: 10px;
    position: relative;
    scrollbar-width: thin;
  }

  .time-column {
    display: grid;
    grid-template-rows: 40px repeat(var(--total-slots), 20px);
    width: 60px;
    padding-right: 0.5rem;
    border-right: 1px solid rgba(0,0,0,0.05);
  }

  .header-spacer {
    height: 40px;
  }

  .hour-label {
    font-size: 0.75rem;
    color: #666;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    transform: translateY(-50%);
  }

  .days-columns {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
    background: rgba(0,0,0,0.05);
  }

  .day-column {
    display: flex;
    flex-direction: column;
    background: white;
  }

  .day-header {
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    font-weight: 600;
    border-bottom: 1px solid rgba(0,0,0,0.05);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.2s;
  }

  .day-header:hover {
    background: rgba(92, 64, 51, 0.05);
  }

  .slots-grid {
    flex: 1;
    display: grid;
    grid-template-rows: repeat(var(--total-slots), 20px);
    position: relative;
  }

  .activity-item {
    background: var(--bg-color);
    color: white;
    margin: 1px;
    border-radius: 4px;
    padding: 2px 4px;
    font-size: 0.75rem;
    text-align: left;
    border: none;
    cursor: grab;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.9;
    transition: all 0.2s;
  }

  .activity-item:active {
    cursor: grabbing;
  }

  .activity-item:hover {
    opacity: 1;
    z-index: 10;
    transform: scale(1.02);
  }

  .slots-grid:hover {
    background: rgba(0,0,0,0.02);
  }

  .activity-title {
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem;
  }

  .grid-steps-icon {
    display: inline-flex;
    align-items: center;
    background: rgba(255, 255, 255, 0.3);
    padding: 1px 3px;
    border-radius: 4px;
    font-size: 0.65rem;
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

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Activity, Category, DayOverride } from '../lib/types.ts';
  import { parseTime, getActivityColor, formatTime } from '../lib/stores.ts';
  import { Clock, Edit3, Copy, Trash2, ListChecks, RotateCcw, Save, Calendar, Zap, ImageIcon } from 'lucide-svelte';
  import { db, newId } from '../lib/db.ts';
  import ImageLightbox from './ImageLightbox.svelte';

  interface Props {
    day: number;
    activities: Activity[];
    categories: Category[];
    settings: { startHour: number; endHour: number };
    dayOverrides?: DayOverride[];
    onEditActivity: (id: number, initialData?: Activity) => void;
  }

  let { day, activities, categories, settings, dayOverrides = [], onEditActivity }: Props = $props();

  const dayName = $derived(['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'][day]);
  const startHour = $derived(settings.startHour);
  const endHour = $derived(settings.endHour);
  const totalHours = $derived(endHour - startHour);

  // Mode: isTemporaryMode means edits are temporary for this day only and don't touch master schedule
  let isTemporaryMode = $state(true);

  const currentOverride = $derived(dayOverrides.find(o => o.day === day));
  const hasOverride = $derived(!!currentOverride && currentOverride.activities !== undefined);

  // Activities to display for this day: use override if active, else master activities
  const dayActivities = $derived(
    isTemporaryMode && hasOverride
      ? currentOverride!.activities
      : activities.filter((a: Activity) => a.daysOfWeek.includes(day))
  );

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

  interface DailyLayoutItem extends Activity {
    top: string;
    height: string;
    left: string;
    width: string;
    durationMins: number;
  }

  const layoutActivities = $derived((() => {
    const acts = dayActivities.map(a => ({
      ...a,
      _start: parseTime(a.startTime),
      _end: parseTime(a.endTime)
    })).sort((a, b) => a._start - b._start || (b._end - b._start) - (a._end - a._start));

    if (acts.length === 0) return [] as DailyLayoutItem[];

    const clusters: (typeof acts)[] = [];
    let currentCluster: typeof acts = [];
    let clusterEnd = -1;

    for (const act of acts) {
      if (currentCluster.length === 0 || act._start < clusterEnd - 0.0001) {
        currentCluster.push(act);
        clusterEnd = Math.max(clusterEnd, act._end);
      } else {
        clusters.push(currentCluster);
        currentCluster = [act];
        clusterEnd = act._end;
      }
    }
    if (currentCluster.length > 0) clusters.push(currentCluster);

    const result: DailyLayoutItem[] = [];

    for (const cluster of clusters) {
      const tracks: number[] = [];
      const assignments: { act: typeof acts[0]; track: number }[] = [];

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
        assignments.push({ act, track: assigned });
      }

      const numTracks = Math.max(1, tracks.length);
      for (const item of assignments) {
        const s = item.act._start;
        const e = item.act._end;
        const top = ((s - startHour) / totalHours) * 100;
        const height = ((e - s) / totalHours) * 100;
        const widthPct = 100 / numTracks;
        const leftPct = item.track * widthPct;
        const durationMins = Math.round((e - s) * 60);

        result.push({
          ...item.act,
          top: `${top}%`,
          height: `calc(${height}% - 3px)`,
          left: `${leftPct}%`,
          width: numTracks > 1 ? `calc(${widthPct}% - 4px)` : '100%',
          durationMins
        });
      }
    }

    return result;
  })());

  // ── Temporary mode helpers ──────────────────────────────────────────────

  /** Ensure a dayOverride exists for the current day. Returns a mutable copy of the activities. */
  async function ensureOverride(): Promise<Activity[]> {
    const existing = dayOverrides.find(o => o.day === day);
    if (existing && existing.activities) {
      return existing.activities.map(a => ({ ...a }));
    }
    // Initialize from master schedule
    const masterActs = activities
      .filter(a => a.daysOfWeek.includes(day))
      .map(a => ({ ...a }));
    await db.dayOverrides.put({
      day,
      activities: masterActs,
      updatedAt: Date.now()
    });
    return masterActs;
  }

  async function restoreDefaultTemplate() {
    if (confirm('¿Restaurar la plantilla por defecto para este día? Se perderán los cambios temporales.')) {
      await db.dayOverrides.delete(day);
    }
  }

  async function saveAsPermanentTemplate() {
    if (!currentOverride?.activities) return;
    if (!confirm('¿Aplicar estos cambios temporales como la plantilla semanal permanente?')) return;

    const overrideActs = currentOverride.activities;

    // Get current master activities for this day
    const masterDayActs = activities.filter(a => a.daysOfWeek.includes(day));

    // Remove this day from all master activities that had it
    for (const act of masterDayActs) {
      const newDays = act.daysOfWeek.filter(d => d !== day);
      if (newDays.length === 0) {
        await db.activities.update(act.id!, { deletedAt: Date.now(), updatedAt: Date.now() });
      } else {
        await db.activities.update(act.id!, { daysOfWeek: newDays, updatedAt: Date.now() });
      }
    }

    // Add override activities as new master activities assigned to this day
    for (const act of overrideActs) {
      const { id: _, ...clone } = act;
      clone.daysOfWeek = [day];
      await db.activities.add(clone);
    }

    // Remove the override since it's now the master
    await db.dayOverrides.delete(day);
  }

  // Drag and Drop
  let draggedActivityId = $state<string | null>(null);
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

    const sourceActs = dayActivities;
    const activity = sourceActs.find(a => a.id === draggedActivityId);
    if (!activity) { draggedActivityId = null; return; }

    const duration = parseTime(activity.endTime) - parseTime(activity.startTime);

    // Clamp within day bounds
    newStartHour = Math.max(startHour, Math.min(newStartHour, endHour - duration));
    let newEndHour = newStartHour + duration;

    // ── Collision resolution (cascade push-down) ──────────────────────────
    type SlotMap = { id: number; start: number; end: number };
    const siblings: SlotMap[] = sourceActs
      .filter(a => a.id !== draggedActivityId)
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }))
      .sort((a, b) => a.start - b.start);

    const dragged: SlotMap = { id: draggedActivityId, start: newStartHour, end: newEndHour };
    const all: SlotMap[] = [...siblings, dragged].sort((a, b) => a.start - b.start);

    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur  = all[i];
      if (cur.start < prev.end) {
        const shift = prev.end - cur.start;
        cur.start += shift;
        cur.end   += shift;
      }
    }

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
          const origAct = sourceActs.find(a => a.id === prev.id);
          const prevDur = origAct ? parseTime(origAct.endTime) - parseTime(origAct.startTime) : prev.end - prev.start;
          prev.end   = cur.start;
          prev.start = cur.start - prevDur;
        }
      }
    }

    if (isTemporaryMode) {
      // Save to dayOverrides
      const overrideActs = await ensureOverride();
      for (const slot of all) {
        const act = overrideActs.find(a => a.id === slot.id);
        if (act) {
          act.startTime = formatTime(slot.start);
          act.endTime = formatTime(slot.end);
        }
      }
      await db.dayOverrides.put({
        day,
        activities: overrideActs,
        updatedAt: Date.now()
      });
    } else {
      // Save to master db.activities
      const updates = all.filter(slot => {
        const orig = activities.find(a => a.id === slot.id);
        if (!orig) return false;
        return formatTime(slot.start) !== orig.startTime || formatTime(slot.end) !== orig.endTime;
      });
      await Promise.all(
        updates.map(slot =>
          db.activities.update(slot.id, {
            startTime: formatTime(slot.start),
            endTime:   formatTime(slot.end),
            updatedAt: Date.now()
          })
        )
      );
    }

    draggedActivityId = null;
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

  const contextMenuActivity = $derived(
    contextMenu.activityId !== null
      ? dayActivities.find(a => a.id === contextMenu.activityId) || null
      : null
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
    if (!contextMenu.activityId) { closeContextMenu(); return; }

    if (isTemporaryMode) {
      const overrideActs = await ensureOverride();
      const original = overrideActs.find(a => a.id === contextMenu.activityId);
      if (original) {
        const clone = { ...original, id: newId(), name: `${original.name} (copia)` };
        overrideActs.push(clone);
        await db.dayOverrides.put({
          day,
          activities: overrideActs,
          updatedAt: Date.now()
        });
      }
    } else {
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
    if (!contextMenu.activityId) { closeContextMenu(); return; }
    if (!confirm('¿Eliminar esta actividad?')) { closeContextMenu(); return; }

    if (isTemporaryMode) {
      const overrideActs = await ensureOverride();
      const filtered = overrideActs.filter(a => a.id !== contextMenu.activityId);
      await db.dayOverrides.put({
        day,
        activities: filtered,
        updatedAt: Date.now()
      });
    } else {
      await db.activities.delete(contextMenu.activityId);
    }
    closeContextMenu();
  }
</script>

<svelte:window onclick={closeContextMenu} onscroll={closeContextMenu} />

<div class="daily-view">
  <div class="daily-header">
    <div class="header-top-row">
      <h2>{dayName}</h2>
      <div class="current-time-display">
        <Clock size={16} /> {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>

    <!-- Mode toggle -->
    <div class="mode-pill-toggle">
      <button
        class="mode-btn"
        class:active={isTemporaryMode}
        onclick={() => isTemporaryMode = true}
      >
        <Zap size={14} /> Solo este día
      </button>
      <button
        class="mode-btn"
        class:active={!isTemporaryMode}
        onclick={() => isTemporaryMode = false}
      >
        <Calendar size={14} /> Plantilla semanal
      </button>
    </div>

    <!-- Override banner -->
    {#if isTemporaryMode && hasOverride}
      <div class="override-banner">
        <span class="banner-text">⚡ Cambios temporales activos</span>
        <div class="banner-actions">
          <button class="btn-banner btn-restore" onclick={restoreDefaultTemplate}>
            <RotateCcw size={14} /> Restaurar
          </button>
          <button class="btn-banner btn-save" onclick={saveAsPermanentTemplate}>
            <Save size={14} /> Aplicar a semana
          </button>
        </div>
      </div>
    {/if}
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
      {#each layoutActivities as activity (activity.id)}
        {@const totalSteps = activity.steps?.length || 0}
        {@const doneSteps = activity.steps?.filter(s => s.completed).length || 0}
        <div
          class="daily-activity-card glass-panel"
          class:is-short={activity.durationMins <= 20}
          role="button"
          tabindex="0"
          draggable="true"
          ondragstart={(e) => handleDragStart(e, activity)}
          oncontextmenu={(e) => handleContextMenu(e, activity.id!)}
          onclick={() => onEditActivity(activity.id!)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') onEditActivity(activity.id!); }}
          style="top: {activity.top}; height: {activity.height}; left: {activity.left}; width: {activity.width}; border-left-color: {getActivityColor(activity.categoryId, categories)}"
        >
          <div class="activity-content" class:compact={activity.durationMins <= 20}>
            <div class="activity-title-group">
              <span class="activity-name">{activity.name}</span>
              {#if activity.image}
                <button
                  type="button"
                  class="activity-image-thumb"
                  title="Ver imagen de la rutina"
                  onclick={(e) => { e.stopPropagation(); viewingImageActivity = activity; }}
                >
                  <img src={activity.image} alt="" />
                </button>
              {/if}
              {#if totalSteps > 0 && activity.durationMins > 20}
                <span class="activity-steps-badge" class:all-done={doneSteps === totalSteps && totalSteps > 0} title="{doneSteps} de {totalSteps} pasos completados">
                  <ListChecks size={12} /> {doneSteps}/{totalSteps}
                </span>
              {/if}
            </div>
            <button
              class="edit-btn"
              onclick={(e) => { e.stopPropagation(); onEditActivity(activity.id!); }}
              title="Editar actividad y ver pasos"
            >
              <Edit3 size={13} />
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
      {#if contextMenuActivity?.image}
        <button onclick={() => { viewingImageActivity = contextMenuActivity; }}>
          <ImageIcon size={16} /> Ver imagen
        </button>
      {/if}
      <button class="delete-btn" onclick={deleteActivity}>
        <Trash2 size={16} /> Eliminar
      </button>
    </div>
  {/if}

  {#if viewingImageActivity}
    <ImageLightbox activity={viewingImageActivity} onClose={() => viewingImageActivity = null} />
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
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.5rem;
    border-bottom: 1px solid rgba(0,0,0,0.05);
  }

  .header-top-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
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

  /* ── Mode Toggle ── */
  .mode-pill-toggle {
    display: flex;
    background: rgba(0,0,0,0.04);
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
    align-self: flex-start;
  }

  .mode-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.85rem;
    border: none;
    border-radius: 8px;
    background: transparent;
    font-size: 0.8rem;
    font-weight: 600;
    color: #888;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .mode-btn.active {
    background: white;
    color: var(--color-green-dark);
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }

  .mode-btn:hover:not(.active) {
    color: var(--color-brown-bark);
  }

  /* ── Override Banner ── */
  .override-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(245, 158, 11, 0.04));
    border: 1px solid rgba(245, 158, 11, 0.25);
    border-radius: 10px;
    padding: 0.6rem 1rem;
    animation: fadeIn 0.2s ease-out;
  }

  .banner-text {
    font-size: 0.82rem;
    font-weight: 600;
    color: #b45309;
  }

  .banner-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-banner {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.65rem;
    border: none;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .btn-restore {
    background: rgba(239, 68, 68, 0.1);
    color: #dc2626;
  }

  .btn-restore:hover {
    background: rgba(239, 68, 68, 0.2);
  }

  .btn-save {
    background: rgba(45, 90, 39, 0.1);
    color: var(--color-green-dark);
  }

  .btn-save:hover {
    background: rgba(45, 90, 39, 0.2);
  }

  .daily-container {
    flex: 1;
    position: relative;
    display: flex;
    margin: 1.5rem;
    overflow-y: auto;
    min-height: 1600px; /* Scale so 15-min tasks have ~25px and don't crowd */
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
    background: white;
    border-left: 5px solid;
    padding: 0.35rem 0.85rem;
    box-sizing: border-box;
    transition: transform 0.2s, box-shadow 0.2s, background 0.2s, top 0.25s ease, height 0.25s ease;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
    z-index: 1;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    cursor: grab;
  }

  .daily-activity-card:active {
    cursor: grabbing;
  }

  .daily-activity-card:hover {
    transform: translateX(4px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    z-index: 10;
    overflow: visible;
    background: #fdfdfd;
  }

  .daily-activity-card.is-short {
    padding: 0.1rem 0.6rem;
    border-left-width: 4px;
    border-radius: 6px;
  }

  .daily-activity-card.is-short .activity-name {
    font-size: 0.84rem;
  }

  .activity-content {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding-right: 2.25rem;
    box-sizing: border-box;
  }

  .activity-content.compact {
    padding-right: 1.6rem;
    gap: 0.4rem;
  }

  .activity-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .activity-name {
    font-weight: 700;
    font-size: 1rem;
    color: var(--text-main);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .activity-image-thumb {
    flex-shrink: 0;
    border: none;
    padding: 0;
    background: none;
    cursor: zoom-in;
    border-radius: 6px;
    overflow: hidden;
    width: 30px;
    height: 30px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
    transition: transform 0.15s;
  }

  .activity-image-thumb:hover {
    transform: scale(1.12);
  }

  .activity-image-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .activity-steps-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: rgba(45, 90, 39, 0.1);
    color: var(--color-green-dark);
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.15rem 0.4rem;
    border-radius: 6px;
    white-space: nowrap;
    border: 1px solid rgba(45, 90, 39, 0.15);
  }

  .activity-steps-badge.all-done {
    background: rgba(45, 90, 39, 0.2);
    color: var(--color-green-dark);
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

  @media (max-width: 768px) {
    .daily-header {
      padding: 1rem;
    }
    .daily-header h2 {
      font-size: 1.25rem;
    }
    .current-time-display {
      font-size: 0.8rem;
      padding: 0.35rem 0.75rem;
    }
    .daily-container {
      margin: 1rem 0.5rem;
    }
    .time-track {
      width: 55px;
    }
    .hour-marker {
      font-size: 0.7rem;
      padding-right: 0.35rem;
    }
    .activities-track {
      margin-left: 0.5rem;
    }
    .daily-activity-card {
      padding: 0.4rem 0.6rem;
    }
    .activity-content {
      padding-right: 2rem;
      gap: 0.5rem;
    }
    .activity-name {
      font-size: 0.9rem;
    }    .edit-btn {
      opacity: 0.85;
      padding: 0.25rem;
      right: 0.4rem;
    }
    .time-bar {
      left: -0.5rem;
    }
    .override-banner {
      flex-direction: column;
      align-items: flex-start;
    }
  }

  @media (max-width: 480px) {
    .daily-activity-card {
      padding: 0.3rem 0.5rem;
    }
    .activity-content {
      padding-right: 1.75rem;
      gap: 0.25rem;
    }
    .activity-name {
      font-size: 0.82rem;
    }    .time-track {
      width: 48px;
    }
    .hour-marker {
      font-size: 0.65rem;
      padding-right: 0.2rem;
    }
    .mode-btn {
      font-size: 0.72rem;
      padding: 0.35rem 0.6rem;
    }
  }
</style>

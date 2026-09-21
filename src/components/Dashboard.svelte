<script lang="ts">
  import { onMount } from 'svelte';
  import { db } from '../lib/db.ts';
  import type { Activity } from '../lib/types.ts';
  import { 
    activitiesStore, 
    categoriesStore, 
    settingsStore,
    dayOverridesStore,
    parseTime,
    formatTime
  } from '../lib/stores.ts';
  import WeeklyGrid from './WeeklyGrid.svelte';
  import DailyView from './DailyView.svelte';
  import DonutCharts from './DonutCharts.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import ActivityModal from './ActivityModal.svelte';
  import Toasts from './Toasts.svelte';
  import { toastErr } from '../lib/toast';
  import { Settings, Calendar, Clock, Plus, ChevronsUp, Cloud, CloudOff, RefreshCw } from 'lucide-svelte';
  import { onSyncChange, syncNow } from '../lib/sync';
  import type { SyncStatus } from '../lib/types';

  let currentView = $state('week'); // 'week' | 'day'

  // Estado de sincronización para el badge del header
  let syncStatus = $state<SyncStatus>('local');
  $effect(() => {
    const off = onSyncChange((s) => { syncStatus = s; });
    return off;
  });
  let selectedDay = $state(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1); // 0 = Mon, 6 = Sun
  
  let showSettings = $state(false);
  let showActivityModal = $state(false);
  let editingActivityId = $state<string | null>(null);
  let modalTargetDay = $state<number | null>(null);
  let initialActivityData = $state<Activity | null>(null);

  // Derive settings
  const settingsObj = $derived($settingsStore?.length ? $settingsStore.reduce((acc: any, s: any) => ({ ...acc, [s.key]: s.value }), { startHour: 7, endHour: 23 }) : { startHour: 7, endHour: 23 });

  function openActivityModal(id: string | null = null, day: number | null = null, initialData: Activity | null = null) {
    editingActivityId = id;
    modalTargetDay = day !== null ? day : (currentView === 'day' ? selectedDay : null);
    initialActivityData = initialData;
    showActivityModal = true;
  }

  function handleDaySelect(day: number) {
    selectedDay = day;
    currentView = 'day';
  }

  async function coverGapsAbove() {
    const startH = settingsObj.startHour;

    if (currentView === 'day') {
      const overrides = $state.snapshot($dayOverridesStore) || [];
      const currentOverride = overrides.find(o => o.day === selectedDay);

      if (currentOverride && currentOverride.activities?.length > 0) {
        const dayActs = currentOverride.activities.map(a => ({ ...a }));
        dayActs.sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));

        let prevEnd = startH;
        for (const act of dayActs) {
          const actStart = parseTime(act.startTime);
          if (actStart > prevEnd) {
            const duration = parseTime(act.endTime) - actStart;
            act.startTime = formatTime(prevEnd);
            act.endTime = formatTime(prevEnd + duration);
          }
          prevEnd = parseTime(act.endTime);
        }

        await db.dayOverrides.put({
          day: selectedDay,
          activities: dayActs,
          updatedAt: Date.now()
        });
        return;
      }
    }

    const list = $state.snapshot($activitiesStore) || [];
    if (list.length === 0) return;

    // Copy the activities to work with them
    const updatedActivities = list.map(a => ({ 
      ...a, 
      daysOfWeek: [...a.daysOfWeek] 
    }));

    // For each day, shift activities upwards to cover gaps above (preserving duration)
    for (let day = 0; day < 7; day++) {
      const dayActs = updatedActivities.filter(a => a.daysOfWeek.includes(day));
      dayActs.sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));

      let prevEnd = startH;
      for (const act of dayActs) {
        const actStart = parseTime(act.startTime);
        if (actStart > prevEnd) {
          const duration = parseTime(act.endTime) - actStart;
          act.startTime = formatTime(prevEnd);
          act.endTime = formatTime(prevEnd + duration);
        }
        prevEnd = parseTime(act.endTime);
      }
    }

    // Save changes to database
    try {
      await db.transaction('rw', db.activities, async () => {
        for (const act of updatedActivities) {
          const original = list.find(o => o.id === act.id);
          if (original && (original.startTime !== act.startTime || original.endTime !== act.endTime)) {
            await db.activities.update(act.id!, { 
              startTime: act.startTime,
              endTime: act.endTime,
              updatedAt: Date.now()
            });
          }
        }
      });
    } catch (err: any) {
      console.error('Failed to adjust activities:', err);
      toastErr('Error al ajustar las actividades: ' + (err.message || err));
    }
  }
</script>

<div class="dashboard">
  <!-- Top Navigation & Title -->
  <header class="dashboard-header glass-panel">
    <div class="header-left">
      <div class="logo">🌲 Nature Planner</div>
      <nav class="view-tabs" aria-label="Cambiar vista">
        <button class:active={currentView === 'week'} onclick={() => currentView = 'week'} aria-label="Ver semana" aria-pressed={currentView === 'week'}>
          <Calendar size={18} /> Semana
        </button>
        <button class:active={currentView === 'day'} onclick={() => currentView = 'day'} aria-label="Ver día" aria-pressed={currentView === 'day'}>
          <Clock size={18} /> Día
        </button>
      </nav>
    </div>
    <div class="header-right">
      <button class="btn btn-secondary" onclick={coverGapsAbove} aria-label="Ajustar todas las actividades para cubrir el espacio superior sobrante" title="Ajustar todas las actividades para cubrir el espacio superior sobrante">
        <ChevronsUp size={20} /> <span class="hide-mobile">Ajustar Arriba</span>
      </button>
      <button class="btn btn-plus" onclick={() => openActivityModal(null, currentView === 'day' ? selectedDay : null)} aria-label="Nueva Actividad">
        <Plus size={20} /> <span class="hide-mobile">Nueva Actividad</span>
      </button>
      {#if syncStatus !== 'local'}
        <button
          class="sync-badge"
          class:syncing={syncStatus === 'syncing'}
          class:error={syncStatus === 'error'}
          onclick={() => syncNow(true).catch(() => {})}
          title={syncStatus === 'synced' ? 'Sincronizado con la nube — clic para refrescar' : syncStatus === 'syncing' ? 'Sincronizando…' : syncStatus === 'offline' ? 'Sin conexión — se sincronizará al volver' : 'Error de sincronización — clic para reintentar'}
        >
          {#if syncStatus === 'synced'}<Cloud size={16} />
          {:else if syncStatus === 'syncing'}<RefreshCw size={16} />
          {:else}<CloudOff size={16} />{/if}
        </button>
      {/if}
      <button class="btn btn-secondary btn-icon" onclick={() => showSettings = true} aria-label="Abrir ajustes">
        <Settings size={20} />
      </button>
    </div>
  </header>

  {#if syncStatus === 'error' || syncStatus === 'offline'}
    <div class="sync-banner glass-panel" role="alert">
      <CloudOff size={16} />
      <span>{syncStatus === 'error' ? 'No se pudo sincronizar con la nube.' : 'Sin conexión: los cambios se guardan localmente.'}</span>
      <button class="sync-retry" onclick={() => syncNow(true).catch(() => {})}>Reintentar</button>
    </div>
  {/if}

  <main class="dashboard-main">
    <div class="view-container">
      {#if currentView === 'week'}
        <div class="week-layout">
          <div class="grid-section glass-panel">
            <WeeklyGrid 
              activities={$activitiesStore || []} 
              categories={$categoriesStore || []} 
              settings={settingsObj}
              dayOverrides={$dayOverridesStore || []}
              onSelectDay={handleDaySelect}
              onEditActivity={(id) => openActivityModal(id, null)}
            />
          </div>
          <div class="stats-section">
            <DonutCharts 
              activities={$activitiesStore || []} 
              categories={$categoriesStore || []} 
            />
          </div>
        </div>
      {:else}
        <div class="day-layout glass-panel">
          <DailyView 
            day={selectedDay}
            activities={$activitiesStore || []} 
            categories={$categoriesStore || []} 
            settings={settingsObj}
            dayOverrides={$dayOverridesStore || []}
            onEditActivity={(id, initialData) => openActivityModal(id, selectedDay, initialData)}
          />
        </div>
      {/if}
    </div>
  </main>

  <!-- Modals -->
  {#if showSettings}
    <SettingsPanel 
      settings={settingsObj} 
      categories={$categoriesStore || []}
      onClose={() => showSettings = false} 
    />
  {/if}

  {#if showActivityModal}
    <ActivityModal 
      id={editingActivityId}
      targetDay={modalTargetDay}
      initialData={initialActivityData}
      categories={$categoriesStore || []}
      settings={settingsObj}
      onClose={() => { showActivityModal = false; modalTargetDay = null; initialActivityData = null; }}
    />
  {/if}

  <Toasts />
</div>

<style>
  .dashboard {
    max-width: 1400px;
    margin: 0 auto;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-height: 100vh;
  }

  .dashboard-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 2rem;
  }

  .logo {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-green-dark);
  }

  .view-tabs {
    display: flex;
    background: rgba(92, 64, 51, 0.05);
    padding: 0.25rem;
    border-radius: 10px;
    gap: 0.25rem;
  }

  .view-tabs button {
    background: transparent;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .view-tabs button.active {
    background: white;
    color: var(--color-green-dark);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  }

  .header-right {
    display: flex;
    gap: 0.75rem;
  }

  /* Targets táctiles >= 42px en el header */
  .header-right .btn {
    min-height: 42px;
  }

  /* Banner de estado de sincronización */
  .sync-banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 1rem;
    border-radius: 12px;
    border: 1px solid rgba(224, 170, 68, 0.4);
    background: rgba(255, 244, 224, 0.92);
    color: #6b4d16;
    font-size: 0.88rem;
  }
  .sync-banner span { flex: 1; }
  .sync-retry {
    border: none;
    background: #2f6b3f;
    color: #f2f8f2;
    border-radius: 10px;
    padding: 0.45rem 0.9rem;
    min-height: 40px;
    font-weight: 600;
    cursor: pointer;
  }
  .sync-retry:hover { filter: brightness(1.1); }

  .sync-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid rgba(45, 90, 39, 0.25);
    color: var(--color-green-dark);
    border-radius: 50%;
    width: 42px;
    height: 42px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .sync-badge:hover {
    background: rgba(45, 90, 39, 0.08);
  }

  .sync-badge.syncing {
    animation: spin 1.2s linear infinite;
    pointer-events: none;
  }

  .sync-badge.error {
    color: #e53e3e;
    border-color: rgba(229, 62, 62, 0.4);
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .btn-plus {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-left: 0.75rem;
  }

  .btn-icon {
    padding: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .dashboard-main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .view-container {
    flex: 1;
  }

  .week-layout {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 1.5rem;
    height: 100%;
  }

  .grid-section {
    padding: 1rem;
    overflow-x: auto;
  }

  .stats-section {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  @media (max-width: 1024px) {
    .week-layout {
      grid-template-columns: 1fr;
    }
    /* Donuts primero en pantallas angostas: resumen visible sin scroll largo */
    .stats-section {
      order: -1;
      flex-direction: row;
      flex-wrap: wrap;
    }
  }

  @media (max-width: 768px) {
    .dashboard {
      padding: 0.75rem;
      gap: 1rem;
    }
    .dashboard-header {
      padding: 0.75rem 1rem;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .header-left {
      width: 100%;
      justify-content: space-between;
      gap: 1rem;
    }
    .header-right {
      width: 100%;
      justify-content: flex-end;
      gap: 0.5rem;
    }
    .grid-section {
      padding: 0.5rem;
    }
  }

  @media (max-width: 640px) {
    .hide-mobile {
      display: none;
    }
    .btn-plus {
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
  }

  @media (max-width: 420px) {
    .logo {
      font-size: 1.1rem;
    }
    .view-tabs button {
      padding: 0.35rem 0.6rem;
      font-size: 0.8rem;
    }
  }
</style>

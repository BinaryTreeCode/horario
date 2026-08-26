<script lang="ts">
  import { onMount } from 'svelte';
  import { db } from '../lib/db.ts';
  import { 
    activitiesStore, 
    categoriesStore, 
    settingsStore,
    parseTime,
    formatTime
  } from '../lib/stores.ts';
  import WeeklyGrid from './WeeklyGrid.svelte';
  import DailyView from './DailyView.svelte';
  import DonutCharts from './DonutCharts.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import ActivityModal from './ActivityModal.svelte';
  import { Settings, Calendar, Clock, Plus, ChevronsUp } from 'lucide-svelte';

  let currentView = $state('week'); // 'week' | 'day'
  let selectedDay = $state(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1); // 0 = Mon, 6 = Sun
  
  let showSettings = $state(false);
  let showActivityModal = $state(false);
  let editingActivityId = $state<number | null>(null);

  // Derive settings
  const settingsObj = $derived($settingsStore?.length ? $settingsStore.reduce((acc: any, s: any) => ({ ...acc, [s.key]: s.value }), { startHour: 7, endHour: 23 }) : { startHour: 7, endHour: 23 });

  function openActivityModal(id: number | null = null) {
    editingActivityId = id;
    showActivityModal = true;
  }

  function handleDaySelect(day: number) {
    selectedDay = day;
    currentView = 'day';
  }

  async function coverGapsAbove() {
    const list = $state.snapshot($activitiesStore) || [];
    if (list.length === 0) return;

    const startH = settingsObj.startHour;
    
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
              endTime: act.endTime 
            });
          }
        }
      });
      console.log('Successfully adjusted all activities by shifting them upwards');
    } catch (err: any) {
      console.error('Failed to adjust activities:', err);
      alert('Error al ajustar las actividades: ' + (err.message || err));
    }
  }
</script>

<div class="dashboard">
  <!-- Top Navigation & Title -->
  <header class="dashboard-header glass-panel">
    <div class="header-left">
      <div class="logo">🌲 Nature Planner</div>
      <nav class="view-tabs">
        <button class:active={currentView === 'week'} onclick={() => currentView = 'week'}>
          <Calendar size={18} /> Semana
        </button>
        <button class:active={currentView === 'day'} onclick={() => currentView = 'day'}>
          <Clock size={18} /> Día
        </button>
      </nav>
    </div>
    <div class="header-right">
      <button class="btn btn-secondary" onclick={coverGapsAbove} title="Ajustar todas las actividades para cubrir el espacio superior sobrante">
        <ChevronsUp size={20} /> <span class="hide-mobile">Ajustar Arriba</span>
      </button>
      <button class="btn btn-plus" onclick={() => openActivityModal()}>
        <Plus size={20} /> <span class="hide-mobile">Nueva Actividad</span>
      </button>
      <button class="btn btn-secondary btn-icon" onclick={() => showSettings = true}>
        <Settings size={20} />
      </button>
    </div>
  </header>

  <main class="dashboard-main">
    <div class="view-container">
      {#if currentView === 'week'}
        <div class="week-layout">
          <div class="grid-section glass-panel">
            <WeeklyGrid 
              activities={$activitiesStore || []} 
              categories={$categoriesStore || []} 
              settings={settingsObj}
              onSelectDay={handleDaySelect}
              onEditActivity={openActivityModal}
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
            onEditActivity={openActivityModal}
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
      categories={$categoriesStore || []}
      settings={settingsObj}
      onClose={() => showActivityModal = false}
    />
  {/if}
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
    .stats-section {
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

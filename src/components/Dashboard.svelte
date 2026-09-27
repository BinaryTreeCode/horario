<script lang="ts">
    import { db } from '../lib/db';
  import type { Activity } from '../lib/types';
  import { 
    activitiesStore, 
    categoriesStore, 
    settingsStore,
    dayOverridesStore,
    parseTime,
    formatTime
  } from '../lib/stores';
  import WeeklyGrid from './WeeklyGrid.svelte';

  import Toasts from './Toasts.svelte';
  import { toastOk, toastErr } from '../lib/toast';
  import { undoStack } from '../lib/undo';
  import { Settings, Calendar, Clock, Plus, ChevronsUp, Cloud, CloudOff, RefreshCw } from '@lucide/svelte';
  import { onSyncChange, syncNow } from '../lib/sync';
  import { t } from '../lib/i18n';
  import type { SyncStatus } from '../lib/types';

  let currentView = $state('week'); // 'week' | 'day'

  // ── Deshacer global (Ctrl+Z / ⌘Z) ───────────────────────────────────
  let stackCount = 0;
  undoStack.subscribe(s => { stackCount = s.length; });

  function isTextEntryTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onUndoKeydown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    // Guards: el modal de actividad ya tiene Ctrl+Z nativo en sus inputs, y
    // deshacer BD por debajo del form abierto sería confuso.
    if (showActivityModal || showSettings || isTextEntryTarget(e.target)) return;
    const redo = e.shiftKey;
    e.preventDefault();
    // pop del op + ejecución en chunk diferido (undoRun no va al bundle inicial)
    import('../lib/undoRun')
      .then(m => (redo ? m.popAndRedo() : m.popAndUndo()))
      .then(label => { if (label) toastOk(redo ? `↻ ${label}` : tNow('toast.undone', { label })); })
      .catch(err => toastErr(tNow('toast.couldNotMove') + ': ' + (err?.message || err)));
  }

  $effect(() => {
    window.addEventListener('keydown', onUndoKeydown);
    return () => window.removeEventListener('keydown', onUndoKeydown);
  });

  // Estado de sincronización para el badge del header
  let syncStatus = $state<SyncStatus>('local');
  $effect(() => {
    const off = onSyncChange((s) => { syncStatus = s; });
    return off;
  });

  let selectedDay = $state(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1); // 0 = Mon, 6 = Sun

  // Precarga de modales cuando el navegador queda idle
  $effect(() => {
    preloadModals();
    loadDonutCharts(); // los donuts salen del chunk inicial (lazy como los modales)
    loadDailyView(); // la vista Día es excluyente con la Semana: precarga idle
  });
  
  let showSettings = $state(false);
  let showActivityModal = $state(false);

  // Code-splitting: los modales solo bajan del bundle cuando se abren por
  // primera vez (−40 KB del camino crítico). Tras el idle se precargan.
  let SettingsPanelComp: typeof import('./SettingsPanel.svelte').default | null = $state(null);
  let ActivityModalComp: typeof import('./ActivityModal.svelte').default | null = $state(null);
  let DonutChartsComp: typeof import('./DonutCharts.svelte').default | null = $state(null);
  let DailyViewComp: typeof import('./DailyView.svelte').default | null = $state(null);

  let loadPromiseSettings: Promise<void> | null = $state(null);
  let loadPromiseDonut: Promise<void> | null = $state(null);
  let loadPromiseActivity: Promise<void> | null = $state(null);
  let loadPromiseDaily: Promise<void> | null = $state(null);

  function loadSettingsPanel() {
    loadPromiseSettings ??= (async () => {
      SettingsPanelComp = (await import('./SettingsPanel.svelte')).default;
    })();
    return loadPromiseSettings;
  }
  function loadActivityModal() {
    loadPromiseActivity ??= (async () => {
      ActivityModalComp = (await import('./ActivityModal.svelte')).default;
    })();
    return loadPromiseActivity;
  }
  function loadDonutCharts() {
    loadPromiseDonut ??= (async () => {
      DonutChartsComp = (await import('./DonutCharts.svelte')).default;
    })();
    return loadPromiseDonut;
  }
  function loadDailyView() {
    loadPromiseDaily ??= (async () => {
      DailyViewComp = (await import('./DailyView.svelte')).default;
    })();
    return loadPromiseDaily;
  }
  function openSettings() {
    showSettings = true;
    loadSettingsPanel();
  }
  function preloadModals() {
    ('requestIdleCallback' in window ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 2000))(() => {
      loadSettingsPanel();
      loadActivityModal();
    });
  }
  let editingActivityId = $state<string | null>(null);
  let modalTargetDay = $state<number | null>(null);
  let initialActivityData = $state<Activity | null>(null);

  // Derive settings
  const settingsObj = $derived($settingsStore?.length ? $settingsStore.reduce((acc: any, s: any) => ({ ...acc, [s.key]: s.value }), { startHour: 7, endHour: 23 }) : { startHour: 7, endHour: 23 });

  function openActivityModal(id: string | null = null, day: number | null = null, initialData: Activity | null = null) {
    loadActivityModal();
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
      toastErr(tNow('toast.couldNotMove') + ': ' + (err.message || err));
    }
  }
</script>

<div class="dashboard">
  <!-- Top Navigation & Title -->
  <header class="dashboard-header glass-panel">
    <div class="header-left">
      <div class="logo">🌲 {$t('app.name')}</div>
      <nav class="view-tabs" aria-label="{$t('header.viewWeek')} / {$t('header.viewDay')}">
        <button class:active={currentView === 'week'} onclick={() => currentView = 'week'} aria-label={$t('header.viewWeek')} aria-pressed={currentView === 'week'}>
          <Calendar size={18} /> {$t('header.week')}
        </button>
        <button class:active={currentView === 'day'} onclick={() => currentView = 'day'} aria-label={$t('header.viewDay')} aria-pressed={currentView === 'day'}>
          <Clock size={18} /> {$t('header.day')}
        </button>
      </nav>
    </div>
    <div class="header-right">
      <button class="btn btn-secondary" onclick={coverGapsAbove} aria-label={$t('header.adjustUp')} title={$t('header.adjustUpTitle')}>
        <ChevronsUp size={20} /> <span class="hide-mobile">{$t('header.adjustUp')}</span>
      </button>
      <button class="btn btn-plus" onclick={() => openActivityModal(null, currentView === 'day' ? selectedDay : null)} aria-label={$t('header.newActivity')}>
        <Plus size={20} /> <span class="hide-mobile">{$t('header.newActivity')}</span>
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
      <button class="btn btn-secondary btn-icon" onclick={openSettings} aria-label={$t('header.settings')}>
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
            {#if DonutChartsComp}
              <DonutChartsComp
                activities={$activitiesStore || []}
                categories={$categoriesStore || []}
              />
            {/if}
          </div>
        </div>
      {:else}
        <div class="day-layout glass-panel">
          {#if DailyViewComp}
            <DailyViewComp 
              day={selectedDay}
              activities={$activitiesStore || []} 
              categories={$categoriesStore || []} 
              settings={settingsObj}
              dayOverrides={$dayOverridesStore || []}
              onEditActivity={(id, initialData) => openActivityModal(id, selectedDay, initialData)}
            />
          {:else}
            <div class="modal-loading" role="status">Cargando vista del día…</div>
          {/if}
        </div>
      {/if}
    </div>
  </main>

  <!-- Modals -->
  {#if showSettings}
    {#await loadPromiseSettings ?? Promise.resolve()}
      <div class="modal-loading" role="status">Cargando ajustes…</div>
    {:then}
      {#if SettingsPanelComp}
        <SettingsPanelComp
          settings={settingsObj}
          categories={$categoriesStore || []}
          onClose={() => showSettings = false}
        />
      {/if}
    {/await}
  {/if}

  {#if showActivityModal}
    {#await loadPromiseActivity ?? Promise.resolve()}
      <div class="modal-loading" role="status">Cargando…</div>
    {:then}
      {#if ActivityModalComp}
        <ActivityModalComp
          id={editingActivityId}
          targetDay={modalTargetDay}
          initialData={initialActivityData}
          categories={$categoriesStore || []}
          settings={settingsObj}
          onClose={() => { showActivityModal = false; modalTargetDay = null; initialActivityData = null; }}
        />
      {/if}
    {/await}
  {/if}

  <!-- (FAB móvil retirado a pedido del usuario: tapaba la última columna de
       la grilla semanal. La creación vive en el botón del header y en el
       tap sobre un hueco de la vista Día.) -->

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
    padding-top: calc(1rem + env(safe-area-inset-top, 0px));
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
    padding: 0.6rem 1rem;
    min-height: 44px;
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
  .modal-loading {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    z-index: 2000;
    color: var(--color-green-dark, #2f6b3f);
    font-size: 0.95rem;
    background: rgba(240, 246, 240, 0.6);
    backdrop-filter: blur(2px);
  }

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
    /* El horario es lo primario en móvil: los donuts van después, no antes */
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
    /* Regla dura #5: los .btn medían 42px reales (line-height recortaba el min-height). */
    .dashboard-header :global(.btn) {
      min-height: 44px;
      line-height: 1;
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
    /* G9: en landscape corto el header se come la mitad de la pantalla —
       compactar a solo íconos (los textos quedan en aria-label) y permitir
       que left/right compartan una sola fila (los width:100% fuerzan 2 filas).
       Va DESPUÉS de las reglas base: misma especificidad, gana el orden. */
    @media (orientation: landscape) and (max-height: 420px) {
      .dashboard-header {
        padding: 0.4rem 1rem;
        padding-top: calc(0.4rem + env(safe-area-inset-top, 0px));
        gap: 0.5rem;
      }
      .hide-mobile {
        display: none;
      }
      .logo {
        font-size: 0.95rem;
      }
      .dashboard-header :global(.btn) {
        /* regla dura #5: nunca por debajo de 44px ni en landscape corto */
        min-height: 44px;
        padding: 0.3rem 0.6rem;
      }
      .view-tabs button {
        padding: 0.35rem 0.5rem;
        font-size: 0.8rem;
      }
      .header-left,
      .header-right {
        width: auto;
      }
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

  /* (G5: FAB flotante retirado a pedido del usuario — tapaba la última
     columna de la grilla. Sin reemplazo: el botón "Nueva Actividad" del
     header y el tap en hueco de la vista Día cubren la creación.) */
</style>

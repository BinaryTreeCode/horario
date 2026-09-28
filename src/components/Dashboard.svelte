<script lang="ts">
    import { db, descargarRespaldo } from '../lib/db';
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
  import { undoStack, cloneAct } from '../lib/undo';
  import { Settings, Calendar, Clock, Plus, ChevronsUp, ChevronsDown, ArrowUp, ArrowDown, Download, Upload, Cloud, CloudOff, RefreshCw } from '@lucide/svelte';
  import { onSyncChange, syncNow } from '../lib/sync';
  import { t, tNow } from '../lib/i18n';
  import { modoPrivacidad, alternarPrivacidad } from '../lib/privacy';
  import { Eye, EyeOff } from '@lucide/svelte';
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

  /** Exportar desde la sidebar: descarga el respaldo JSON con toast de éxito/error. */
  async function exportarDesdeSidebar() {
    try {
      await descargarRespaldo();
      toastOk(tNow('sidebar.exported'));
    } catch (err: any) {
      toastErr(tNow('settings.exportError', { msg: err?.message || err }));
    }
  }

  /** Importar desde la sidebar: abre Ajustes donde vive el flujo con confirmación. */
  function openSettingsParaImportar() {
    openSettings();
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

  /** Espejo de coverGapsAbove: empuja todo hacia endHour preservando los
   *  huecos ENTRE actividades (elimina solo el espacio libre inferior). */
  async function coverGapsBelow() {
    const endH = settingsObj.endHour;

    if (currentView === 'day') {
      const overrides = $state.snapshot($dayOverridesStore) || [];
      const currentOverride = overrides.find(o => o.day === selectedDay);

      if (currentOverride && currentOverride.activities?.length > 0) {
        const dayActs = currentOverride.activities.map(a => ({ ...a }));
        dayActs.sort((a, b) => parseTime(b.endTime) - parseTime(a.endTime)); // desde la última

        let nextStart = endH;
        for (const act of dayActs) {
          const actEnd = parseTime(act.endTime);
          if (actEnd < nextStart) {
            const duration = actEnd - parseTime(act.startTime);
            act.startTime = formatTime(nextStart - duration);
            act.endTime = formatTime(nextStart);
          }
          nextStart = parseTime(act.startTime);
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

    const updatedActivities = list.map(a => ({
      ...a,
      daysOfWeek: [...a.daysOfWeek]
    }));

    // Por día: desde la última actividad hacia atrás, pegada al final del día.
    for (let day = 0; day < 7; day++) {
      const dayActs = updatedActivities.filter(a => a.daysOfWeek.includes(day));
      dayActs.sort((a, b) => parseTime(b.endTime) - parseTime(a.endTime));

      let nextStart = endH;
      for (const act of dayActs) {
        const actEnd = parseTime(act.endTime);
        if (actEnd < nextStart) {
          const duration = actEnd - parseTime(act.startTime);
          act.startTime = formatTime(nextStart - duration);
          act.endTime = formatTime(nextStart);
        }
        nextStart = parseTime(act.startTime);
      }
    }

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

  /**
   * Subir/Bajar TODO como bloque: desplaza todas las actividades ±deltaH
   * conservando los huecos ENTRE ellas. En vista Día opera sobre el override
   * temporal del día; en Semana sobre la plantilla (cada actividad se mueve en
   * TODOS sus días). Si algún bloque resultante desborda el rango del día →
   * ⛔ y nada se escribe (mismo contrato que el nudge de teclado).
   */
  async function shiftAll(deltaH: number) {
    const startH = settingsObj.startHour;
    const endH = settingsObj.endHour;
    const stamp = Date.now();
    const snap = (v: number) => Math.round(v * 4) / 4; // cuantía de 15 min

    if (currentView === 'day') {
      const overrides = $state.snapshot($dayOverridesStore) || [];
      const currentOverride = overrides.find(o => o.day === selectedDay);
      const acts = (currentOverride?.activities?.length
        ? currentOverride.activities.map(a => ({ ...a }))
        : ($state.snapshot($activitiesStore) || []).filter((a: Activity) => a.daysOfWeek.includes(selectedDay)).map((a: Activity) => ({ ...a })))
        .filter((a: any) => !a.deletedAt);
      if (acts.length === 0) return;

      const { commitCambios } = await import('../lib/commit');
      // Validación: el bloque entero debe caber en el rango del día.
      let minStart = Infinity, maxEnd = -Infinity;
      for (const a of acts) {
        minStart = Math.min(minStart, parseTime(a.startTime));
        maxEnd = Math.max(maxEnd, parseTime(a.endTime));
      }
      const newMin = snap(minStart + deltaH);
      const newMax = snap(maxEnd + deltaH);
      if (newMin < startH - 1e-9 || newMax > endH + 1e-9) {
        toastErr('⛔ No cabe: el bloque desbordaría el día');
        return;
      }
      for (const a of acts) {
        a.startTime = formatTime(snap(parseTime(a.startTime) + deltaH));
        a.endTime = formatTime(snap(parseTime(a.endTime) + deltaH));
      }
      await commitCambios({
        label: `${tNow('header.shiftUp')} / ${tNow('header.shiftDown')}`,
        ovs: [{ day: selectedDay, activities: acts }]
      });
      return;
    }

    // Vista Semana: plantilla master, cada actividad en TODOS sus días.
    const list = ($state.snapshot($activitiesStore) || []).filter((a: any) => !a.deletedAt);
    if (list.length === 0) return;

    let minStart = Infinity, maxEnd = -Infinity;
    for (const a of list) {
      minStart = Math.min(minStart, parseTime(a.startTime));
      maxEnd = Math.max(maxEnd, parseTime(a.endTime));
    }
    const newMin = snap(minStart + deltaH);
    const newMax = snap(maxEnd + deltaH);
    if (newMin < startH - 1e-9 || newMax > endH + 1e-9) {
      toastErr('⛔ No cabe: el bloque desbordaría el día');
      return;
    }

    const acts: Activity[] = [];
    for (const before of list) {
      const t0 = formatTime(snap(parseTime(before.startTime) + deltaH));
      const t1 = formatTime(snap(parseTime(before.endTime) + deltaH));
      if (t0 !== before.startTime || t1 !== before.endTime) {
        acts.push({ ...cloneAct(before), startTime: t0, endTime: t1 });
      }
    }
    if (acts.length === 0) return;
    try {
      const { commitCambios } = await import('../lib/commit');
      await commitCambios({
        label: tNow('header.shiftUp') + ' / ' + tNow('header.shiftDown'),
        acts
      });
    } catch (err: any) {
      toastErr(tNow('toast.couldNotMove') + ': ' + (err.message || err));
    }
  }
</script>

<div class="dashboard" class:privacy-mode={$modoPrivacidad}>
  <!-- Top Navigation & Title -->
  <header class="dashboard-header glass-panel">
    <div class="header-left">
      <h1 class="logo">🌲 {$t('app.name')}</h1>
      <nav class="view-tabs" aria-label="{$t('header.viewWeek')} / {$t('header.viewDay')}">
        <!-- Pestañas semánticas: role=tablist/tab + aria-selected (los lectores anuncian "pestaña", no "botón pulsado") -->
        <div class="view-tabs-inner" role="tablist">
          <button
            role="tab"
            id="tab-week"
            aria-selected={currentView === 'week'}
            aria-controls="view-panel"
            class:active={currentView === 'week'}
            onclick={() => currentView = 'week'}
            aria-label={$t('header.viewWeek')}
          >
            <Calendar size={18} /> {$t('header.week')}
          </button>
          <button
            role="tab"
            id="tab-day"
            aria-selected={currentView === 'day'}
            aria-controls="view-panel"
            class:active={currentView === 'day'}
            onclick={() => currentView = 'day'}
            aria-label={$t('header.viewDay')}
          >
            <Clock size={18} /> {$t('header.day')}
          </button>
        </div>
      </nav>
    </div>
    <div class="header-right">
      <!-- Acciones del header: visibles en móvil/tablet siempre, y en desktop
           solo en Semana (en Día viven en la barra lateral dentro del panel). -->
      <div class="header-actions" class:header-actions-hidden-desktop={currentView === 'day'}>
        <button class="btn btn-secondary" onclick={coverGapsAbove} aria-label={$t('header.adjustUp')} title={$t('header.adjustUpTitle')}>
          <ChevronsUp size={20} /> <span class="hide-mobile">{$t('header.adjustUp')}</span>
        </button>
        <button class="btn btn-secondary" onclick={coverGapsBelow} aria-label={$t('header.adjustDown')} title={$t('header.adjustDownTitle')}>
          <ChevronsDown size={20} /> <span class="hide-mobile">{$t('header.adjustDown')}</span>
        </button>
        <button class="btn btn-secondary btn-icon" onclick={() => shiftAll(-0.25)} aria-label={$t('header.shiftUp')} title={$t('header.shiftAllTitle', { scope: currentView === 'day' ? $t('header.shiftScopeDay') : $t('header.shiftScopeWeek') })}>
          <ArrowUp size={20} />
        </button>
        <button class="btn btn-secondary btn-icon" onclick={() => shiftAll(0.25)} aria-label={$t('header.shiftDown')} title={$t('header.shiftAllTitle', { scope: currentView === 'day' ? $t('header.shiftScopeDay') : $t('header.shiftScopeWeek') })}>
          <ArrowDown size={20} />
        </button>
        <button class="btn btn-plus" onclick={() => openActivityModal(null, currentView === 'day' ? selectedDay : null)} aria-label={$t('header.newActivity')}>
          <Plus size={20} /> <span class="hide-mobile">{$t('header.newActivity')}</span>
        </button>
        <!-- Modo privacidad: desenfoca el contenido de las actividades (mirones/capturas) -->
        <button
          class="btn btn-secondary btn-icon"
          class:privacy-on={$modoPrivacidad}
          onclick={alternarPrivacidad}
          aria-label={$t('header.privacy')}
          aria-pressed={$modoPrivacidad}
          title={$t('header.privacy')}
        >
          {#if $modoPrivacidad}<EyeOff size={20} />{:else}<Eye size={20} />{/if}
        </button>
        <button class="btn btn-secondary btn-icon" onclick={openSettings} aria-label={$t('header.settings')}>
          <Settings size={20} />
        </button>
      </div>
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
    <div class="view-container" id="view-panel" role="tabpanel" aria-labelledby={currentView === 'week' ? 'tab-week' : 'tab-day'}>
      {#if currentView === 'week'}
        <div class="week-layout">
          <div class="grid-section glass-panel">
            <WeeklyGrid 
              activities={$activitiesStore || []} 
              categories={$categoriesStore || []} 
              settings={settingsObj}
              dayOverrides={$dayOverridesStore || []}
              onSelectDay={handleDaySelect}
              onEditActivity={(id, _initialData) => openActivityModal(id, null, _initialData)}
            />
          </div>
          <div class="stats-section">
            {#if DonutChartsComp}
              <DonutChartsComp
                activities={$activitiesStore || []}
                categories={$categoriesStore || []}
                settings={settingsObj}
              />
            {/if}
          </div>
        </div>
      {:else}
        <!-- Vista Día (solo desktop): la barra de acciones vive DENTRO del panel,
             a la derecha; el horario corre un poco a la izquierda para hacerle
             lugar. En móvil la barra no existe (header manda) y el panel es uno. -->
        <div class="day-layout glass-panel">
          {#if DailyViewComp}
            <div class="day-view-host">
              <DailyViewComp 
                day={selectedDay}
                activities={$activitiesStore || []} 
                categories={$categoriesStore || []} 
                settings={settingsObj}
                dayOverrides={$dayOverridesStore || []}
                onEditActivity={(id, initialData) => openActivityModal(id, selectedDay, initialData)}
              />
            </div>
            <aside class="actions-sidebar" aria-label={$t('header.settings')}>
              <button class="side-btn" onclick={coverGapsAbove} title={$t('header.adjustUpTitle')} aria-label={$t('header.adjustUp')}>
                <ChevronsUp size={20} />
                <span>{$t('header.adjustUp')}</span>
              </button>
              <button class="side-btn" onclick={coverGapsBelow} title={$t('header.adjustDownTitle')} aria-label={$t('header.adjustDown')}>
                <ChevronsDown size={20} />
                <span>{$t('header.adjustDown')}</span>
              </button>
              <div class="side-sep" role="presentation"></div>
              <button class="side-btn" onclick={() => shiftAll(-0.25)} title={$t('header.shiftAllTitle', { scope: $t('header.shiftScopeDay') })} aria-label={$t('header.shiftUp')}>
                <ArrowUp size={20} />
                <span>{$t('header.shiftUp')}</span>
              </button>
              <button class="side-btn" onclick={() => shiftAll(0.25)} title={$t('header.shiftAllTitle', { scope: $t('header.shiftScopeDay') })} aria-label={$t('header.shiftDown')}>
                <ArrowDown size={20} />
                <span>{$t('header.shiftDown')}</span>
              </button>
              <button class="side-btn side-btn-primary" onclick={() => openActivityModal(null, selectedDay)} aria-label={$t('header.newActivity')}>
                <Plus size={20} />
                <span>{$t('header.newActivity')}</span>
              </button>
              <button
                class="side-btn"
                class:privacy-on={$modoPrivacidad}
                onclick={alternarPrivacidad}
                aria-label={$t('header.privacy')}
                aria-pressed={$modoPrivacidad}
                title={$t('header.privacy')}
              >
                {#if $modoPrivacidad}<EyeOff size={20} />{:else}<Eye size={20} />{/if}
                <span>{$t('header.privacyShort')}</span>
              </button>
              <button class="side-btn" onclick={openSettings} aria-label={$t('header.settings')} title={$t('header.settings')}>
                <Settings size={20} />
                <span>{$t('header.settings')}</span>
              </button>
              <div class="side-sep" role="presentation"></div>
              <!-- Subir/bajar datos: exportar descarga el JSON directo; importar abre
                   Ajustes (el import pide confirmación y vive en su sección de respaldo) -->
              <button class="side-btn" onclick={exportarDesdeSidebar} title={$t('sidebar.exportTitle')} aria-label={$t('sidebar.export')}>
                <Download size={20} />
                <span>{$t('sidebar.export')}</span>
              </button>
              <button class="side-btn" onclick={openSettingsParaImportar} title={$t('sidebar.importTitle')} aria-label={$t('sidebar.import')}>
                <Upload size={20} />
                <span>{$t('sidebar.import')}</span>
              </button>
            </aside>
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
    /* Escalado por ancho de pantalla: 1400px de piso en desktop común,
       1560px en pantallas grandes y 1800px en ultrawide (2560+) para que
       el contenido crezca con la pantalla en vez de dejar franjas muertas
       a los lados (QHD/21:9). clamp fluido: nada brusco entre breakpoints. */
    max-width: clamp(1400px, 78vw, 1800px);
    /* width 100%: sin esto, siendo grid item de .app-layout con margin auto,
       el navegador lo encoge a fit-content y el clamp no llega a usarse. */
    width: 100%;
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
    /* h1: neutralizar el estilo de agente de usuario y mantener el aspecto previo */
    margin: 0;
  }

  .view-tabs {
    display: flex;
    background: rgba(92, 64, 51, 0.05);
    padding: 0.25rem;
    border-radius: 10px;
    gap: 0.25rem;
  }

  /* role=tablist exige layout flex en el CONTENEDOR con role (no en el nav) */
  .view-tabs-inner {
    display: flex;
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

  /* Targets táctiles >= 44px en el header (regla dura #5) */
  .header-right .btn {
    min-height: 44px;
    min-width: 44px;
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
    /* Target táctil completo aunque el icono sea pequeño */
    min-width: 44px;
    min-height: 44px;
  }

  /* Modo privacidad activo: el ojo cerrado se destaca (fondo verde, no gris)
     para que se vea de un vistazo que el contenido está oculto. */
  .btn-icon.privacy-on {
    background: var(--color-green-dark);
    color: white;
  }
  .btn-icon.privacy-on:hover {
    background: var(--color-green-moss);
  }

  .dashboard-main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  /* ── Barra lateral de acciones (solo ≥1024px, SOLO vista Día) ──
     En Día vive DENTRO del panel, a la derecha del horario; en Semana las
     acciones vuelven al header y la barra no existe. En móvil nunca se
     muestra: las acciones quedan en el header en ambas vistas. */
  .actions-sidebar {
    display: none;
  }

  /* En desktop con vista Día el header queda solo con logo/pestañas/sync */
  @media (min-width: 1024px) {
    .header-actions-hidden-desktop {
      display: none;
    }
  }

  @media (min-width: 1024px) {
    .day-layout {
      display: flex;
      align-items: flex-start;
      gap: 0.9rem;
    }
    /* El horario cede ~190px: corre a la izquierda para que la barra entre
       sin apretarlo de más (min-width 0 permite encoger). */
    .day-view-host {
      flex: 1;
      min-width: 0;
    }
    .actions-sidebar {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      width: 172px;
      flex-shrink: 0;
      padding: 0.75rem 0.6rem;
      position: sticky;
      top: 1.5rem;
      align-self: flex-start;
    }
  }

  .side-btn {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    min-height: 44px;
    padding: 0.55rem 0.7rem;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: var(--color-brown-bark);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s, color 0.15s;
  }
  .side-btn:hover {
    background: rgba(92, 64, 51, 0.08);
  }
  .side-btn:focus-visible {
    outline: 2px solid var(--color-green-dark);
    outline-offset: 2px;
  }
  .side-btn-primary {
    background: var(--color-green-dark);
    color: white;
  }
  .side-btn-primary:hover {
    background: var(--color-green-moss);
  }
  .side-btn.privacy-on {
    background: var(--color-green-dark);
    color: white;
  }
  .side-btn.privacy-on:hover {
    background: var(--color-green-moss);
  }
  .side-btn span {
    /* Los labels largos no rompen la barra: una línea, ellipsis */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Separador entre acciones de compactar y de desplazamiento en bloque */
  .side-sep {
    height: 1px;
    margin: 0.35rem 0.4rem;
    background: rgba(92, 64, 51, 0.14);
  }

  .view-container {
    flex: 1;
  }

  .week-layout {
    display: grid;
    /* Sidebar de donuts fluida: 320px de piso, 360px en pantallas grandes —
       en ultrawide la grilla semanal se queda el resto (igual legible). */
    grid-template-columns: 1fr clamp(320px, 24vw, 360px);
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

  /* ── Pantallas grandes / ultrawide (≥1536px) ──
     Tipografía y aire del header suben un punto para acompañar el ancho:
     en 21:9 el header quedaba enano frente a 2 metros de grilla. */
  @media (min-width: 1536px) {
    .dashboard {
      padding: 2rem;
      gap: 2rem;
    }
    .logo {
      font-size: 1.4rem;
    }
    .dashboard-header {
      padding: 1.1rem 1.75rem;
    }
    .view-tabs button {
      font-size: 0.95rem;
      padding: 0.6rem 1.25rem;
    }
    .dashboard-header :global(.btn) {
      font-size: 0.95rem;
    }
  }

  /* Ultrawide real (≥2200px, 21:9 QHD+): un punto más de escala sin pasarse —
     la app es mobile-first, no convertimos el header en un banner. */
  @media (min-width: 2200px) {
    .dashboard {
      padding: 2.5rem;
    }
    .logo {
      font-size: 1.55rem;
    }
    .dashboard-header {
      padding: 1.25rem 2rem;
    }
    .view-tabs button {
      font-size: 1rem;
      padding: 0.65rem 1.4rem;
    }
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

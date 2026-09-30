<script lang="ts">
    import { db, exportarRespaldoBinario, leerUltimoRespaldo } from '../lib/db';
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
  import { undoStack, redoStack } from '../lib/undo';
  import { Settings, Calendar, Clock, Plus, ChevronsUp, ChevronsDown, Undo2, Redo2, Download, Upload, Cloud, CloudOff, RefreshCw } from '@lucide/svelte';
  import { portal } from '../lib/portal';
  import { onSyncChange, syncNow } from '../lib/sync';
  import { t, tNow, idioma } from '../lib/i18n';
  import { modoPrivacidad, alternarPrivacidad } from '../lib/privacy';
  import { Eye, EyeOff } from '@lucide/svelte';
  import type { SyncStatus } from '../lib/types';

  let currentView = $state('week'); // 'week' | 'day'

  // ── Deshacer global (Ctrl+Z / ⌘Z) ───────────────────────────────────
  let stackCount = $state(0);
  let redoCount = $state(0);
  undoStack.subscribe(s => { stackCount = s.length; });
  redoStack.subscribe(s => { redoCount = s.length; });

  /** Ejecuta deshacer/rehacer (compartido por teclado y botones del header). */
  function ejecutarUndo(redo: boolean) {
    // pop del op + ejecución en chunk diferido (undoRun no va al bundle inicial)
    import('../lib/undoRun')
      .then(m => (redo ? m.popAndRedo() : m.popAndUndo()))
      .then(label => { if (label) toastOk(redo ? `↻ ${label}` : tNow('toast.undone', { label })); })
      .catch(err => toastErr(tNow('toast.couldNotMove') + ': ' + (err?.message || err)));
  }

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
    ejecutarUndo(redo);
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

  /** Carga el chunk de Día AHORA (click en la pestaña o día de la grilla):
   *  sin esperar al idle callback, que puede demorar hasta 2s en máquina
   *  cargada y la pestaña quedaba en "Cargando vista del día…". */
  function irAVistaDia() {
    currentView = 'day';
    loadDailyView();
  }
  
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

  /** Exportar (menú Datos / sidebar): descarga el respaldo con toast de éxito/error.
   *  Usa el formato binario .npz (imágenes recompresidas como binario ZIP). */
  async function exportarDatos() {
    cerrarMenuDatos();
    try {
      const stats = await exportarRespaldoBinario();
      const kb = stats.bytes >= 1024 * 1024
        ? `${(stats.bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(stats.bytes / 1024))} KB`;
      toastOk(
        stats.imagenesRecomprimidas > 0
          ? `${tNow('sidebar.exported')} ${kb} · ${tNow('sidebar.exportImages', { n: stats.imagenesRecomprimidas })}`
          : `${tNow('sidebar.exported')} ${kb}`
      );
    } catch (err: any) {
      toastErr(tNow('settings.exportError', { msg: err?.message || err }));
    }
  }

  /** Importar: abre Ajustes donde vive el flujo con confirmación. */
  function importarDatos() {
    cerrarMenuDatos();
    openSettings();
  }

  // ── Menú desplegable "Datos" del header ──
  let menuDatos = $state(false);
  let menuDatosSaliendo = $state(false); // animación de subida al cerrar
  let menuDatosEl: HTMLElement | undefined = $state();
  let menuDatosPos = $state({ x: 0, y: 0 });

  // Fecha del último respaldo descargado (pie del menú). Se lee al abrir el
  // menú para que muestre siempre el valor fresco (incluida la descarga recién
  // hecha desde el propio menú o desde Ajustes).
  let ultimoRespaldo = $state<string | null>(null);
  const fechaUltimoRespaldo = $derived.by(() => {
    if (!ultimoRespaldo) return null;
    const d = new Date(ultimoRespaldo);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString(
      getLocaleActivo(),
      { day: '2-digit', month: '2-digit', year: 'numeric' }
    );
  });

  /** Locale en espejo del idioma de la app (no el del navegador: si el usuario
   *  eligió español en un navegador en inglés, el menú respeta su elección). */
  function getLocaleActivo(): string {
    let lang = 'es';
    idioma.subscribe(v => (lang = v))();
    return lang === 'en' ? 'en-US' : 'es-AR';
  }

  function alternarMenuDatos() {
    if (!menuDatos) {
      ultimoRespaldo = leerUltimoRespaldo();
      if (menuDatosEl) {
        // Posicionar bajo el botón ANTES de abrir (el portal manda al body:
        // sin ancla de layout, las coords deben medirse del botón real).
        const r = menuDatosEl.querySelector('button')?.getBoundingClientRect();
        if (r) {
          const MENU_W = 230;
          const MENU_H = 200; // altura máx estimada (4 items + pie); solo para el clamp
          menuDatosPos = {
            x: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
            // Clamp vertical: con el header parcialmente scrolleado el botón
            // puede quedar cerca/abajo del viewport y el menú salía recortado.
            y: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - MENU_H - 8))
          };
        }
      }
    }
    if (menuDatos) {
      // Cierre animado: el menú sube (menuDatosSaliendo) y se desmonta al
      // terminar la animación, no antes.
      menuDatosSaliendo = true;
      setTimeout(() => { menuDatos = false; menuDatosSaliendo = false; }, 140);
    } else {
      menuDatos = true;
    }
  }
  /** Cierra el menú directo (Esc / click-afuera / acción) con la misma animación. */
  function cerrarMenuDatos() {
    if (!menuDatos || menuDatosSaliendo) return;
    menuDatosSaliendo = true;
    setTimeout(() => { menuDatos = false; menuDatosSaliendo = false; }, 140);
  }

  // Click afuera + Esc cierran el menú (patrón del menú contextual existente).
  $effect(() => {
    if (!menuDatos) return;
    const clickAfuera = (e: PointerEvent) => {
      if (menuDatosEl && !menuDatosEl.contains(e.target as Node)) cerrarMenuDatos();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrarMenuDatos();
    };
    document.addEventListener('pointerdown', clickAfuera);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', clickAfuera);
      window.removeEventListener('keydown', esc);
    };
  });
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
    irAVistaDia();
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

  /* (Subir/Bajar Todo retirado a pedido del usuario: los botones ↑↓ del
     header y de la sidebar de Día se eliminaron. La lógica shiftAll quedó
     sin usos y se removió; el deshacer de commitCambios conserva el soporte
     de sus labels por si un op antiguo queda en la pila.) */
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
            onclick={irAVistaDia}
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
      <div class="header-actions">
        <!-- Deshacer / Rehacer: mismos guards y misma ejecución que Ctrl+Z
             (ejecutarUndo). Deshabilitados cuando su pila está vacía. -->
        <button
          class="btn btn-secondary btn-icon"
          onclick={() => ejecutarUndo(false)}
          disabled={stackCount === 0}
          aria-label={$t('header.undo')}
          title={$t('header.undo')}
        >
          <Undo2 size={20} />
        </button>
        <button
          class="btn btn-secondary btn-icon"
          onclick={() => ejecutarUndo(true)}
          disabled={redoCount === 0}
          aria-label={$t('header.redo')}
          title={$t('header.redo')}
        >
          <Redo2 size={20} />
        </button>
        <button class="btn btn-secondary" onclick={coverGapsAbove} aria-label={$t('header.adjustUp')} title={$t('header.adjustUpTitle')}>
          <ChevronsUp size={20} /> <span class="hide-mobile">{$t('header.adjustUp')}</span>
        </button>
        <button class="btn btn-secondary" onclick={coverGapsBelow} aria-label={$t('header.adjustDown')} title={$t('header.adjustDownTitle')}>
          <ChevronsDown size={20} /> <span class="hide-mobile">{$t('header.adjustDown')}</span>
        </button>
        <button class="btn btn-plus" onclick={() => openActivityModal(null, currentView === 'day' ? selectedDay : null)} aria-label={$t('header.newActivity')}>
          <Plus size={20} /> <span class="hide-mobile">{$t('header.newActivity')}</span>
        </button>
        <!-- (Modo privacidad retirado del header: vive como ítem del menú
             Datos. Header mínimo: compactar ×2, nueva actividad, ajustes.) -->
        <button class="btn btn-secondary btn-icon" onclick={openSettings} aria-label={$t('header.settings')}>
          <Settings size={20} />
        </button>
      </div>
      <!-- Menú Datos: FUERA de .header-actions para ser visible en AMBAS vistas
           (en Día el header-actions se oculta y las acciones viven en la
           sidebar; los datos siempre están a un clic aquí). -->
      <div class="menu-datos-wrap" bind:this={menuDatosEl}>
        <button
          class="btn btn-secondary btn-icon"
          onclick={alternarMenuDatos}
          aria-label={$t('sidebar.menuDatos')}
          aria-expanded={menuDatos}
          aria-haspopup="menu"
          title={$t('sidebar.menuDatos')}
        >
          <Cloud size={20} />
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
        <!-- Vista Día: mismas acciones que Semana (header único, sin sidebar
             duplicada: escritorio edita, móvil ve). -->
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
            <!-- Esqueleto EN el panel (no overlay fixed): mantiene el layout y
                 comunica progreso sin tapar el header ni la grilla. Mismo alto
                 aproximado que el track del día para no saltar al montar. -->
            <div class="daily-skeleton" role="status" aria-label={$t('header.viewDay')}>
              <div class="skel-header">
                <div class="skel-chip"></div>
                <div class="skel-line"></div>
              </div>
              <div class="skel-track">
                {#each Array(8) as _, i}
                  <div class="skel-block" style="animation-delay: {i * 90}ms"></div>
                {/each}
              </div>
            </div>
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

  {#if menuDatos}
    <!-- Portal a body: el backdrop-filter de .glass-panel ancestro crea
         containing block y anclaría el menú lejos del botón. Mismo fix que
         el menú contextual de las vistas. -->
    <!-- Animación CSS propia (menuDatosAnim) y NO transition:fly: fly lee la
         opacity computada del nodo al crearse, y un nodo recién portado al
         body (use:portal) computa 0 → animaba 0→0 y el menú quedaba
         invisible. La CSS keyframes no depende del estado previo. -->
    <div
      class="menu-datos glass-panel menuDatosAnim"
      class:menuDatosSaliendo={menuDatosSaliendo}
      role="menu"
      use:portal
      style="top: {menuDatosPos.y}px; left: {menuDatosPos.x}px"
    >
      <button role="menuitem" onclick={exportarDatos} title={$t('sidebar.exportTitle')}>
        <Download size={16} /> {$t('sidebar.export')}
      </button>
      <button role="menuitem" onclick={importarDatos} title={$t('sidebar.importTitle')}>
        <Upload size={16} /> {$t('sidebar.import')}
      </button>
      <div class="menu-datos-sep" role="presentation"></div>
      <button role="menuitemcheckbox" aria-checked={$modoPrivacidad} onclick={alternarPrivacidad} title={$t('header.privacy')}>
        {#if $modoPrivacidad}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
        <span class="menu-item-flex">{$t('header.privacy')}</span>
        {#if $modoPrivacidad}<span class="menu-check">✓</span>{/if}
      </button>
      <div class="menu-datos-pie" role="presentation">
        {#if fechaUltimoRespaldo}
          {$t('sidebar.lastBackup', { fecha: fechaUltimoRespaldo })}
        {:else}
          {$t('sidebar.lastBackupNever')}
        {/if}
      </div>
    </div>
  {/if}

  <Toasts />
</div>

<style>
  .dashboard {
    /* Escalado por ancho de pantalla: 1400px de piso en desktop común,
       1560px en pantallas grandes y 2000px en ultrawide (2560+) para que
       el contenido crezca con la pantalla en vez de dejar franjas muertas
       a los lados (a 2560px el tope 1800 dejaba 380px vacíos POR LADO).
       clamp fluido: nada brusco entre breakpoints. */
    max-width: clamp(1400px, 86vw, 2000px);
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

  /* Acciones del header: fila horizontal SIEMPRE (en Semana y en móvil).
     Sin esto los botones-block se apilan en columna (bug visto en Semana). */
  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Escritorio angosto / zoom del navegador (≤1200px): los botones con texto
     pasan a solo-ícono. Con texto, el grupo necesita ~645px y entre ~770 y
     ~1150px no entra junto al logo+pestañas: flex-wrap lo partía en dos filas
     y se veía una columna apilada a la derecha (bug en desktop). aria-label +
     title conservan el significado; los targets siguen ≥44px (regla dura #5). */
  @media (max-width: 1200px) {
    .header-actions .hide-mobile {
      display: none;
    }
    .btn-plus {
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
  }

  /* Ancla del menú Datos: wrapper inline para que el botón no participe del
     wrap raro, y para medir su rect a la hora de abrir. */
  .menu-datos-wrap {
    display: inline-flex;
  }

  /* Dropdown de Datos (portal a body, position:fixed): mismo look que el
     menú contextual de las vistas. */
  .menu-datos {
    position: fixed;
    z-index: 1200;
    min-width: 230px;
    padding: 0.35rem;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  }
  /* Subida/bajada del dropdown: baja al abrir (desde -8px), sube al cerrar
     (hacia -8px). Sin depender de la opacity computada al montar: keyframes
     explícitos 0→1 y 1→0. */
  .menuDatosAnim {
    animation: menuDatosIn 0.16s ease-out;
  }
  .menuDatosAnim.menuDatosSaliendo {
    animation: menuDatosOut 0.14s ease-in forwards;
  }
  @keyframes menuDatosIn {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes menuDatosOut {
    from { opacity: 1; transform: translateY(0); }
    to { opacity: 0; transform: translateY(-8px); }
  }
  .menu-datos button {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 44px; /* regla dura #5 */
    padding: 0.55rem 0.8rem;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--color-brown-bark, #5c4033);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .menu-datos button:hover {
    background: rgba(92, 64, 51, 0.08);
  }

  .menu-datos button[role="menuitemcheckbox"] {
    justify-content: flex-start;
  }
  .menu-item-flex {
    flex: 1;
    text-align: left;
  }
  .menu-check {
    color: var(--color-green-dark);
    font-weight: 700;
  }
  .menu-datos-sep {
    height: 1px;
    margin: 0.35rem 0.5rem;
    background: rgba(92, 64, 51, 0.14);
  }

  /* Pie informativo: fecha del último respaldo descargado (no interactivo) */
  .menu-datos-pie {
    padding: 0.45rem 0.8rem 0.3rem;
    margin-top: 0.15rem;
    border-top: 1px solid rgba(92, 64, 51, 0.14);
    font-size: 0.72rem;
    font-weight: 500;
    color: rgba(92, 64, 51, 0.65);
    white-space: nowrap;
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

  /* ── Esqueleto de carga de la vista Día ──
     Bloques que pulsan dentro del panel: layout estable (no overlay),
     sensación de progreso y sin salto al montar el track real. */
  .daily-skeleton {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-height: 60vh;
  }
  .skel-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .skel-chip {
    width: 110px;
    height: 32px;
    border-radius: 16px;
    background: rgba(92, 64, 51, 0.08);
    animation: skelPulso 1.2s ease-in-out infinite;
  }
  .skel-line {
    flex: 1;
    max-width: 320px;
    height: 14px;
    border-radius: 7px;
    background: rgba(92, 64, 51, 0.06);
    animation: skelPulso 1.2s ease-in-out 150ms infinite;
  }
  .skel-track {
    position: relative;
    flex: 1;
    border-left: 2px solid rgba(92, 64, 51, 0.08);
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding-left: 56px;
  }
  .skel-block {
    height: 64px;
    border-radius: 10px;
    border-left: 4px solid rgba(92, 64, 51, 0.12);
    background: rgba(92, 64, 51, 0.05);
    animation: skelPulso 1.2s ease-in-out infinite;
    /* anchos variados: parece contenido real, no una lista clonada */
  }
  .skel-block:nth-child(3n) { width: 72%; }
  .skel-block:nth-child(3n + 1) { width: 88%; }
  .skel-block:nth-child(3n + 2) { width: 55%; }
  @keyframes skelPulso {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skel-chip, .skel-line, .skel-block {
      animation: none;
    }
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

  /* (Barra lateral de acciones de Día retirada: el header es único en ambas
     vistas — escritorio edita con el mismo header que móvil.) */

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
    /* Sidebar de donuts fluida: 320px de piso, hasta 420px en ultrawide —
       en 2560px los 360px se veían enanos junto a la grilla. */
    grid-template-columns: 1fr clamp(320px, 17vw, 420px);
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

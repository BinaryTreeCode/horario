<script lang="ts">
  import { db, descargarRespaldo, validateImport, importValidatedData, type ValidationResult } from '../lib/db';
  import { isLoggedIn, syncNow, initialSyncAfterLogin, resetSyncAfterLogout, onSyncChange, isPushPaused, resumePushAndSync } from '../lib/sync';
  import { establecerClave, olvidarClave } from '../lib/crypto';
  import type { SyncStatus } from '../lib/types';
  import { Cloud, CloudUpload, LogIn, LogOut, RefreshCw, UserPlus } from '@lucide/svelte';
  import type { Category } from '../lib/types';
  import { X, Save, Plus, Trash2, Download, Upload, GripVertical, ShieldCheck, Languages } from '@lucide/svelte';
  import { idioma, cambiarIdioma, t, IDIOMAS_DISPONIBLES } from '../lib/i18n';
  import { dndzone } from 'svelte-dnd-action';
  import { flip } from 'svelte/animate';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr } from '../lib/toast';
  import { tNow } from '../lib/i18n';
  import { clearUndo } from '../lib/undo';
  import { notifyDataChange } from '../lib/dataBus';
  import Toasts from './Toasts.svelte';

  interface Props {
    settings: { startHour: number; endHour: number };
    categories: Category[];
    onClose: () => void;
  }

  let { settings, categories, onClose }: Props = $props();

  let startHour = $state(0);
  let endHour = $state(0);
  let localCategories = $state<Category[]>([]);
  let initialized = $state(false);
  let panelEl: HTMLElement | undefined = $state();

  // ── Cuenta y sincronización ──
  let loggedIn = $state(false);
  let authLoading = $state(true);
  let syncStatus = $state<SyncStatus>('local');
  let authEmail = $state('');
  let authPassword = $state('');
  let authName = $state('');
  let authMode = $state<'login' | 'register'>('login');
  let authError = $state('');
  let authBusy = $state(false);
  let syncMessage = $state('');

  // Confirmaciones (diálogo propio) y datos del import pendiente
  let confirmRestoreCats = $state(false);
  let confirmImport = $state(false);
  let pendingImport = $state<{ validation: ValidationResult; summary: string; warnings: string[] } | null>(null);

  // Botón real para el file input oculto (táctil: el label-que-envuelve era frágil)
  let fileInput: HTMLInputElement | null = $state(null);
  let importFileName = $state<string | null>(null);

  let pushPausado = $state(false);

  $effect(() => {
    isLoggedIn().then(v => { loggedIn = v; authLoading = false; });
    pushPausado = isPushPaused();
    const off = onSyncChange((s) => { syncStatus = s; });
    return off;
  });

  /** Reactiva el push tras un import y sube todo a la nube. */
  async function reanudarPush() {
    pushPausado = false;
    try {
      await resumePushAndSync();
      toastOk(tNow('settings.pushResumed'));
    } catch {
      toastErr(tNow('settings.pushResumeError'));
    }
  }

  async function handleAuth() {
    authError = '';
    authBusy = true;
    try {
      const op = authMode;
      const body: Record<string, string> = { email: authEmail, password: authPassword };
      if (authName) body.name = authName;
      const res = await fetch(`/api/auth?op=${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        authError = data?.error ?? tNow('settings.authError');
        return;
      }
      loggedIn = true;
      // E2E: derivar la clave del password ANTES de limpiar el formulario —
      // vive solo en memoria; la nube recibe blobs que no puede leer.
      await establecerClave(authEmail, authPassword);
      authPassword = '';
      syncMessage = tNow('settings.syncingMsg');
      await initialSyncAfterLogin();
      syncMessage = tNow('settings.syncedE2E');
    } catch (err: any) {
      authError = err?.message ?? tNow('settings.networkError');
    } finally {
      authBusy = false;
    }
  }

  async function handleLogout() {
    await fetch('/api/auth?op=logout', { method: 'POST', credentials: 'same-origin' });
    loggedIn = false;
    authEmail = '';
    olvidarClave(); // la clave E2E muere con la sesión
    resetSyncAfterLogout();
    syncMessage = '';
  }

  async function handleManualSync() {
    syncMessage = tNow('settings.syncingMsg');
    try {
      await syncNow(true);
      syncMessage = tNow('settings.syncedMsg');
    } catch (err: any) {
      syncMessage = tNow('settings.syncFail', { msg: err?.message ?? tNow('settings.syncFailGeneric') });
    }
  }

  // Cerrar con Esc y atrapar el foco dentro del panel
  $effect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    panelEl?.focus();
    return () => window.removeEventListener('keydown', handleKey);
  });

  function trapFocus(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !panelEl) return;
    const focusables = panelEl.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Drag and drop for categories
  const flipDurationMs = 300;
  function handleDndConsider(e: any) {
    localCategories = e.detail.items;
  }
  function handleDndFinalize(e: any) {
    // A3: el reordenado es una mutación local — updatedAt es lo que hace
    // que el push incremental (y el LWW del servidor) lo incluya.
    localCategories = e.detail.items.map((item: any, index: number) => ({ ...item, order: index, updatedAt: Date.now() }));
  }

  // Reactive derived options
  const startOptions = $derived(
    Array.from({ length: 24 }, (_, i) => ({
      value: i,
      label: `${i % 12 || 12}:00 ${i < 12 ? 'AM' : 'PM'} ${i === 12 ? '(Mediodía)' : ''}`
    }))
  );

  const endOptions = $derived(
    Array.from({ length: 25 }, (_, i) => ({
      value: i,
      label: `${i % 12 || 12}:00 ${i < 12 ? 'AM' : (i === 24 ? 'AM' : 'PM')} ${i === 12 ? '(Mediodía)' : (i === 24 ? '(Medianoche)' : '')}`
    })).filter(opt => opt.value > startHour)
  );

  // Sync with props once they are available
  $effect(() => {
    if (!initialized && settings && settings.startHour !== undefined) {
      startHour = settings.startHour;
      endHour = settings.endHour;
      initialized = true;
    }
  });

  $effect(() => {
    if (localCategories.length === 0 && categories && categories.length > 0) {
      localCategories = [...categories].sort((a, b) => a.order - b.order);
    }
  });

  async function saveSettings() {
    try {
      const { pushUndo, cloneAct } = await import('../lib/undo');
      const stampSet = Date.now();
      // Snapshots antes/después para el undo de ajustes y categorías
      const setBefore: Record<string, any> = {};
      for (const k of ['startHour', 'endHour']) {
        setBefore[k] = (await db.settings.get(k)) ?? null;
      }
      const catsBefore = await db.categories.toArray();
      const catsBeforeMap = new Map(catsBefore.map(c => [c.id, c]));

      await db.settings.put({ id: 'startHour', key: 'startHour', value: startHour, updatedAt: stampSet });
      await db.settings.put({ id: 'endHour', key: 'endHour', value: endHour, updatedAt: stampSet });

      const snapshot: Category[] = $state.snapshot(localCategories).map((c, i) => ({ ...c, order: i }));

      // Borrado real: eliminar de la BD las categorías que ya no están en la lista
      const keptIds = new Set(snapshot.map(c => c.id));
      const existing = await db.categories.toArray();
      const removed = existing.filter(c => !keptIds.has(c.id));
      const orphans: any[] = [];
      const dirtyOverrides: any[] = [];

      // Reasignar actividades (y overrides) que usaban categorías eliminadas
      if (removed.length > 0) {
        const removedIds = new Set(removed.map(c => c.id));
        await db.transaction('rw', db.activities, db.categories, db.dayOverrides, async () => {
          const acts = await db.activities.toArray();
          const orphs = acts.filter(a => removedIds.has(a.categoryId));
          if (orphs.length > 0) {
            const stamp = Date.now();
            orphans.push(...orphs);
            await db.activities.bulkPut(orphs.map(a => ({ ...a, categoryId: 'rutina', updatedAt: stamp })));
          }
          const overrides = await db.dayOverrides.toArray();
          const dirty = overrides.filter(o => o.activities?.some(a => removedIds.has(a.categoryId)));
          if (dirty.length > 0) {
            const stampOv = Date.now();
            dirtyOverrides.push(...dirty);
            await db.dayOverrides.bulkPut(dirty.map(o => ({
              ...o,
              activities: o.activities.map(a => removedIds.has(a.categoryId) ? { ...a, categoryId: 'rutina' } : a),
              updatedAt: stampOv
            })));
          }
          const stampCat = Date.now();
          await db.categories.bulkPut(removed.map(c => ({ ...c, deletedAt: stampCat, updatedAt: stampCat })));
        });
        const names = removed.map(c => `"${c.label}"`).join(', ');
        toastOk(tNow('settings.removedCats', { names }));
      }

      if (snapshot.length > 0) {
        await db.categories.bulkPut(snapshot);
      }

      // ── Undo de la operación completa de Ajustes ──
      // Ajustes: antes/después de cada clave tocada.
      const settingsChanges = (['startHour', 'endHour'] as const)
        .map(k => ({
          key: k,
          before: setBefore[k],
          after: { id: k, key: k, value: k === 'startHour' ? startHour : endHour, updatedAt: stampSet }
        }))
        .filter(ch => ch.before?.value !== ch.after.value);
      // Categorías: creadas/modificadas (label/color/orden) y eliminadas.
      const catChanges = [];
      for (const c of snapshot) {
        const b = catsBeforeMap.get(c.id);
        if (!b || b.label !== c.label || b.color !== c.color || b.order !== c.order) {
          catChanges.push({ before: b ?? null, after: c });
        }
      }
      for (const r of removed) {
        // El "after" real es el tombstone ya escrito (con su updatedAt del
        // guard): releer para que el guard del undo lo acepte.
        const tombstone = await db.categories.get(r.id);
        catChanges.push({ before: r, after: tombstone ?? { ...r, deletedAt: r.deletedAt } });
      }
      // Huérfanas reasignadas a 'rutina': el undo las devuelve a su categoría.
      // El "after" se releer de BD (el bulkPut le puso updatedAt nuevo — el
      // guard del undo compara contra eso).
      const orphanChanges = [];
      for (const o of orphans) {
        // o fue capturado ANTES del bulkPut: conserva la categoría ORIGINAL
        // (ejercicio) — es exactamente el "before" que el undo debe restaurar.
        const after = await db.activities.get(o.id!);
        orphanChanges.push({
          before: o,
          after: after ?? { ...o, categoryId: 'rutina' }
        });
      }
      if (settingsChanges.length > 0 || catChanges.length > 0 || orphanChanges.length > 0) {
        pushUndo({
          label: tNow('settings.saved'),
          settings: settingsChanges,
          cats: catChanges,
          rows: orphanChanges,
          overrides: []
        });
      }

      toastOk(tNow('settings.saved'));
      onClose();
    } catch (err: any) {
      console.error('Error saving settings:', err);
      toastErr(tNow('settings.saveError', { msg: err.message || tNow('settings.networkError') }));
    }
  }

  function addCategory() {
    const id = `cat-${Date.now()}`;
    localCategories = [
      ...localCategories,
      { id, label: tNow('settings.newCategory'), color: '#999999', order: localCategories.length, updatedAt: Date.now() }
    ];
  }

  function removeCategory(id: string) {
    localCategories = localCategories.filter(c => c.id !== id);
  }

  function updateCategory(id: string, field: string, value: any) {
    localCategories = localCategories.map(c => 
      c.id === id ? { ...c, [field]: value, updatedAt: Date.now() } : c
    );
  }

  function restoreDefaults() {
    confirmRestoreCats = true;
  }

  async function restoreDefaultsConfirm() {
    const { INITIAL_CATEGORIES } = await import('../lib/db');
    localCategories = [...INITIAL_CATEGORIES];
    toastOk(tNow('settings.catsReset'));
  }

  // ── Borrar todo (zona de peligro) ──
  let confirmWipeAll = $state(false);
  let wipingAll = $state(false);

  /**
   * Borra TODOS los datos locales: actividades, categorías, ajustes
   * (vuelve a 7–23) y ediciones temporales. Sync-safe: en vez de clear()
   * marca TODOS los registros con deletedAt (tombstones) — un clear()
   * local sería deshecho por el siguiente pull, que restauraría la nube
   * completa; con tombstones el push propaga los borrados a la nube.
   * Deshacer NO cubre esto (clearUndo): es la salida de emergencia.
   */
  async function wipeAll() {
    if (wipingAll) return;
    wipingAll = true;
    try {
      const stamp = Date.now();
      await db.transaction('rw', db.activities, db.categories, db.settings, db.dayOverrides, db.syncState, async () => {
        // Reemplazo total: los registros vivos pasan a tombstone (y los que
        // ya eran tombstone se refrescan) — la tabla queda efectivamente vacía.
        const wipe = (rows: any[]) =>
          rows.map(r => ({ ...r, deletedAt: stamp, updatedAt: stamp }));
        const acts = await db.activities.toArray();
        if (acts.length) await db.activities.bulkPut(wipe(acts));
        const cats = await db.categories.toArray();
        if (cats.length) await db.categories.bulkPut(wipe(cats));
        const sets = await db.settings.toArray();
        if (sets.length) await db.settings.bulkPut(wipe(sets));
        const ovs = await db.dayOverrides.toArray();
        if (ovs.length) await db.dayOverrides.bulkPut(wipe(ovs));
        // Ajustes de horario inmediatos (el panel muestra 7-23 al reabrir).
        await db.settings.bulkPut([
          { id: 'startHour', key: 'startHour', value: 7, updatedAt: stamp },
          { id: 'endHour', key: 'endHour', value: 23, updatedAt: stamp }
        ]);
      });
      clearUndo(); // sin historial: nada que deshacer tras el borrado
      notifyDataChange(['activities', 'categories', 'settings', 'dayOverrides']);
      toastOk(tNow('toast.wiped'));
      onClose();
    } catch (err: any) {
      console.error('Error al borrar todo:', err);
      toastErr(tNow('settings.wipeError', { msg: err?.message || err }));
    } finally {
      wipingAll = false;
    }
  }

  // Formato del respaldo: compacto posicional (por defecto) o JSON completo
  let exportMode = $state<'compact' | 'full'>('compact');

  async function handleExport() {
    try {
      await descargarRespaldo(exportMode);
    } catch (err: any) {
      toastErr(tNow('settings.exportError', { msg: err.message }));
    }
  }

  // Límite de tamaño razonable para un archivo de respaldo (~10 MB; las imágenes viven en la nube)
  const MAX_IMPORT_SIZE = 10 * 1024 * 1024;

  async function handleImport(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // reset DESPUÉS de capturar el file (asignar value='' limpia input.files)
    if (!file) {
      importFileName = null;
      return;
    }
    importFileName = file.name;
    if (file.size > MAX_IMPORT_SIZE) {
      toastErr(tNow('settings.fileTooBig', { size: (file.size / 1024 / 1024).toFixed(1), max: MAX_IMPORT_SIZE / 1024 / 1024 }));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      toastErr(tNow('settings.fileReadError'));
    };
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;

        // 1) Validar ANTES de tocar la base de datos
        const validation = validateImport(text);
        if (!validation.valid) {
          toastErr(tNow('settings.importFailed', { error: validation.error }));
          return;
        }

        // 2) Confirmar con resumen + advertencias antes de reemplazar TODO
        const { summary, warnings } = validation;
        const s = summary;
        pendingImport = {
          validation,
          summary: [
            tNow('settings.summaryActs', { n: s.activities }),
            tNow('settings.summaryCats', { n: s.categories }),
            tNow('settings.summarySettings', { n: s.settings }),
            tNow('settings.summaryOverrides', { n: s.dayOverrides })
          ].join('\n'),
          warnings:
            warnings.length > 6
              ? [...warnings.slice(0, 6), tNow('settings.moreWarnings', { count: warnings.length - 6 })]
              : warnings
        };
        confirmImport = true;
      } catch (err: any) {
        toastErr(tNow('settings.importError', { msg: err?.message || tNow('settings.networkError') }));
      }
    };
    reader.readAsText(file);
  }

  async function doImport() {
    if (!pendingImport) return;
    try {
      // $state envuelve pendingImport en Proxies profundos; IndexedDB usa
      // structured clone y DataCloneError con Proxies. snapshot() clona a
      // objetos planos antes de tocar Dexie.
      const validation = $state.snapshot(pendingImport.validation);
      await importValidatedData(validation);
      confirmImport = false;
      clearUndo(); // los snapshots de undo referencian filas que el import reemplazó

      // Petición explícita: importar NO sincroniza con la nube. El push queda
      // pausado; el usuario decide subir los datos desde el botón de Ajustes.
      // El pull automático sigue: leer la nube no pisa lo importado (LWW gana
      // lo local con updatedAt fresco).
      toastOk(tNow('settings.importedNoSync'));
    } catch (err: any) {
      toastErr(tNow('settings.importError', { msg: err?.message || tNow('settings.networkError') }));
    }
  }
</script>

<div class="modal-overlay" onclick={onClose}>
  <div class="modal-content glass-panel" tabindex="-1" bind:this={panelEl} onkeydown={trapFocus} onclick={e => e.stopPropagation()}>
    <!-- div, no header: evita un segundo landmark banner (axe) -->
    <div class="modal-header">
      <h2>{$t('settings.title')}</h2>
      <button class="close-btn" onclick={onClose} aria-label={$t('settings.closeSettings')}><X size={20} /></button>
    </div>

    <div class="settings-sections">
      <!-- ── Cuenta y respaldo en la nube ── -->
      <section class="settings-section">
        <h3><Cloud size={16} /> {$t('settings.account')}</h3>
        {#if authLoading}
          <p class="sync-hint">{$t('settings.checkingSession')}</p>
        {:else if loggedIn}
          <div class="sync-status-row">
            <span class="sync-dot sync-{syncStatus}" aria-hidden="true"></span>
            <span class="sync-status-text">
              {#if syncStatus === 'synced'}{$t('settings.synced')}{:else if syncStatus === 'syncing'}{$t('settings.syncing')}{:else if syncStatus === 'error'}{$t('settings.syncError')}{:else if syncStatus === 'offline'}{$t('settings.offline')}{:else}{$t('settings.localOnly')}{/if}
            </span>
            <button class="btn-sync-refresh" onclick={handleManualSync} title={$t('settings.syncNow')} aria-label={$t('settings.syncNow')} disabled={syncStatus === 'syncing'}>
              <RefreshCw size={14} />
            </button>
            <button class="btn-sync-logout" onclick={handleLogout} title={$t('settings.logout')} aria-label={$t('settings.logout')}>
              <LogOut size={14} /> {$t('settings.logoutShort')}
            </button>
          </div>
          {#if syncMessage}<p class="sync-hint">{syncMessage}</p>{/if}
        {:else}
          <p class="sync-hint">{$t('settings.loginPrompt')}</p>
          <div class="auth-tabs">
            <button class:active={authMode === 'login'} onclick={() => authMode = 'login'}>{$t('settings.login')}</button>
            <button class:active={authMode === 'register'} onclick={() => authMode = 'register'}>{$t('settings.register')}</button>
          </div>
          <div class="auth-form">
            {#if authMode === 'register'}
              <input type="text" placeholder={$t('settings.nameOptional')} aria-label={$t('settings.nameOptional')} bind:value={authName} autocomplete="name" />
            {/if}
            <input type="email" placeholder={$t('settings.email')} aria-label={$t('settings.email')} bind:value={authEmail} autocomplete="email" />
            <input type="password" placeholder={$t('settings.password')} aria-label={$t('settings.password')} bind:value={authPassword} autocomplete={authMode === 'login' ? 'current-password' : 'new-password'} />
            {#if authError}<p class="auth-error">{authError}</p>{/if}
            <button class="btn btn-primary auth-submit" onclick={handleAuth} disabled={authBusy || !authEmail || !authPassword}>
              {#if authMode === 'login'}<LogIn size={15} /> {$t('settings.enter')}{:else}<UserPlus size={15} /> {$t('settings.createAccount')}{/if}
            </button>
          </div>
        {/if}
      </section>

      <!-- ── Idioma / Language ── -->
      <section class="settings-section">
        <h3><Languages size={16} /> {$t('settings.language')}</h3>
        <div class="lang-selector" role="radiogroup" aria-label="{$t('settings.language')}">
          {#each IDIOMAS_DISPONIBLES as opt}
            <button
              class="lang-option"
              class:active={$idioma === opt.codigo}
              role="radio"
              aria-checked={$idioma === opt.codigo}
              onclick={() => cambiarIdioma(opt.codigo)}
            >
              {opt.nombre}
            </button>
          {/each}
        </div>
        <p class="lang-hint">{$t('settings.languageHint')}</p>
      </section>

      <section class="settings-section">
        <h3>{$t('settings.hoursRange')}</h3>
        <div class="range-selector">
          <div class="range-inputs-horizontal">
            <div class="form-group-compact">
              <label for="set-start">{$t('settings.startsAt')}</label>
              <select id="set-start" bind:value={startHour}>
                {#each startOptions as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </div>
            
            <div class="to-text">{$t('settings.to')}</div>

            <div class="form-group-compact">
              <label for="set-end">{$t('settings.endsAt')}</label>
              <select id="set-end" bind:value={endHour}>
                {#each endOptions as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </div>
          </div>
          
          <div class="range-visual">
            <div class="range-bar-total">
              <div class="range-bar-active" style="left: {(startHour / 24) * 100}%; width: {((endHour - startHour) / 24) * 100}%"></div>
            </div>
            <div class="range-labels">
              <span>0h</span>
              <span>12h</span>
              <span>24h</span>
            </div>
            <p class="range-summary">{$t('settings.daySummary', { hours: endHour - startHour })}</p>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <header class="section-header">
          <h3>{$t('settings.categories')}</h3>
        </header>
        <div 
          class="categories-list" 
          use:dndzone={{items: localCategories, flipDurationMs, type: 'categories', delayTouchStart: 200}}
          onconsider={handleDndConsider} 
          onfinalize={handleDndFinalize}
        >
          {#each localCategories as cat (cat.id)}
            <div class="category-edit-item" animate:flip={{duration: flipDurationMs}}>
              <div class="grip-handle">
                <GripVertical size={16} />
              </div>
              <input type="color" value={cat.color} aria-label={$t('settings.colorOf', { name: cat.label })} oninput={e => updateCategory(cat.id, 'color', e.currentTarget.value)} />
              <input type="text" value={cat.label} aria-label={$t('settings.categoryName')} oninput={e => updateCategory(cat.id, 'label', e.currentTarget.value)} />
              <button class="remove-cat" onclick={() => removeCategory(cat.id)} aria-label={$t('settings.removeCategory', { name: cat.label })}>
                <Trash2 size={16} />
              </button>
            </div>
          {/each}
        </div>
        <div class="categories-footer">
          <button class="btn btn-secondary btn-full" onclick={addCategory}>
            <Plus size={16} /> {$t('settings.addCategory')}
          </button>
        </div>
      </section>

      <section class="settings-section">
        <header class="section-header">
          <h3>{$t('settings.backup')}</h3>
        </header>
        <div class="backup-container">
          <!-- Formato del respaldo: compacto posicional o JSON completo -->
          <fieldset class="export-mode">
            <legend>{$t('settings.exportMode')}</legend>
            <label class="export-option">
              <input type="radio" name="exportMode" value="compact" bind:group={exportMode} />
              <span>{$t('settings.exportCompact')}</span>
            </label>
            <label class="export-option">
              <input type="radio" name="exportMode" value="full" bind:group={exportMode} />
              <span>{$t('settings.exportFull')}</span>
            </label>
          </fieldset>
          <div class="backup-actions">
            <button class="btn btn-secondary btn-backup" onclick={handleExport}>
              <Download size={18} /> {$t('settings.exportJson')}
            </button>
            
            <button
              class="btn btn-secondary btn-backup import-btn"
              onclick={() => fileInput?.click()}
              aria-label={$t('settings.importJson')}
            >
              <Upload size={18} /> {$t('settings.importJson')}
            </button>
            {#if importFileName}
              <span class="import-filename" role="status">{$t('settings.file', { name: importFileName })}</span>
            {/if}
            <input
              bind:this={fileInput}
              type="file"
              accept=".json,.txt,application/json,text/plain"
              onchange={handleImport}
              class="sr-only"
              tabindex="-1"
              aria-hidden="true"
            />
          </div>
          {#if pushPausado}
            <!-- Push pausado tras import: el usuario decide si subir estos datos -->
            <div class="push-paused glass-panel" role="alert">
              <CloudUpload size={18} />
              <div class="push-paused-text">
                <strong>{$t('settings.pushPausedTitle')}</strong>
                <p>{$t('settings.pushPausedMsg')}</p>
              </div>
              <button class="btn btn-primary" onclick={reanudarPush} disabled={syncStatus === 'syncing'}>
                {$t('settings.pushResumeBtn')}
              </button>
            </div>
          {/if}
          <div class="danger-zone">
            <button
              class="btn btn-danger btn-backup"
              onclick={() => confirmWipeAll = true}
              disabled={wipingAll}
              aria-label={$t('settings.wipeAllLabel')}
            >
              <Trash2 size={18} /> {$t('settings.wipeAll')}
            </button>
          </div>
          <p class="backup-info">{$t('settings.backupInfo')}</p>
        </div>
      </section>

      <!-- ── Tus datos: transparencia sobre el tratamiento (pedido del usuario) ── -->
      <section class="settings-section data-transparency">
        <h3><ShieldCheck size={16} /> {$t('settings.dataTitle')}</h3>
        <ul class="data-points">
          <li>{@html $t('privacy.noAccount')}</li>
          <li>{@html $t('privacy.withAccount')}</li>
          <li>{@html $t('privacy.whatWeStore')}</li>
          <li>{@html $t('privacy.youControl')}</li>
          <li>{@html $t('privacy.noFinePrint')}</li>
        </ul>
      </section>
    </div>

    <footer class="modal-footer">
      <button class="btn btn-secondary" onclick={onClose}>{$t('settings.cancel')}</button>
      <button class="btn btn-primary" onclick={saveSettings}>
        <Save size={18} /> {$t('settings.saveAll')}
      </button>
    </footer>
  </div>
</div>

<ConfirmDialog
  bind:open={confirmRestoreCats}
  title={$t('settings.resetCatsTitle')}
  message={$t('settings.resetCatsMsg')}
  confirmText={$t('settings.resetBtn')}
  onconfirm={() => restoreDefaultsConfirm()}
/>

<ConfirmDialog
  bind:open={confirmImport}
  title="¿Importar este archivo?"
  message={pendingImport
    ? $t('settings.importMsg', {
        summary: pendingImport.summary,
        warnings: pendingImport.warnings.length ? $t('settings.importWarnings', { list: pendingImport.warnings.join('\n• ') }) : ''
      }) + '\n\n☁️ ' + $t('settings.importNoSyncNote')
    : ''}
  confirmText={$t('settings.importBtn')}
  danger
  onconfirm={doImport}
  oncancel={() => pendingImport = null}
/>

<ConfirmDialog
  bind:open={confirmWipeAll}
  title={$t('settings.wipeTitle')}
  message={$t('settings.wipeMsg')}
  confirmText={$t('settings.wipeAll')}
  danger
  onconfirm={wipeAll}
/>

<Toasts />

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    justify-content: flex-end; /* Aside style */
    z-index: 100;
    backdrop-filter: blur(4px);
  }

  .modal-content {
    width: 100%;
    max-width: 400px;
    height: 100%;
    background: white;
    padding: 2rem;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    animation: slideInRight 0.3s ease-out;
  }

  @keyframes slideInRight {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--color-green-dark);
  }

  .close-btn {
    background: transparent;
    border: none;
    color: #6b6b6b; /* AA sobre blanco (antes #999) */
    cursor: pointer;
    min-width: 44px;
    min-height: 44px;
    display: grid;
    place-items: center;
    border-radius: 10px;
  }

  .settings-sections {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .settings-section h3 {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    color: var(--color-brown-bark);
    border-bottom: 1px solid rgba(0,0,0,0.05);
    padding-bottom: 0.5rem;
  }

  .range-selector {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
    background: rgba(92, 64, 51, 0.03);
    border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.05);
  }

  .range-inputs-horizontal {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .form-group-compact {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .form-group-compact select {
    width: 100%;
    padding: 0.5rem;
    min-height: 42px;
    font-size: 0.85rem;
  }

  .to-text {
    padding-top: 1.25rem;
    font-size: 0.85rem;
    color: #6b6b6b; /* AA sobre #f5f5f5 (antes #999 = 2.8:1) */
    font-weight: 600;
  }

  .range-visual {
    padding-top: 1rem;
    border-top: 1px solid rgba(0,0,0,0.03);
    margin-top: 0.5rem;
  }

  .range-bar-total {
    height: 8px;
    background: rgba(0,0,0,0.1);
    border-radius: 4px;
    position: relative;
    overflow: hidden;
  }

  .range-bar-active {
    position: absolute;
    height: 100%;
    background: var(--color-green-dark);
    border-radius: 4px;
    transition: all 0.3s ease;
  }

  .range-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.7rem;
    color: #6b6b6b; /* AA (antes #999) */
    margin-top: 0.5rem;
  }

  .range-summary {
    text-align: center;
    font-size: 0.9rem;
    color: var(--color-brown-bark);
    margin-top: 1rem;
    opacity: 0.8;
  }

  .form-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  label {
    font-size: 0.8rem;
    font-weight: 600;
    color: #666;
  }

  input[type="text"], select {
    padding: 0.6rem;
    min-height: 42px;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 8px;
    background: white;
    font-size: 0.9rem;
    color: var(--color-brown-bark);
  }

  input:focus, select:focus {
    outline: none;
    border-color: var(--color-green-dark);
    box-shadow: 0 0 0 2px rgba(45, 90, 39, 0.1);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .categories-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .category-edit-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  input[type="color"] {
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .grip-handle {
    color: #6b6b6b; /* AA (antes #999) */
    cursor: grab;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.25rem;
    /* M7: con dragHandle, el grip es la única zona de agarre — área táctil
       de la regla 5 (≥44px) para que el dedo no pelee con el scroll. */
    min-width: 44px;
    min-height: 44px;
    touch-action: none;
  }

  .grip-handle:active {
    cursor: grabbing;
  }

  .remove-cat {
    background: transparent;
    border: none;
    color: #cc0000;
    cursor: pointer;
    opacity: 0.6;
    min-width: 40px;
    min-height: 40px;
    display: grid;
    place-items: center;
    border-radius: 8px;
  }

  .remove-cat:hover {
    opacity: 1;
  }

  .modal-footer {
    display: flex;
    gap: 1rem;
    padding-top: 1.5rem;
    margin-top: 1.5rem;
    border-top: 1px solid rgba(0,0,0,0.05);
  }

  .btn-primary {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .btn-full {
    width: 100%;
    margin-top: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.75rem;
  }

  .categories-footer {
    border-top: 1px dashed rgba(0,0,0,0.1);
    margin-top: 1rem;
  }

  .backup-container {
    background: rgba(45, 90, 39, 0.03);
    padding: 1rem;
    border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.05);
  }

  .backup-actions {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  /* Selector de formato del respaldo (compacto / completo) */
  .export-mode {
    border: 1px dashed rgba(0,0,0,0.12);
    border-radius: 10px;
    padding: 0.5rem 0.75rem 0.6rem;
    margin: 0 0 0.9rem;
  }
  .export-mode legend {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--color-green-dark);
    padding: 0 0.35rem;
  }
  .export-option {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.75rem;
    line-height: 1.35;
    color: #555;
    padding: 0.45rem 0; /* radio 16px + padding ≥ 44px de touch target */
    cursor: pointer;
  }
  .export-option input {
    accent-color: var(--color-green-dark);
    margin-top: 0.1rem;
    flex-shrink: 0;
  }

  .btn-backup {
    flex: 1;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.6rem;
    cursor: pointer;
  }

  .import-btn {
    margin: 0;
  }

  .import-filename {
    font-size: 0.75rem;
    color: var(--color-brown-bark);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
  }

  /* Zona de peligro: Borrar todo, separada del resto de acciones */
  .push-paused {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0.9rem;
    margin: 0.6rem 0;
    border: 1px solid rgba(45, 90, 39, 0.25);
    border-radius: 10px;
    background: rgba(45, 90, 39, 0.06);
    color: var(--color-brown-bark);
  }
  .push-paused-text {
    flex: 1;
    min-width: 0;
  }
  .push-paused-text strong {
    display: block;
    font-size: 0.85rem;
    color: var(--color-green-dark);
  }
  .push-paused-text p {
    margin: 0.15rem 0 0;
    font-size: 0.78rem;
    color: #6b6b6b; /* AA sobre panel claro */
  }
  .push-paused .btn {
    flex-shrink: 0;
    min-height: 44px;
    font-size: 0.8rem;
  }

  .danger-zone {
    border-top: 1px dashed rgba(204, 0, 0, 0.35);
    padding-top: 0.85rem;
    margin-top: 0.25rem;
  }

  .danger-zone .btn-danger {
    width: 100%;
    background: rgba(204, 0, 0, 0.08);
    color: #cc0000;
    border: 1px solid rgba(204, 0, 0, 0.35);
  }

  .danger-zone .btn-danger:hover:not(:disabled) {
    background: rgba(204, 0, 0, 0.16);
  }

  /* ── Tus datos, en claro: transparencia sobre el tratamiento ── */
  .data-transparency {
    background: rgba(45, 90, 39, 0.04);
    border: 1px solid rgba(45, 90, 39, 0.15);
    border-radius: 10px;
    padding: 0.85rem 1rem;
  }
  .data-transparency h3 {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-green-dark);
  }
  .data-points {
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .data-points li {
    position: relative;
    padding-left: 1.1rem;
    font-size: 0.82rem;
    line-height: 1.45;
    color: var(--color-brown-bark);
  }
  .data-points li::before {
    content: '✓';
    position: absolute;
    left: 0;
    color: var(--color-green-dark);
    font-weight: 700;
  }
  .data-points strong {
    color: var(--color-green-dark);
  }
  @media (max-width: 480px) {
    .data-transparency {
      padding: 0.7rem 0.75rem;
    }
    .data-points li {
      font-size: 0.78rem;
    }
  }

  /* ── Selector de idioma: pills gemelas al estilo mode-toggle de Día ── */
  .lang-selector {
    display: flex;
    background: rgba(0,0,0,0.04);
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
    width: fit-content;
  }
  .lang-option {
    padding: 0.5rem 1.1rem;
    min-height: 44px;
    border: none;
    border-radius: 8px;
    background: transparent;
    font-size: 0.85rem;
    font-weight: 600;
    color: #6b6b6b; /* AA (antes #888 = 3.5:1) */
    cursor: pointer;
    transition: all 0.2s;
  }
  .lang-option.active {
    background: white;
    color: var(--color-green-dark);
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }
  .lang-hint {
    margin: 0.4rem 0 0;
    font-size: 0.75rem;
    color: #6b6b6b; /* AA (antes #999) */
  }

  .danger-zone .btn-danger:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  .backup-info {
    font-size: 0.75rem;
    color: #666;
    margin: 0;
    line-height: 1.4;
    text-align: center;
  }

  /* ── Cuenta y sincronización ── */
  .settings-section h3 {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .sync-hint {
    font-size: 0.78rem;
    color: #666;
    margin: 0;
    line-height: 1.45;
  }

  .sync-status-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .sync-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .sync-dot.sync-synced { background: #2d5a27; box-shadow: 0 0 6px rgba(45, 90, 39, 0.5); }
  .sync-dot.sync-syncing { background: #f59e0b; animation: pulse 1.2s infinite; }
  .sync-dot.sync-error { background: #e53e3e; }
  .sync-dot.sync-offline { background: #a0aec0; }
  .sync-dot.sync-local { background: #a0aec0; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .sync-status-text {
    flex: 1;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-main);
    min-width: 0;
  }

  .btn-sync-refresh,
  .btn-sync-logout {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: white;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 8px;
    padding: 0.35rem 0.6rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-brown-bark, #5c4033);
    cursor: pointer;
    transition: all 0.2s;
    flex-shrink: 0;
  }

  .btn-sync-refresh:hover:not(:disabled) {
    background: rgba(45, 90, 39, 0.08);
    color: var(--color-green-dark, #2d5a27);
  }

  .btn-sync-refresh:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .btn-sync-logout:hover {
    background: #fff5f5;
    color: #e53e3e;
  }

  .auth-tabs {
    display: flex;
    background: rgba(0, 0, 0, 0.04);
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
  }

  .auth-tabs button {
    flex: 1;
    border: none;
    background: transparent;
    padding: 0.6rem 0.5rem;
    min-height: 44px;
    border-radius: 8px;
    font-size: 0.8rem;
    font-weight: 600;
    color: #6b6b6b; /* AA (antes #888 = 3.5:1) */
    cursor: pointer;
    transition: all 0.2s;
  }

  .auth-tabs button.active {
    background: white;
    color: var(--color-green-dark, #2d5a27);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  }

  .auth-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .auth-form input {
    padding: 0.55rem 0.75rem;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    font-size: 0.85rem;
    min-width: 0;
  }

  .auth-form input:focus {
    outline: none;
    border-color: rgba(45, 90, 39, 0.5);
  }

  .auth-error {
    margin: 0;
    font-size: 0.78rem;
    color: #e53e3e;
    font-weight: 600;
  }

  .auth-submit {
    justify-content: center;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
  }

  .auth-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .category-edit-item input[type="text"] {
    flex: 1;
    min-width: 0;
  }

  /* Regla dura #5 (AGENTS.md): todo target táctil ≥ 44px. Medido a 360px:
     inputs 35px, selects 42px, color wells 32×32, remove-cat 40×40, auth inputs 35px.
     Agrupado por intención: texto/selección (44px + 16px anti-zoom iOS), color, acción. */
  @media (max-width: 768px) {
    /* Texto y selección: el 16px evita el auto-zoom de iOS (<16px al enfocar) */
    input[type="text"],
    input[type="email"],
    input[type="password"],
    select,
    .form-group-compact select,
    .auth-form input,
    .category-edit-item input[type="text"] {
      min-height: 44px;
      font-size: 16px;
    }
    input[type="color"] {
      width: 44px;
      height: 44px;
    }
    .remove-cat {
      min-width: 44px;
      min-height: 44px;
    }
    .btn-backup,
    .import-btn {
      min-height: 44px;
    }
  }

  @media (max-width: 640px) {
    .modal-content {
      max-width: 100%;
      padding: 1.25rem;
    }
    .modal-header {
      margin-bottom: 1.25rem;
    }
    .settings-sections {
      gap: 1.25rem;
    }
    .range-selector {
      padding: 0.75rem;
      gap: 1rem;
    }
    .backup-actions {
      flex-direction: column;
    }
    .import-filename {
      max-width: 100%;
    }
  }
</style>

<script lang="ts">
  import { db, exportData, validateImport, importValidatedData, type ValidationResult } from '../lib/db.ts';
  import { isLoggedIn, syncNow, initialSyncAfterLogin, resetSyncAfterLogout, onSyncChange } from '../lib/sync';
  import type { SyncStatus } from '../lib/types';
  import { Cloud, CloudUpload, LogIn, LogOut, RefreshCw, UserPlus } from '@lucide/svelte';
  import type { Category } from '../lib/types.ts';
  import { X, Save, Plus, Trash2, Download, Upload, GripVertical } from '@lucide/svelte';
  import { dndzone } from 'svelte-dnd-action';
  import { flip } from 'svelte/animate';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr } from '../lib/toast';
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

  $effect(() => {
    isLoggedIn().then(v => { loggedIn = v; authLoading = false; });
    const off = onSyncChange((s) => { syncStatus = s; });
    return off;
  });

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
        authError = data?.error ?? 'Error de autenticación';
        return;
      }
      loggedIn = true;
      authPassword = '';
      syncMessage = 'Sincronizando…';
      await initialSyncAfterLogin();
      syncMessage = '✅ Sincronizado con la nube';
    } catch (err: any) {
      authError = err?.message ?? 'Error de red';
    } finally {
      authBusy = false;
    }
  }

  async function handleLogout() {
    await fetch('/api/auth?op=logout', { method: 'POST', credentials: 'same-origin' });
    loggedIn = false;
    authEmail = '';
    resetSyncAfterLogout();
    syncMessage = '';
  }

  async function handleManualSync() {
    syncMessage = 'Sincronizando…';
    try {
      await syncNow(true);
      syncMessage = '✅ Sincronizado';
    } catch (err: any) {
      syncMessage = '⚠️ ' + (err?.message ?? 'Error de sync');
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
    localCategories = e.detail.items.map((item: any, index: number) => ({ ...item, order: index }));
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
      const stampSet = Date.now();
      await db.settings.put({ id: 'startHour', key: 'startHour', value: startHour, updatedAt: stampSet });
      await db.settings.put({ id: 'endHour', key: 'endHour', value: endHour, updatedAt: stampSet });

      const snapshot: Category[] = $state.snapshot(localCategories).map((c, i) => ({ ...c, order: i }));

      // Borrado real: eliminar de la BD las categorías que ya no están en la lista
      const keptIds = new Set(snapshot.map(c => c.id));
      const existing = await db.categories.toArray();
      const removed = existing.filter(c => !keptIds.has(c.id));

      // Reasignar actividades (y overrides) que usaban categorías eliminadas
      if (removed.length > 0) {
        const removedIds = new Set(removed.map(c => c.id));
        await db.transaction('rw', db.activities, db.categories, db.dayOverrides, async () => {
          const acts = await db.activities.toArray();
          const orphans = acts.filter(a => removedIds.has(a.categoryId));
          if (orphans.length > 0) {
            const stamp = Date.now();
            await db.activities.bulkPut(orphans.map(a => ({ ...a, categoryId: 'rutina', updatedAt: stamp })));
          }
          const overrides = await db.dayOverrides.toArray();
          const dirtyOverrides = overrides.filter(o => o.activities?.some(a => removedIds.has(a.categoryId)));
          if (dirtyOverrides.length > 0) {
            const stampOv = Date.now();
            await db.dayOverrides.bulkPut(dirtyOverrides.map(o => ({
              ...o,
              activities: o.activities.map(a => removedIds.has(a.categoryId) ? { ...a, categoryId: 'rutina' } : a),
              updatedAt: stampOv
            })));
          }
          const stampCat = Date.now();
          await db.categories.bulkPut(removed.map(c => ({ ...c, deletedAt: stampCat, updatedAt: stampCat })));
        });
        const names = removed.map(c => `"${c.label}"`).join(', ');
        toastOk(`Categorías eliminadas: ${names}. Sus actividades ahora pertenecen a "Rutina".`);
      }

      if (snapshot.length > 0) {
        await db.categories.bulkPut(snapshot);
      }

      toastOk('Ajustes guardados ✓');
      onClose();
    } catch (err: any) {
      console.error('Error saving settings:', err);
      toastErr('Error al guardar: ' + (err.message || 'Error desconocido'));
    }
  }

  function addCategory() {
    const id = `cat-${Date.now()}`;
    localCategories = [
      ...localCategories,
      { id, label: 'Nueva Categoría', color: '#999999', order: localCategories.length }
    ];
  }

  function removeCategory(id: string) {
    localCategories = localCategories.filter(c => c.id !== id);
  }

  function updateCategory(id: string, field: string, value: any) {
    localCategories = localCategories.map(c => 
      c.id === id ? { ...c, [field]: value } : c
    );
  }

  function restoreDefaults() {
    confirmRestoreCats = true;
  }

  async function restoreDefaultsConfirm() {
    const { INITIAL_CATEGORIES } = await import('../lib/db.ts');
    localCategories = [...INITIAL_CATEGORIES];
    toastOk('Categorías restablecidas — pulsa Guardar Todo para aplicar');
  }

  async function handleExport() {
    try {
      const data = await exportData();
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `planificador-datos-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      // Revocar con delay: revocar inmediatamente puede cortar la descarga en algunos navegadores
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err: any) {
      toastErr('Error al exportar: ' + err.message);
    }
  }

  // Límite de tamaño razonable para un archivo de respaldo (~10 MB; las imágenes viven en la nube)
  const MAX_IMPORT_SIZE = 10 * 1024 * 1024;

  async function handleImport(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // reset DESPUÉS de capturar el file (asignar value='' limpia input.files)
    if (!file) return;
    if (file.size > MAX_IMPORT_SIZE) {
      toastErr(`El archivo es demasiado grande (${(file.size / 1024 / 1024).toFixed(1)} MB). El límite es ${MAX_IMPORT_SIZE / 1024 / 1024} MB.`);
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      toastErr('No se pudo leer el archivo. Verifica que exista y que tengas permisos sobre él.');
    };
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;

        // 1) Validar ANTES de tocar la base de datos
        const validation = validateImport(text);
        if (!validation.valid) {
          toastErr('No se pudo importar:\n' + validation.error);
          return;
        }

        // 2) Confirmar con resumen + advertencias antes de reemplazar TODO
        const { summary, warnings } = validation;
        const s = summary;
        pendingImport = {
          validation,
          summary: [
            `Actividades: ${s.activities}`,
            `Categorías: ${s.categories}`,
            `Ajustes: ${s.settings}`,
            `Ediciones temporales por día: ${s.dayOverrides}`
          ].join('\n'),
          warnings:
            warnings.length > 6
              ? [...warnings.slice(0, 6), `… y ${warnings.length - 6} advertencias más`]
              : warnings
        };
        confirmImport = true;
      } catch (err: any) {
        toastErr('Error al importar: ' + (err?.message || 'Error desconocido'));
      }
    };
    reader.readAsText(file);
  }

  async function doImport() {
    if (!pendingImport) return;
    try {
      await importValidatedData(pendingImport.validation);
      confirmImport = false;

      // Con sesión activa: push completo inmediato. Los registros importados suelen
      // traer updatedAt antiguos (o 0) y no entrarían en el push incremental.
      if (await isLoggedIn()) {
        try {
          await syncNow(true);
          toastOk('Datos importados y sincronizados con la nube ✓');
        } catch {
          toastErr('Datos importados en este dispositivo. La subida a la nube falló — reintenta desde el banner de sincronización.');
        }
      } else {
        toastOk('Datos importados con éxito ✓');
      }
    } catch (err: any) {
      toastErr('Error al importar: ' + (err?.message || 'Error desconocido'));
    }
  }
</script>

<div class="modal-overlay" onclick={onClose}>
  <div class="modal-content glass-panel" tabindex="-1" bind:this={panelEl} onkeydown={trapFocus} onclick={e => e.stopPropagation()}>
    <header class="modal-header">
      <h2>Configuración</h2>
      <button class="close-btn" onclick={onClose} aria-label="Cerrar ajustes"><X size={20} /></button>
    </header>

    <div class="settings-sections">
      <!-- ── Cuenta y respaldo en la nube ── -->
      <section class="settings-section">
        <h3><Cloud size={16} /> Cuenta y respaldo en la nube</h3>
        {#if authLoading}
          <p class="sync-hint">Comprobando sesión…</p>
        {:else if loggedIn}
          <div class="sync-status-row">
            <span class="sync-dot sync-{syncStatus}" aria-hidden="true"></span>
            <span class="sync-status-text">
              {#if syncStatus === 'synced'}Sincronizado con la nube{:else if syncStatus === 'syncing'}Sincronizando…{:else if syncStatus === 'error'}Error de sincronización{:else if syncStatus === 'offline'}Sin conexión — cambios guardados localmente{:else}Solo local (sin respaldo en la nube){/if}
            </span>
            <button class="btn-sync-refresh" onclick={handleManualSync} title="Sincronizar ahora" disabled={syncStatus === 'syncing'}>
              <RefreshCw size={14} />
            </button>
            <button class="btn-sync-logout" onclick={handleLogout} title="Cerrar sesión">
              <LogOut size={14} /> Salir
            </button>
          </div>
          {#if syncMessage}<p class="sync-hint">{syncMessage}</p>{/if}
        {:else}
          <p class="sync-hint">Crea una cuenta o inicia sesión para respaldar tus datos y sincronizarlos entre dispositivos. Todo sigue funcionando offline.</p>
          <div class="auth-tabs">
            <button class:active={authMode === 'login'} onclick={() => authMode = 'login'}>Iniciar sesión</button>
            <button class:active={authMode === 'register'} onclick={() => authMode = 'register'}>Crear cuenta</button>
          </div>
          <div class="auth-form">
            {#if authMode === 'register'}
              <input type="text" placeholder="Nombre (opcional)" bind:value={authName} autocomplete="name" />
            {/if}
            <input type="email" placeholder="Email" bind:value={authEmail} autocomplete="email" />
            <input type="password" placeholder="Contraseña (mín. 8 caracteres)" bind:value={authPassword} autocomplete={authMode === 'login' ? 'current-password' : 'new-password'} />
            {#if authError}<p class="auth-error">{authError}</p>{/if}
            <button class="btn btn-primary auth-submit" onclick={handleAuth} disabled={authBusy || !authEmail || !authPassword}>
              {#if authMode === 'login'}<LogIn size={15} /> Entrar{:else}<UserPlus size={15} /> Crear cuenta{/if}
            </button>
          </div>
        {/if}
      </section>

      <section class="settings-section">
        <h3>Límites del Horario (Rango diario)</h3>
        <div class="range-selector">
          <div class="range-inputs-horizontal">
            <div class="form-group-compact">
              <label for="set-start">Empieza a las:</label>
              <select id="set-start" bind:value={startHour}>
                {#each startOptions as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </div>
            
            <div class="to-text">a las</div>

            <div class="form-group-compact">
              <label for="set-end">Termina a las:</label>
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
            <p class="range-summary">Tu día tiene <strong>{endHour - startHour} horas</strong> de planificación.</p>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <header class="section-header">
          <h3>Categorías</h3>
        </header>
        <div 
          class="categories-list" 
          use:dndzone={{items: localCategories, flipDurationMs, type: 'categories'}} 
          onconsider={handleDndConsider} 
          onfinalize={handleDndFinalize}
        >
          {#each localCategories as cat (cat.id)}
            <div class="category-edit-item" animate:flip={{duration: flipDurationMs}}>
              <div class="grip-handle">
                <GripVertical size={16} />
              </div>
              <input type="color" value={cat.color} aria-label="Color de {cat.label}" oninput={e => updateCategory(cat.id, 'color', e.currentTarget.value)} />
              <input type="text" value={cat.label} aria-label="Nombre de la categoría" oninput={e => updateCategory(cat.id, 'label', e.currentTarget.value)} />
              <button class="remove-cat" onclick={() => removeCategory(cat.id)} aria-label="Quitar la categoría {cat.label}">
                <Trash2 size={16} />
              </button>
            </div>
          {/each}
        </div>
        <div class="categories-footer">
          <button class="btn btn-secondary btn-full" onclick={addCategory}>
            <Plus size={16} /> Añadir nueva categoría
          </button>
        </div>
      </section>

      <section class="settings-section">
        <header class="section-header">
          <h3>Datos y Respaldo</h3>
        </header>
        <div class="backup-container">
          <div class="backup-actions">
            <button class="btn btn-secondary btn-backup" onclick={handleExport}>
              <Download size={18} /> Exportar JSON
            </button>
            
            <label class="btn btn-secondary btn-backup import-label">
              <Upload size={18} /> Importar JSON
              <input type="file" accept=".json,.txt,application/json,text/plain" onchange={handleImport} hidden />
            </label>
          </div>
          <p class="backup-info">Exporta actividades, categorías, ediciones temporales e imágenes para respaldarlas o moverlas a otro navegador. Al importar se te pedirá confirmación y verás un resumen antes de reemplazar tus datos.</p>
        </div>
      </section>
    </div>

    <footer class="modal-footer">
      <button class="btn btn-secondary" onclick={onClose}>Cancelar</button>
      <button class="btn btn-primary" onclick={saveSettings}>
        <Save size={18} /> Guardar Todo
      </button>
    </footer>
  </div>
</div>

<ConfirmDialog
  bind:open={confirmRestoreCats}
  title="Restablecer categorías"
  message="¿Restablecer todas las categorías a las originales? Los cambios no se aplican hasta que pulses Guardar Todo."
  confirmText="Restablecer"
  onconfirm={() => restoreDefaultsConfirm()}
/>

<ConfirmDialog
  bind:open={confirmImport}
  title="¿Importar este archivo?"
  message={pendingImport
    ? `REEMPLAZARÁ TODOS tus datos actuales por el contenido del archivo:\n\n${pendingImport.summary}${pendingImport.warnings.length ? '\n\n⚠️ Advertencias:\n• ' + pendingImport.warnings.join('\n• ') : ''}\n\nEsta acción no se puede deshacer.`
    : ''}
  confirmText="Importar"
  danger
  onconfirm={doImport}
  oncancel={() => pendingImport = null}
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
    color: #999;
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
    color: #999;
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
    color: #999;
    margin-top: 0.5rem;
  }

  .range-summary {
    text-align: center;
    font-size: 0.9rem;
    color: var(--color-brown-bark);
    margin-top: 1rem;
    opacity: 0.8;
  }

  .form-row {
    display: flex;
    gap: 1rem;
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

  .btn-small {
    padding: 0.5rem 0.85rem;
    min-height: 44px;
    font-size: 0.8rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
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
    color: #999;
    cursor: grab;
    display: flex;
    align-items: center;
    padding: 0 0.25rem;
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

  .btn-backup {
    flex: 1;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.6rem;
    cursor: pointer;
    background: white;
  }

  .import-label {
    margin: 0;
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
    color: #888;
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
  }
</style>

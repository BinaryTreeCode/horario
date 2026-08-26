<script lang="ts">
  import { db, exportData, importData } from '../lib/db.ts';
  import type { Category } from '../lib/types.ts';
  import { X, Save, Plus, Trash2, Download, Upload, GripVertical } from 'lucide-svelte';
  import { dndzone } from 'svelte-dnd-action';
  import { flip } from 'svelte/animate';

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
      await db.settings.put({ id: 'startHour', key: 'startHour', value: startHour });
      await db.settings.put({ id: 'endHour', key: 'endHour', value: endHour });
      
      if (localCategories.length > 0) {
        // Use bulkPut to update existing categories or add new ones
        await db.categories.bulkPut($state.snapshot(localCategories));
      }
      
      console.log('Settings and categories saved successfully');
      onClose();
    } catch (err: any) {
      console.error('Error saving settings:', err);
      alert('Error al guardar: ' + (err.message || 'Error desconocido'));
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

  async function restoreDefaults() {
    if (confirm('¿Restablecer todas las categorías a las originales? (No se guardará hasta hacer clic en Guardar Todo)')) {
      const { INITIAL_CATEGORIES } = await import('../lib/db.ts');
      localCategories = [...INITIAL_CATEGORIES];
    }
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
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert('Error al exportar: ' + err.message);
    }
  }

  async function handleImport(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;
        await importData(text);
        alert('Datos importados con éxito. La aplicación se recargará para aplicar los cambios.');
        window.location.reload();
      } catch (err: any) {
        alert('Error al importar: ' + err.message);
      }
    };
    reader.readAsText(file);
  }
</script>

<div class="modal-overlay" onclick={onClose}>
  <div class="modal-content glass-panel" onclick={e => e.stopPropagation()}>
    <header class="modal-header">
      <h2>Configuración</h2>
      <button class="close-btn" onclick={onClose}><X size={20} /></button>
    </header>

    <div class="settings-sections">
      <section class="settings-section">
        <h3>Límites del Horario (Rango diario)</h3>
        <div class="range-selector">
          <div class="range-inputs-horizontal">
            <div class="form-group-compact">
              <label>Empieza a las:</label>
              <select bind:value={startHour}>
                {#each startOptions as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
            </div>
            
            <div class="to-text">a las</div>

            <div class="form-group-compact">
              <label>Termina a las:</label>
              <select bind:value={endHour}>
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
              <input type="color" value={cat.color} oninput={e => updateCategory(cat.id, 'color', e.currentTarget.value)} />
              <input type="text" value={cat.label} oninput={e => updateCategory(cat.id, 'label', e.currentTarget.value)} />
              <button class="remove-cat" onclick={() => removeCategory(cat.id)}>
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
              <input type="file" accept=".json" onchange={handleImport} hidden />
            </label>
          </div>
          <p class="backup-info">Exporta tus actividades y categorías para respaldarlas o moverlas a otro navegador.</p>
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
    padding: 0.25rem 0.5rem;
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
</style>

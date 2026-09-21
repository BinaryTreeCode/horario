<script lang="ts">
  import { onMount } from 'svelte';
  import { db, newId } from '../lib/db.ts';
  import type { Activity, Category, ActivityStep } from '../lib/types.ts';
  import { X, Trash2, CheckCircle, Plus, CheckSquare, Square, ListChecks, Sparkles, Zap, Calendar, ImageIcon, Link2 } from 'lucide-svelte';
  import ImageLightbox from './ImageLightbox.svelte';

  interface Props {
    id: string | null;
    categories: Category[];
    settings: { startHour: number; endHour: number };
    targetDay?: number | null;
    initialData?: Activity | null;
    onClose: () => void;
  }

  let { id, categories, settings, targetDay = null, initialData = null, onClose }: Props = $props();

  let categoryId = $state('');
  let name = $state('');
  let description = $state('');
  let startTime = $state('08:00');
  let endTime = $state('09:00');
  let daysOfWeek = $state([0, 1, 2, 3, 4, 5, 6]);
  let steps = $state<ActivityStep[]>([]);
  let newStepInput = $state('');
  let image = $state<string | null>(null);
  let imageUrlInput = $state('');
  let showImageUrlInput = $state(false);
  let showImagePreview = $state(false);
  let previewActivity = $state<Activity | null>(null);
  let modalEl: HTMLElement | undefined = $state();

  // Scope: 'day' writes to dayOverrides, 'week' writes to db.activities
  let saveScope = $state<'day' | 'week'>('week');
  $effect(() => {
    saveScope = targetDay !== null ? 'day' : 'week';
  });

  // Derived category color for preview
  const activeCategory = $derived(categories.find(c => c.id === categoryId));
  const categoryColor = $derived(activeCategory?.color || '#eeeeee');

  // Format 12h for labels
  function format12h(timeStr: string) {
    const [h, m] = timeStr.split(':').map(Number);
    const period = h < 12 ? 'AM' : (h >= 24 ? 'AM' : 'PM');
    const h12 = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
  }

  // Duration in minutes
  const durationMinutes = $derived.by(() => {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    return diff > 0 ? diff : 0;
  });

  // Ensure categoryId is set
  $effect(() => {
    if (!categoryId && categories.length > 0) {
      categoryId = categories[0].id;
    }
  });

  // Cerrar con Esc (sin robar el foco si hay un lightbox de imagen abierto encima)
  $effect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !showImagePreview) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  function trapFocus(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !modalEl) return;
    const focusables = modalEl.querySelectorAll<HTMLElement>(
      'button:not([hidden]), input:not([hidden]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
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

  // Time options (every 15 mins) within configured schedule limits
  const allTimes = $derived(() => {
    const times = [];
    const start = settings.startHour;
    const end = settings.endHour;
    for (let h = start; h < end; h++) {
      for (const m of [0, 15, 30, 45]) {
        const hStr = h.toString().padStart(2, '0');
        const mStr = m.toString().padStart(2, '0');
        times.push({ value: `${hStr}:${mStr}`, label: format12h(`${hStr}:${mStr}`) });
      }
    }
    const endStr = end.toString().padStart(2, '0');
    times.push({ value: `${endStr}:00`, label: format12h(`${endStr}:00`) });
    return times;
  });

  const startTimeOptions = $derived(
    (() => {
      const opts = allTimes().filter(t => parseMinutes(t.value) < settings.endHour * 60);
      if (startTime && !opts.some(o => o.value === startTime)) {
        opts.push({ value: startTime, label: format12h(startTime) });
        opts.sort((a, b) => parseMinutes(a.value) - parseMinutes(b.value));
      }
      return opts;
    })()
  );

  const endTimeOptions = $derived(() => {
    const sMin = parseMinutes(startTime);
    const opts = allTimes().filter(t => parseMinutes(t.value) > sMin);
    if (endTime && !opts.some(o => o.value === endTime)) {
      opts.push({ value: endTime, label: format12h(endTime) });
      opts.sort((a, b) => parseMinutes(a.value) - parseMinutes(b.value));
    }
    return opts;
  });

  function parseMinutes(timeStr: string) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  function addDuration(durationMins: number) {
    const sMin = parseMinutes(startTime);
    const newEndMin = sMin + durationMins;
    const h = Math.floor(newEndMin / 60);
    const m = newEndMin % 60;
    endTime = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  // ── Imagen de la rutina ─────────────────────────────────────────
  function handleImageFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toastErr('El archivo seleccionado no es una imagen.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toastErr('La imagen es muy grande (máximo 2 MB) para guardarla en la base de datos local.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      image = reader.result as string;
      showImageUrlInput = false;
      imageUrlInput = '';
    };
    reader.readAsDataURL(file);
    input.value = '';
  }

  function applyImageUrl() {
    const url = imageUrlInput.trim();
    if (!url) return;
    image = url;
    imageUrlInput = '';
    showImageUrlInput = false;
  }

  function removeImage() {
    image = null;
    showImageUrlInput = false;
    imageUrlInput = '';
  }

  function openImagePreview() {
    if (!image) return;
    previewActivity = {
      categoryId,
      name: name || 'Actividad',
      startTime,
      endTime,
      daysOfWeek: [...daysOfWeek],
      steps: $state.snapshot(steps),
      image
    };
    showImagePreview = true;
  }

  function addStep() {
    if (!newStepInput.trim()) return;
    steps = [
      ...steps,
      {
        id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: newStepInput.trim(),
        completed: false
      }
    ];
    newStepInput = '';
  }

  function removeStep(stepId: string) {
    steps = steps.filter(s => s.id !== stepId);
  }

  function toggleStep(stepId: string) {
    steps = steps.map(s => s.id === stepId ? { ...s, completed: !s.completed } : s);
  }

  function applyRoutinePresets() {
    const defaultRoutineSteps = [
      'Beber vaso con agua y estirar',
      'Aseo personal / Ducha',
      'Desayuno nutritivo',
      'Revisar objetivos del día'
    ];
    const newSteps = defaultRoutineSteps.map(t => ({
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: t,
      completed: false
    }));
    steps = [...steps, ...newSteps];
    toastOk('4 pasos sugeridos agregados');
  }

  const days = [
    { label: 'L', index: 0 },
    { label: 'M', index: 1 },
    { label: 'M', index: 2 },
    { label: 'J', index: 3 },
    { label: 'V', index: 4 },
    { label: 'S', index: 5 },
    { label: 'D', index: 6 },
  ];

  onMount(async () => {
    // If initialData is provided (from dayOverride), use it
    if (initialData) {
      categoryId = initialData.categoryId;
      name = initialData.name;
      description = initialData.description || '';
      startTime = initialData.startTime;
      endTime = initialData.endTime;
      daysOfWeek = [...(initialData.daysOfWeek || [])];
      steps = initialData.steps ? [...initialData.steps] : [];
      image = initialData.image || null;
    } else if (id !== null) {
      const activity = await db.activities.get(id);
      if (activity) {
        categoryId = activity.categoryId;
        name = activity.name;
        description = activity.description || '';
        startTime = activity.startTime;
        endTime = activity.endTime;
        daysOfWeek = [...activity.daysOfWeek];
        steps = activity.steps ? [...activity.steps] : [];
        image = activity.image || null;
      }
    } else {
      const defaultStart = Math.max(settings.startHour, 8);
      const defaultEnd = Math.min(defaultStart + 1, settings.endHour);

      const startHStr = defaultStart.toString().padStart(2, '0');
      const endHStr = defaultEnd.toString().padStart(2, '0');

      startTime = `${startHStr}:00`;
      endTime = `${endHStr}:00`;
    }
  });

  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr } from '../lib/toast';

  async function save() {
    try {
      if (!categoryId) {
        toastErr('Por favor selecciona una categoría');
        return;
      }

      const activity: Activity = {
        categoryId,
        name,
        description,
        startTime,
        endTime,
        daysOfWeek: [...daysOfWeek],
        steps: $state.snapshot(steps),
        ...(image ? { image } : {}),
        updatedAt: Date.now()
      };

      if (targetDay !== null && saveScope === 'day') {
        // Save to dayOverrides (temporary, day-only)
        const existing = await db.dayOverrides.get(targetDay);
        let overrideActs: Activity[] = existing?.activities
          ? existing.activities.map(a => ({ ...a }))
          : [];

        if (id !== null) {
          // Update existing activity in override
          const idx = overrideActs.findIndex(a => a.id === id);
          if (idx >= 0) {
            activity.id = id;
            overrideActs[idx] = activity;
          } else {
            // Activity doesn't exist in override yet — add it
            activity.id = id;
            overrideActs.push(activity);
          }
        } else {
          // New activity: assign a temporary ID
          activity.id = newId();
          overrideActs.push(activity);
        }

        await db.dayOverrides.put({
          day: targetDay,
          activities: overrideActs,
          updatedAt: Date.now()
        });
      } else {
        // Save to master db.activities (permanent)
        if (id !== null) {
          activity.id = id;
          await db.activities.put(activity);
        } else {
          await db.activities.add(activity);
        }
      }

      toastOk(id !== null ? 'Actividad actualizada ✓' : 'Actividad creada ✓');
      onClose();
    } catch (error: any) {
      console.error('Failed to save activity:', error);
      toastErr('Error al guardar: ' + (error.message || 'Error desconocido'));
    }
  }

  async function remove() {
    if (id !== null) {
      if (targetDay !== null && saveScope === 'day') {
        // Remove from dayOverrides
        const existing = await db.dayOverrides.get(targetDay);
        if (existing?.activities) {
          const filtered = existing.activities.filter(a => a.id !== id);
          await db.dayOverrides.put({
            day: targetDay,
            activities: filtered,
            updatedAt: Date.now()
          });
        }
      } else {
        // Borrado suave (tombstone) para que el sync lo propague a otros dispositivos
        await db.activities.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
      }
      toastOk('Actividad eliminada');
      onClose();
    }
  }

  let confirmRemove = $state(false);

  function toggleDay(index: number) {
    if (daysOfWeek.includes(index)) {
      daysOfWeek = daysOfWeek.filter(d => d !== index);
    } else {
      daysOfWeek = [...daysOfWeek, index].sort();
    }
  }

  function selectWeekdays() {
    daysOfWeek = [0, 1, 2, 3, 4];
  }

  function selectAll() {
    daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
  }
</script>

<div class="modal-overlay" onclick={onClose}>
  <div class="modal-content glass-panel" tabindex="-1" bind:this={modalEl} onkeydown={trapFocus} onclick={e => e.stopPropagation()}>
    <header class="modal-header">
      <h2>{id !== null ? 'Editar' : 'Nueva'} Actividad</h2>
      <button class="close-btn" onclick={onClose} aria-label="Cerrar sin guardar"><X size={20} /></button>
    </header>

    <form onsubmit={e => { e.preventDefault(); save(); }}>
      <div class="category-preview" style="background: {categoryColor}"></div>

      <!-- Scope selector (only shown when opened from daily view) -->
      {#if targetDay !== null}
        <div class="scope-selector">
          <label class="scope-label">Guardar en:</label>
          <div class="scope-options">
            <label class="scope-option" class:selected={saveScope === 'day'}>
              <input type="radio" name="scope" value="day" bind:group={saveScope} />
              <Zap size={14} />
              <span>Solo este día (Temporal)</span>
            </label>
            <label class="scope-option" class:selected={saveScope === 'week'}>
              <input type="radio" name="scope" value="week" bind:group={saveScope} />
              <Calendar size={14} />
              <span>Plantilla semanal</span>
            </label>
          </div>
        </div>
      {/if}

      <div class="form-group">
        <label for="act-category">Categoría</label>
        <select id="act-category" bind:value={categoryId} required>
          {#each categories as cat}
            <option value={cat.id}>{cat.label}</option>
          {/each}
        </select>
      </div>

      <div class="form-group">
        <label for="act-name">¿Qué vas a hacer?</label>
        <input id="act-name" type="text" bind:value={name} placeholder="Ej. Rutina Matutina" required class="input-large" />
      </div>

      <!-- Sección de Imagen de la rutina -->
      <div class="image-box">
        <div class="image-header">
          <div class="image-title">
            <ImageIcon size={18} />
            <span>Imagen de la rutina</span>
          </div>
          {#if image}
            <div class="image-header-actions">
              <button type="button" class="image-btn" onclick={openImagePreview} title="Ver imagen ampliada">
                Ver
              </button>
              <button type="button" class="image-btn image-btn-danger" onclick={removeImage} title="Quitar imagen">
                <Trash2 size={14} /> Quitar
              </button>
            </div>
          {/if}
        </div>

        {#if image}
          <button type="button" class="image-preview" onclick={openImagePreview} title="Ver imagen ampliada">
            <img src={image} alt="Imagen de la rutina" />
          </button>
        {:else}
          <div class="image-actions">
            <label class="image-upload-btn">
              <input type="file" accept="image/*" onchange={handleImageFile} hidden />
              <ImageIcon size={16} /> Subir archivo
            </label>
            <button type="button" class="image-upload-btn" onclick={() => showImageUrlInput = !showImageUrlInput}>
              <Link2 size={16} /> Usar URL
            </button>
          </div>

          {#if showImageUrlInput}
            <div class="image-url-row">
              <input
                type="url"
                bind:value={imageUrlInput}
                placeholder="https://ejemplo.com/imagen.jpg"
                onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); applyImageUrl(); } }}
              />
              <button type="button" class="image-upload-btn" onclick={applyImageUrl}>OK</button>
            </div>
          {/if}
        {/if}
      </div>

      <!-- Sección de Pasos / Subtareas -->
      <div class="steps-box">
        <div class="steps-header">
          <div class="steps-title">
            <ListChecks size={18} />
            <span>Pasos / Subtareas ({steps.length})</span>
          </div>
          {#if steps.length === 0}
            <button type="button" class="preset-btn-sparkle" onclick={applyRoutinePresets} aria-label="Sugerir pasos de rutina según la categoría">
              <Sparkles size={14} /> Sugerir rutina
            </button>
          {/if}
        </div>

        <div class="step-add-row">
          <input
            type="text"
            bind:value={newStepInput}
            placeholder="Escribe un paso y presiona Enter..."
            aria-label="Nuevo paso"
            class="step-input"
            onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); addStep(); } }}
          />
          <button type="button" class="btn-add-step" onclick={addStep} title="Agregar paso" aria-label="Agregar paso">
            <Plus size={18} /> Añadir
          </button>
        </div>

        {#if steps.length > 0}
          <div class="steps-list">
            {#each steps as step, index (step.id)}
              <div class="step-item" class:completed={step.completed}>
                <button
                  type="button"
                  class="step-check-btn"
                  onclick={() => toggleStep(step.id)}
                  title={step.completed ? "Marcar como pendiente" : "Marcar como completado"}
                >
                  {#if step.completed}
                    <CheckSquare size={18} class="check-icon done" />
                  {:else}
                    <Square size={18} class="check-icon" />
                  {/if}
                </button>
                <input
                  type="text"
                  bind:value={step.title}
                  class="step-text-input"
                  class:done-text={step.completed}
                />
                <button
                  type="button"
                  class="step-delete-btn"
                  onclick={() => removeStep(step.id)}
                  title="Eliminar paso"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="time-controls-box">
        <div class="time-row-modern">
          <div class="time-picker-group">
            <label for="act-start">Desde</label>
            <select id="act-start" bind:value={startTime} class="time-select-modern">
              {#each startTimeOptions as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </div>

          <span class="to-separator">a</span>

          <div class="time-picker-group">
            <label for="act-end">Hasta</label>
            <select id="act-end" bind:value={endTime} class="time-select-modern">
              {#each endTimeOptions() as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="duration-controls">
          <span class="hint-text">Ajuste rápido:</span>
          <div class="duration-chips">
            <button type="button" class="chip" onclick={() => addDuration(15)}>15m</button>
            <button type="button" class="chip" onclick={() => addDuration(30)}>30m</button>
            <button type="button" class="chip" onclick={() => addDuration(45)}>45m</button>
            <button type="button" class="chip" onclick={() => addDuration(60)}>1h</button>
            <button type="button" class="chip" onclick={() => addDuration(90)}>1.5h</button>
          </div>
        </div>

        <div class="duration-hint">
          Duración total: <strong>{durationMinutes >= 60 ? `${Math.floor(durationMinutes/60)}h ${durationMinutes%60}m` : `${durationMinutes}m`}</strong>
        </div>
      </div>

      <!-- Days selector: hide when saving only to this day's override -->
      {#if saveScope === 'week'}
        <div class="form-group">
          <label>Días de la semana</label>
          <div class="days-selector">
            {#each days as day}
              <button
                type="button"
                class="day-toggle"
                class:selected={daysOfWeek.includes(day.index)}
                aria-pressed={daysOfWeek.includes(day.index)}
                aria-label="{['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'][day.index]}"
                onclick={() => toggleDay(day.index)}
              >
                {day.label}
              </button>
            {/each}
          </div>
          <div class="presets">
            <button type="button" class="preset-btn" onclick={selectWeekdays}>Lunes a Viernes</button>
            <button type="button" class="preset-btn" onclick={selectAll}>Toda la semana</button>
          </div>
        </div>
      {/if}

      <footer class="modal-footer">
        {#if id !== null}
          <button type="button" class="btn btn-danger" onclick={() => confirmRemove = true}>
            <Trash2 size={18} /> Eliminar
          </button>
        {/if}
        <div class="footer-right">
          <button type="button" class="btn btn-secondary" onclick={onClose}>Cancelar</button>
          <button type="submit" class="btn btn-primary">
            <CheckCircle size={18} /> Guardar
          </button>
        </div>
      </footer>
    </form>
  </div>
</div>

<ConfirmDialog
  bind:open={confirmRemove}
  title="Eliminar actividad"
  message="¿Eliminar esta actividad? Esta acción no se puede deshacer."
  confirmText="Eliminar"
  danger
  on:confirm={remove}
/>

{#if showImagePreview && previewActivity}
  <ImageLightbox activity={previewActivity} onClose={() => { showImagePreview = false; previewActivity = null; }} />
{/if}

<style>
  /* ── Imagen de la rutina ── */
  .image-box {
    background: #f8faf9;
    border: 1px solid rgba(45, 90, 39, 0.12);
    border-radius: 10px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .image-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .image-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--color-brown-bark);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .image-header-actions {
    display: flex;
    gap: 0.4rem;
  }

  .image-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: white;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 6px;
    padding: 0.25rem 0.55rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--color-green-dark, #2d5a27);
    cursor: pointer;
    transition: all 0.2s;
  }

  .image-btn:hover {
    background: rgba(45, 90, 39, 0.08);
  }

  .image-btn-danger {
    color: #e53e3e;
  }

  .image-btn-danger:hover {
    background: #fff5f5;
  }

  .image-preview {
    border: none;
    padding: 0;
    background: none;
    cursor: zoom-in;
    border-radius: 8px;
    overflow: hidden;
    align-self: flex-start;
    max-width: 100%;
  }

  .image-preview img {
    display: block;
    max-width: 100%;
    max-height: 160px;
    border-radius: 8px;
    object-fit: cover;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    transition: transform 0.2s;
  }

  .image-preview:hover img {
    transform: scale(1.02);
  }

  .image-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .image-upload-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: white;
    border: 1px dashed rgba(45, 90, 39, 0.35);
    border-radius: 8px;
    padding: 0.45rem 0.8rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--color-green-dark, #2d5a27);
    cursor: pointer;
    transition: all 0.2s;
  }

  .image-upload-btn:hover {
    background: rgba(45, 90, 39, 0.06);
    border-style: solid;
  }

  .image-url-row {
    display: flex;
    gap: 0.5rem;
  }

  .image-url-row input {
    flex: 1;
    padding: 0.45rem 0.7rem;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    font-size: 0.85rem;
    min-width: 0;
  }

  .image-url-row input:focus {
    outline: none;
    border-color: rgba(45, 90, 39, 0.5);
  }

  /* ── Scope Selector ── */
  .scope-selector {
    background: #f8faf9;
    border: 1px solid rgba(45, 90, 39, 0.12);
    border-radius: 10px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .scope-label {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--color-brown-bark);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .scope-options {
    display: flex;
    gap: 0.5rem;
  }

  .scope-option {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 8px;
    background: white;
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 600;
    color: #888;
    transition: all 0.2s;
  }

  .scope-option input[type="radio"] {
    display: none;
  }

  .scope-option.selected {
    border-color: var(--color-green-dark);
    background: rgba(45, 90, 39, 0.06);
    color: var(--color-green-dark);
  }

  .scope-option:hover:not(.selected) {
    border-color: rgba(0,0,0,0.15);
    color: var(--color-brown-bark);
  }

  .steps-box {
    background: #f8faf9;
    border: 1px solid rgba(45, 90, 39, 0.15);
    border-radius: 12px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .steps-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .steps-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--color-green-dark);
  }

  .preset-btn-sparkle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(45, 90, 39, 0.08);
    border: 1px dashed var(--color-green-dark);
    color: var(--color-green-dark);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.25rem 0.6rem;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .preset-btn-sparkle:hover {
    background: var(--color-green-dark);
    color: white;
  }

  .step-add-row {
    display: flex;
    gap: 0.5rem;
  }

  .step-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border: 1px solid rgba(0,0,0,0.12);
    border-radius: 8px;
    font-size: 0.9rem;
    background: white;
  }

  .btn-add-step {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--color-green-dark);
    color: white;
    border: none;
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-add-step:hover {
    background: var(--color-green-moss);
  }

  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 200px;
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  .step-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: white;
    padding: 0.4rem 0.6rem;
    border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.06);
    transition: background 0.2s, border-color 0.2s;
  }

  .step-item.completed {
    background: rgba(45, 90, 39, 0.05);
    border-color: rgba(45, 90, 39, 0.2);
  }

  .step-check-btn {
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    color: #999;
    transition: color 0.2s;
  }

  .step-check-btn:hover {
    color: var(--color-green-dark);
  }

  .check-icon.done {
    color: var(--color-green-dark);
  }

  .step-text-input {
    flex: 1;
    border: none;
    background: transparent;
    font-size: 0.85rem;
    padding: 0.2rem 0.4rem;
    color: var(--text-main);
  }

  .step-text-input:focus {
    outline: none;
    background: rgba(0,0,0,0.02);
    border-radius: 4px;
  }

  .step-text-input.done-text {
    text-decoration: line-through;
    color: #888;
  }

  .step-delete-btn {
    background: transparent;
    border: none;
    padding: 0.25rem;
    cursor: pointer;
    color: #cc8888;
    border-radius: 4px;
    display: flex;
    align-items: center;
    transition: all 0.2s;
  }

  .step-delete-btn:hover {
    color: #dc2626;
    background: #fee2e2;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 200;
  }

  .modal-content {
    width: 95%;
    max-width: 500px;
    max-height: 92vh;
    padding: 0;
    overflow-y: auto;
    background: white;
    border-radius: 16px;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    animation: slideUp 0.3s ease-out;
    display: flex;
    flex-direction: column;
  }

  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .category-preview {
    height: 10px;
    width: 100%;
    flex-shrink: 0;
  }

  .modal-header, form {
    padding: 1.5rem 2rem;
  }

  .modal-header {
    padding-bottom: 0.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  form {
    padding-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .input-large {
    width: 100%;
    font-size: 1.1rem;
    padding: 0.8rem;
    font-weight: 600;
    color: var(--color-green-dark);
    box-sizing: border-box;
  }

  .time-controls-box {
    background: #f8f9fa;
    padding: 1.25rem;
    border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.05);
  }

  .time-row-modern {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .time-picker-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .time-picker-group label {
    margin-bottom: 0.25rem;
  }

  .time-select-modern {
    width: 100%;
    font-size: 1rem;
    padding: 0.5rem;
    font-weight: 600;
    color: var(--color-green-dark);
    border: 1px solid rgba(0,0,0,0.1);
    background: white;
    box-sizing: border-box;
  }

  .to-separator {
    font-size: 1rem;
    color: #999;
    padding-top: 1.25rem;
  }

  .duration-controls {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: white;
    border-radius: 8px;
  }

  .hint-text {
    font-size: 0.75rem;
    color: #999;
    font-weight: 600;
    text-transform: uppercase;
  }

  .duration-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
  }

  .chip {
    background: rgba(92, 64, 51, 0.05);
    border: 1px solid rgba(92, 64, 51, 0.1);
    padding: 0.4rem 0.75rem;
    border-radius: 20px;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-brown-bark);
    cursor: pointer;
    transition: all 0.2s;
  }

  .chip:hover {
    background: var(--color-green-dark);
    color: white;
    border-color: var(--color-green-dark);
  }

  .time-select-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .time-badge {
    background: white;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--color-green-dark);
    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    white-space: nowrap;
  }

  .duration-hint {
    margin-top: 1rem;
    text-align: center;
    font-size: 0.85rem;
    color: #888;
  }

  .duration-hint strong {
    color: var(--color-brown-bark);
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

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  label {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-brown-bark);
  }

  input, select {
    padding: 0.75rem;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 8px;
    font-size: 1rem;
    background: rgba(255,255,255,0.8);
  }

  input:focus, select:focus {
    outline: none;
    border-color: var(--color-green-dark);
    box-shadow: 0 0 0 2px rgba(45, 90, 39, 0.1);
  }

  .days-selector {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .day-toggle {
    flex: 1;
    height: 40px;
    border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.1);
    background: white;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .day-toggle.selected {
    background: var(--color-green-dark);
    color: white;
    border-color: var(--color-green-dark);
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .preset-btn {
    font-size: 0.75rem;
    padding: 0.35rem 0.6rem;
    background: rgba(92, 64, 51, 0.05);
    border: 1px solid rgba(92, 64, 51, 0.1);
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-brown-bark);
  }

  .modal-footer {
    display: flex;
    justify-content: space-between;
    padding: 1.5rem 2rem;
    border-top: 1px solid rgba(0,0,0,0.05);
    background: #fcfcfc;
    flex-shrink: 0;
  }

  /* Footer pegajoso en móviles: Cancelar/Guardar siempre visibles */
  @media (max-width: 640px) {
    .modal-footer {
      position: sticky;
      bottom: 0;
      z-index: 10;
      box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.08);
      background: #ffffff;
    }
  }

  .footer-right {
    display: flex;
    gap: 0.75rem;
  }

  .btn {
    padding: 0.6rem 1.2rem;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .btn-danger {
    background: #fee2e2;
    color: #dc2626;
  }

  .btn-danger:hover {
    background: #fecaca;
  }

  .btn-primary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  @media (max-width: 540px) {
    .modal-header, form, .modal-footer {
      padding: 1rem 1.25rem;
    }
    .modal-header h2 {
      font-size: 1.25rem;
    }
    .input-large {
      font-size: 1rem;
      padding: 0.65rem;
    }
    .time-controls-box {
      padding: 0.85rem;
    }
    .time-row-modern {
      gap: 0.5rem;
    }
    .time-select-modern {
      font-size: 0.9rem;
      padding: 0.4rem;
    }
    .days-selector {
      gap: 0.25rem;
    }
    .day-toggle {
      height: 36px;
      font-size: 0.8rem;
    }
    .modal-footer {
      flex-direction: column-reverse;
      gap: 0.75rem;
    }
    .footer-right {
      width: 100%;
      justify-content: space-between;
    }
    .footer-right .btn {
      flex: 1;
      justify-content: center;
    }
    .btn-danger {
      width: 100%;
      justify-content: center;
    }
    .scope-options {
      flex-direction: column;
    }
  }
</style>
